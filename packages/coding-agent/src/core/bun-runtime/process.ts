import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { v4 as uuid } from "uuid";
import { isBunBinary } from "../../config.js";
import { attachJsonlLineReader, serializeJsonLine } from "../../modes/rpc/jsonl.js";
import {
	BUN_RUNTIME_MAX_LINE_CHARS,
	BUN_RUNTIME_PROTOCOL_VERSION,
	type BunRuntimeRequest,
	type BunRuntimeResponse,
	type BunRuntimeWorkerMessage,
	decodeBunRuntimeWorkerLine,
} from "./protocol.js";

const DEFAULT_START_TIMEOUT_MS = 10_000;
const DEFAULT_STOP_TIMEOUT_MS = 2_000;
export const BUN_RUNTIME_WORKER_ROLE_ENV = "PRIME_AGENT_INTERNAL_BUN_RUNTIME_WORKER";

interface PendingRequest {
	resolve: (response: BunRuntimeResponse) => void;
	reject: (error: Error) => void;
}

export interface BunRuntimeProcessOptions {
	bunExecutable?: string;
	workerPath?: string;
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	startTimeoutMs?: number;
	stopTimeoutMs?: number;
}

export interface BunRuntimeLaunchSpec {
	command: string;
	args: string[];
	env: NodeJS.ProcessEnv;
}

function defaultWorkerPath(): string {
	const compiledPath = fileURLToPath(new URL("./worker-entry.js", import.meta.url));
	if (existsSync(compiledPath)) return compiledPath;
	return fileURLToPath(new URL("./worker-entry.ts", import.meta.url));
}

export function resolveBunRuntimeLaunchSpec(
	options: BunRuntimeProcessOptions,
	runtime: { isCompiledBunBinary?: boolean; executable?: string } = {},
): BunRuntimeLaunchSpec {
	const compiledBinary = runtime.isCompiledBunBinary ?? isBunBinary;
	const executable = runtime.executable ?? process.execPath;
	const env = { ...(options.env ?? process.env) };
	if (compiledBinary && !options.bunExecutable && !options.workerPath) {
		env[BUN_RUNTIME_WORKER_ROLE_ENV] = "1";
		return { command: executable, args: [], env };
	}
	return {
		command: options.bunExecutable ?? "bun",
		args: [options.workerPath ?? defaultWorkerPath()],
		env,
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class BunRuntimeProcess {
	private child?: ChildProcessWithoutNullStreams;
	private readyPromise?: Promise<void>;
	private resolveReady?: () => void;
	private rejectReady?: (error: Error) => void;
	private readonly pending = new Map<string, PendingRequest>();
	private stderr = "";
	private detachLineReader?: () => void;

	constructor(private readonly options: BunRuntimeProcessOptions = {}) {}

	get isRunning(): boolean {
		return this.child !== undefined && this.child.exitCode === null && this.child.signalCode === null;
	}

	async start(signal?: AbortSignal): Promise<void> {
		if (this.readyPromise) return this.awaitWithAbort(this.readyPromise, signal);
		if (signal?.aborted) throw new Error("Bun runtime startup aborted");
		this.readyPromise = this.startProcess();
		return this.awaitWithAbort(this.readyPromise, signal);
	}

	private async startProcess(): Promise<void> {
		const launch = resolveBunRuntimeLaunchSpec(this.options);
		const child = spawn(launch.command, launch.args, {
			cwd: this.options.cwd,
			env: launch.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child = child;
		this.stderr = "";
		const handshake = new Promise<void>((resolve, reject) => {
			this.resolveReady = resolve;
			this.rejectReady = reject;
		});
		this.detachLineReader = attachJsonlLineReader(child.stdout, this.handleLine, {
			maxLineLength: BUN_RUNTIME_MAX_LINE_CHARS,
			onLineOverflow: () => this.fail(new Error("Bun runtime protocol message exceeded maximum length")),
		});
		child.stderr.on("data", this.handleStderr);
		child.once("error", this.handleError);
		child.once("exit", this.handleExit);

		const timeoutMs = this.options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const timeoutPromise = new Promise<void>((_, reject) => {
			timeout = setTimeout(
				() => reject(new Error(`Bun runtime did not become ready within ${timeoutMs}ms`)),
				timeoutMs,
			);
			timeout.unref?.();
		});
		try {
			await Promise.race([handshake, timeoutPromise]);
		} catch (error) {
			await this.kill();
			throw error;
		} finally {
			if (timeout) clearTimeout(timeout);
		}
	}

	async request(request: BunRuntimeRequest, signal?: AbortSignal): Promise<BunRuntimeResponse> {
		await this.start(signal);
		const child = this.child;
		if (!child || !this.isRunning) throw new Error("Bun runtime is not running");
		const id = uuid();
		const response = new Promise<BunRuntimeResponse>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
		});
		const message = { version: BUN_RUNTIME_PROTOCOL_VERSION, type: "request" as const, id, request };
		try {
			await new Promise<void>((resolve, reject) => {
				child.stdin.write(serializeJsonLine(message), (error) => (error ? reject(error) : resolve()));
			});
		} catch (error) {
			this.pending.delete(id);
			throw error;
		}
		return this.awaitWithAbort(response, signal, () => this.pending.delete(id));
	}

	async stop(): Promise<void> {
		const child = this.child;
		if (!child) return;
		try {
			const response = await this.request({ type: "shutdown" });
			if (response.type !== "shutting_down") throw new Error("Bun runtime returned an invalid shutdown response");
		} catch {
			await this.kill();
			return;
		}
		child.stdin.end();
		await this.waitForExit(this.options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS);
	}

	async kill(): Promise<void> {
		const child = this.child;
		if (!child) return;
		if (this.isRunning) child.kill("SIGKILL");
		await this.waitForExit(this.options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS).catch(() => undefined);
		this.cleanup();
	}

	private readonly handleLine = (line: string): void => {
		const message = decodeBunRuntimeWorkerLine(line);
		if (!message) {
			this.terminateForProtocolError(new Error("Bun runtime sent an invalid protocol message"));
			return;
		}
		this.handleMessage(message);
	};

	private handleMessage(message: BunRuntimeWorkerMessage): void {
		if (message.type === "ready") {
			this.resolveReady?.();
			this.resolveReady = undefined;
			this.rejectReady = undefined;
			return;
		}
		const pending = this.pending.get(message.id);
		if (!pending) return;
		this.pending.delete(message.id);
		if (message.type === "error") pending.reject(new Error(message.error));
		else pending.resolve(message.response);
	}

	private readonly handleStderr = (chunk: Buffer): void => {
		this.stderr = `${this.stderr}${chunk.toString()}`.slice(-16_384);
	};

	private readonly handleError = (error: Error): void => this.fail(error);

	private readonly handleExit = (code: number | null, signal: NodeJS.Signals | null): void => {
		const reason = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
		const detail = this.stderr.trim();
		this.fail(new Error(`Bun runtime exited with ${reason}${detail ? `\n${detail}` : ""}`));
		this.cleanup();
	};

	private fail(error: Error): void {
		this.rejectReady?.(error);
		this.resolveReady = undefined;
		this.rejectReady = undefined;
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
	}

	private terminateForProtocolError(error: Error): void {
		this.fail(error);
		if (this.isRunning) this.child?.kill("SIGKILL");
	}

	private cleanup(): void {
		const child = this.child;
		this.detachLineReader?.();
		this.detachLineReader = undefined;
		child?.stderr.off("data", this.handleStderr);
		child?.off("error", this.handleError);
		child?.off("exit", this.handleExit);
		this.child = undefined;
		this.readyPromise = undefined;
		this.resolveReady = undefined;
		this.rejectReady = undefined;
	}

	private waitForExit(timeoutMs: number): Promise<void> {
		const child = this.child;
		if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
		return new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(
				() => reject(new Error(`Bun runtime did not exit within ${timeoutMs}ms`)),
				timeoutMs,
			);
			timeout.unref?.();
			child.once("exit", () => {
				clearTimeout(timeout);
				resolve();
			});
		});
	}

	private awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal, onAbort?: () => void): Promise<T> {
		if (!signal) return promise;
		if (signal.aborted) {
			onAbort?.();
			return Promise.reject(new Error("Bun runtime request aborted"));
		}
		return new Promise<T>((resolve, reject) => {
			const abort = () => {
				onAbort?.();
				reject(new Error("Bun runtime request aborted"));
			};
			signal.addEventListener("abort", abort, { once: true });
			promise.then(
				(value) => {
					signal.removeEventListener("abort", abort);
					resolve(value);
				},
				(error: unknown) => {
					signal.removeEventListener("abort", abort);
					reject(new Error(errorMessage(error)));
				},
			);
		});
	}
}
