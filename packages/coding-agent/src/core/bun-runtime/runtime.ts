import type {
	ExecutionOptions,
	ExecutionRestoreResult,
	ExecutionResult,
	ExecutionRuntime,
	ExecutionRuntimeStartOptions,
	ExecutionSnapshotResult,
} from "../execution-runtime.js";
import { BunRuntimeProcess, type BunRuntimeProcessOptions } from "./process.js";

function abortedResult(started: number): ExecutionResult {
	return { stdout: "", stderr: "", status: "aborted", durationMs: Date.now() - started };
}

export class BunExecutionRuntime implements ExecutionRuntime {
	private process: BunRuntimeProcess;
	private activeAbort?: () => Promise<void>;

	constructor(private readonly options: BunRuntimeProcessOptions = {}) {
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

	async snapshotState(): Promise<ExecutionSnapshotResult | null> {
		return null;
	}

	async restoreState(): Promise<ExecutionRestoreResult | null> {
		return null;
	}
}
