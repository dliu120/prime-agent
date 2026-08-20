import type {
	ExecutionHostRequestHandlers,
	ExecutionOptions,
	ExecutionRestoreResult,
	ExecutionResult,
	ExecutionRuntime,
	ExecutionRuntimeStartOptions,
	ExecutionSnapshotResult,
} from "../execution-runtime.js";
import { BunRuntimeProcess, type BunRuntimeProcessOptions } from "./process.js";

export interface BunExecutionRuntimeOptions extends BunRuntimeProcessOptions {
	snapshot?: { path: string; manifestPath: string; maxBytes?: number; maxVariableBytes?: number };
	hostHandlers?: ExecutionHostRequestHandlers;
}

function abortedResult(started: number): ExecutionResult {
	return { stdout: "", stderr: "", status: "aborted", durationMs: Date.now() - started };
}

export class BunExecutionRuntime implements ExecutionRuntime {
	private process: BunRuntimeProcess;
	private activeAbort?: () => Promise<void>;

	constructor(private readonly options: BunExecutionRuntimeOptions = {}) {
		this.process = new BunRuntimeProcess(options);
	}

	get isRunning(): boolean {
		return this.process.isRunning;
	}

	async start(options: ExecutionRuntimeStartOptions = {}): Promise<void> {
		options.onProgress?.("Starting Bun execution runtime");
		await this.process.start(options.signal);
	}

	async execute(code: string, options: ExecutionOptions = {}): Promise<ExecutionResult> {
		const started = Date.now();
		if (options.signal?.aborted) return abortedResult(started);
		let aborted = false;
		const abort = async (): Promise<void> => {
			aborted = true;
			await this.process.kill();
		};
		this.activeAbort = abort;
		const onAbort = (): void => {
			void abort();
		};
		options.signal?.addEventListener("abort", onAbort, { once: true });
		try {
			const response = await this.process.request(
				{ type: "execute", code, maxOutputChars: options.maxOutputChars },
				undefined,
				options.onStream,
				async (method, payload) => {
					const handler = this.options.hostHandlers?.[method];
					if (!handler) throw new Error(`Unknown Bun runtime host request: ${method}`);
					return handler(payload);
				},
			);
			if (response.type !== "execute_result") throw new Error("Bun runtime returned an invalid execution response");
			return response.result;
		} catch (error) {
			if (aborted) return abortedResult(started);
			throw error;
		} finally {
			options.signal?.removeEventListener("abort", onAbort);
			if (this.activeAbort === abort) this.activeAbort = undefined;
		}
	}

	async interrupt(): Promise<void> {
		await this.activeAbort?.();
	}

	async restart(): Promise<void> {
		await this.process.kill();
		this.process = new BunRuntimeProcess(this.options);
		await this.process.start();
	}

	async kill(): Promise<void> {
		await this.process.kill();
	}

	async dispose(): Promise<void> {
		await this.process.kill();
	}

	async listNamespaceNames(signal?: AbortSignal): Promise<string[] | null> {
		const response = await this.process.request({ type: "list_namespace" }, signal);
		if (response.type !== "namespace") throw new Error("Bun runtime returned an invalid namespace response");
		return response.names;
	}

	async snapshotState(signal?: AbortSignal): Promise<ExecutionSnapshotResult | null> {
		return this.captureSnapshot(false, signal);
	}

	async pruneOversizedVariables(signal?: AbortSignal): Promise<ExecutionSnapshotResult | null> {
		return this.captureSnapshot(true, signal);
	}

	private async captureSnapshot(
		pruneOversized: boolean,
		signal?: AbortSignal,
	): Promise<ExecutionSnapshotResult | null> {
		if (!this.options.snapshot) return null;
		const response = await this.process.request(
			{ type: "snapshot", ...this.options.snapshot, pruneOversized },
			signal,
		);
		if (response.type !== "snapshot_result") throw new Error("Bun runtime returned an invalid snapshot response");
		return response.result;
	}

	async restoreState(): Promise<ExecutionRestoreResult | null> {
		if (!this.options.snapshot) return null;
		const response = await this.process.request({ type: "restore", ...this.options.snapshot });
		if (response.type !== "restore_result") throw new Error("Bun runtime returned an invalid restore response");
		return response.result;
	}
}
