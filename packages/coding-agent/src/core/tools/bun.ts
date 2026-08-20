import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { BunExecutionRuntime, type BunExecutionRuntimeOptions } from "../bun-runtime/runtime.js";
import type { ExecutionHostRequestHandlers, ExecutionResult } from "../execution-runtime.js";
import type { ToolDefinition } from "../extensions/types.js";
import type { TypeScriptSkillRuntimeInfo } from "../skills.js";
import { imageBlocksFromAttachments } from "./ipython.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

const bunSchema = Type.Object({
	code: Type.String({
		description: "TypeScript scratchpad code to execute in a persistent, isolated Bun runtime.",
	}),
});

export type BunToolInput = Static<typeof bunSchema>;
export type BunToolDetails = ExecutionResult;

export interface BunToolOptions {
	hostHandlers?: ExecutionHostRequestHandlers;
	snapshotDir?: string;
	snapshotMaxBytes?: number;
	snapshotMaxVariableBytes?: number;
	readyGate?: Promise<unknown>;
	typescriptSkills?: readonly TypeScriptSkillRuntimeInfo[];
	provisioner?: BunRuntimeProvisioner;
}

function snapshotPaths(directory: string): { path: string; manifestPath: string } {
	return { path: join(directory, "bun-state.v8"), manifestPath: join(directory, "bun-state.json") };
}

export class BunRuntimeProvisioner {
	private runtime?: BunExecutionRuntime;
	private restored = false;
	private bootstrapped = false;

	constructor(
		private readonly cwd: string,
		private readonly options: Omit<BunToolOptions, "provisioner"> = {},
	) {}

	private createRuntime(): BunExecutionRuntime {
		const runtimeOptions: BunExecutionRuntimeOptions = {
			cwd: this.cwd,
			hostHandlers: this.options.hostHandlers,
			snapshot: this.options.snapshotDir
				? {
						...snapshotPaths(this.options.snapshotDir),
						maxBytes: this.options.snapshotMaxBytes,
						maxVariableBytes: this.options.snapshotMaxVariableBytes,
					}
				: undefined,
		};
		return new BunExecutionRuntime(runtimeOptions);
	}

	async ensure(onProgress?: (message: string) => void, signal?: AbortSignal): Promise<BunExecutionRuntime> {
		await this.options.readyGate?.catch(() => undefined);
		const runtime = this.runtime ?? this.createRuntime();
		this.runtime = runtime;
		await runtime.start({ onProgress, signal });
		if (!this.restored && this.options.snapshotDir) {
			this.restored = true;
			const paths = snapshotPaths(this.options.snapshotDir);
			if (existsSync(paths.path) && existsSync(paths.manifestPath)) await runtime.restoreState();
		}
		if (!this.bootstrapped) {
			this.bootstrapped = true;
			for (const skill of this.options.typescriptSkills ?? []) {
				const code = `import * as ${skill.importName} from ${JSON.stringify(skill.entryPath)}`;
				const result = await runtime.execute(code, { signal });
				if (result.status !== "ok") {
					throw new Error(
						`Failed to load TypeScript skill ${skill.name}: ${result.error?.evalue ?? result.stderr}`,
					);
				}
			}
		}
		return runtime;
	}

	get hasRunningRuntime(): boolean {
		return this.runtime?.isRunning ?? false;
	}

	async pruneOversizedVariables(signal?: AbortSignal): Promise<string[] | null> {
		const result = await this.runtime?.pruneOversizedVariables(signal);
		return result ? (result.pruned ?? []) : null;
	}

	async listNamespaceNames(signal?: AbortSignal): Promise<string[] | null> {
		return (await this.runtime?.listNamespaceNames(signal)) ?? null;
	}

	async execute(
		code: string,
		signal?: AbortSignal,
		onStream?: (chunk: string, name: "stdout" | "stderr") => void,
	): Promise<ExecutionResult> {
		const runtime = await this.ensure(undefined, signal);
		const result = await runtime.execute(code, { signal, onStream });
		if (result.status === "ok" && this.options.snapshotDir) await runtime.snapshotState();
		return result;
	}

	async dispose(): Promise<void> {
		if (!this.runtime) return;
		if (this.options.snapshotDir && this.runtime.isRunning) await this.runtime.snapshotState().catch(() => null);
		await this.runtime.dispose();
		this.runtime = undefined;
		this.restored = false;
		this.bootstrapped = false;
	}
}

export function createBunToolDefinition(
	cwd: string,
	options?: BunToolOptions,
): ToolDefinition<typeof bunSchema, BunToolDetails> {
	const provisioner = options?.provisioner ?? new BunRuntimeProvisioner(cwd, options);
	return {
		name: "bun",
		label: "bun",
		description:
			"Execute TypeScript in a persistent isolated Bun runtime. Declarations and imports persist across calls; serializable state is restored best-effort when a session resumes.",
		promptSnippet: "bun - persistent TypeScript notebook and Bun shell/process APIs",
		executionMode: "sequential",
		parameters: bunSchema,
		execute: async (_toolCallId, params, signal, onUpdate) => {
			const result = await provisioner.execute(params.code, signal, (chunk) => {
				onUpdate?.({ content: [{ type: "text", text: chunk }], details: { ...resultPlaceholder, status: "ok" } });
			});
			let text = result.stdout;
			if (result.stderr) text += `${text ? "\n" : ""}${result.stderr}`;
			if (result.result) text += `${text ? "\n" : ""}${result.result}`;
			if (result.status === "error" && result.error)
				text += `${text ? "\n" : ""}${result.error.traceback.join("\n")}`;
			const imageBlocks = imageBlocksFromAttachments(result.attachments);
			const content: Array<TextContent | ImageContent> = [{ type: "text", text }, ...imageBlocks];
			return { content, details: result, isError: result.status !== "ok" };
		},
	};
}

const resultPlaceholder: ExecutionResult = { stdout: "", stderr: "", status: "ok", durationMs: 0 };

export function createBunTool(cwd: string, options?: BunToolOptions): AgentTool<typeof bunSchema> {
	return wrapToolDefinition(createBunToolDefinition(cwd, options));
}
