import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	BUN_RUNTIME_WORKER_ROLE_ENV,
	BunRuntimeProcess,
	resolveBunRuntimeLaunchSpec,
} from "../src/core/bun-runtime/process.js";

const workerPath = fileURLToPath(new URL("../src/core/bun-runtime/worker-entry.ts", import.meta.url));
const invalidWorkerPath = fileURLToPath(new URL("./fixtures/bun-runtime/invalid-worker.ts", import.meta.url));
const silentWorkerPath = fileURLToPath(new URL("./fixtures/bun-runtime/silent-worker.ts", import.meta.url));
const exitWorkerPath = fileURLToPath(new URL("./fixtures/bun-runtime/exit-worker.ts", import.meta.url));
const delayedWorkerPath = fileURLToPath(new URL("./fixtures/bun-runtime/delayed-worker.ts", import.meta.url));
const processes: BunRuntimeProcess[] = [];

function createProcess(): BunRuntimeProcess {
	const runtime = new BunRuntimeProcess({ workerPath });
	processes.push(runtime);
	return runtime;
}

describe("BunRuntimeProcess", () => {
	afterEach(async () => {
		await Promise.all(processes.splice(0).map((runtime) => runtime.kill()));
	});

	it("starts an isolated Bun subprocess and correlates requests", async () => {
		const runtime = createProcess();
		expect(runtime.isRunning).toBe(false);

		await expect(runtime.request({ type: "ping" })).resolves.toEqual({ type: "pong" });
		expect(runtime.isRunning).toBe(true);
		await expect(runtime.request({ type: "ping" })).resolves.toEqual({ type: "pong" });
	});

	it("executes TypeScript with top-level await and persistent state", async () => {
		const runtime = createProcess();
		await expect(
			runtime.request({ type: "execute", code: "const answer: number = await Promise.resolve(41)" }),
		).resolves.toMatchObject({ type: "execute_result", result: { status: "ok" } });
		await expect(runtime.request({ type: "execute", code: "answer + 1" })).resolves.toMatchObject({
			type: "execute_result",
			result: { status: "ok", result: "42" },
		});
	});

	it("correlates streamed output with its execution", async () => {
		const runtime = createProcess();
		const chunks: Array<{ chunk: string; name: "stdout" | "stderr" }> = [];
		const response = await runtime.request(
			{ type: "execute", code: 'console.log("out"); console.error("err"); 42' },
			undefined,
			(chunk, name) => chunks.push({ chunk, name }),
		);

		expect(chunks).toEqual([
			{ chunk: "out\n", name: "stdout" },
			{ chunk: "err\n", name: "stderr" },
		]);
		expect(response).toMatchObject({
			type: "execute_result",
			result: { status: "ok", stdout: "out\n", stderr: "err\n", result: "42" },
		});
	});

	it("serializes concurrent executions", async () => {
		const runtime = createProcess();
		const first = runtime.request({
			type: "execute",
			code: "await new Promise((resolve) => setTimeout(resolve, 25)); const sequence: number[] = [1]",
		});
		const second = runtime.request({ type: "execute", code: "sequence.push(2); sequence" });

		await expect(first).resolves.toMatchObject({ type: "execute_result", result: { status: "ok" } });
		await expect(second).resolves.toMatchObject({
			type: "execute_result",
			result: { status: "ok", result: "[ 1, 2 ]" },
		});
	});

	it("returns execution errors without killing or poisoning the worker", async () => {
		const runtime = createProcess();
		await expect(runtime.request({ type: "execute", code: 'throw new Error("failed")' })).resolves.toMatchObject({
			type: "execute_result",
			result: { status: "error", error: { ename: "Error", evalue: "failed" } },
		});
		await expect(runtime.request({ type: "execute", code: "40 + 2" })).resolves.toMatchObject({
			type: "execute_result",
			result: { status: "ok", result: "42" },
		});
	});

	it("shuts down gracefully and can start again", async () => {
		const runtime = createProcess();
		await runtime.start();
		await runtime.stop();
		expect(runtime.isRunning).toBe(false);
		await expect(runtime.request({ type: "ping" })).resolves.toEqual({ type: "pong" });
	});

	it("does not cancel shared startup when one waiting caller aborts", async () => {
		const runtime = new BunRuntimeProcess({ workerPath: delayedWorkerPath });
		processes.push(runtime);
		const controller = new AbortController();
		const firstStart = runtime.start(controller.signal);
		const secondStart = runtime.start();
		controller.abort();

		await expect(firstStart).rejects.toThrow("request aborted");
		await expect(secondStart).resolves.toBeUndefined();
		expect(runtime.isRunning).toBe(true);
	});

	it("rejects startup when Bun cannot be launched", async () => {
		const runtime = new BunRuntimeProcess({
			bunExecutable: "/missing/prime-agent-bun",
			workerPath,
			startTimeoutMs: 100,
		});
		processes.push(runtime);
		await expect(runtime.start()).rejects.toThrow(/ENOENT|spawn/);
		expect(runtime.isRunning).toBe(false);
	});

	it("times out and kills a worker that never completes the handshake", async () => {
		const runtime = new BunRuntimeProcess({ workerPath: silentWorkerPath, startTimeoutMs: 50 });
		processes.push(runtime);
		await expect(runtime.start()).rejects.toThrow("did not become ready");
		expect(runtime.isRunning).toBe(false);
	});

	it("kills a worker that violates the protocol", async () => {
		const runtime = new BunRuntimeProcess({ workerPath: invalidWorkerPath });
		processes.push(runtime);
		await expect(runtime.start()).rejects.toThrow("invalid protocol message");
		expect(runtime.isRunning).toBe(false);
	});

	it("rejects an in-flight request when the worker exits unexpectedly", async () => {
		const runtime = new BunRuntimeProcess({ workerPath: exitWorkerPath });
		processes.push(runtime);
		await expect(runtime.request({ type: "ping" })).rejects.toThrow("exit code 23");
		expect(runtime.isRunning).toBe(false);
	});

	it("uses a self-spawn role for compiled Bun binaries", () => {
		const launch = resolveBunRuntimeLaunchSpec(
			{ env: { PRESERVED: "yes" } },
			{ isCompiledBunBinary: true, executable: "/opt/prime-agent" },
		);
		expect(launch).toEqual({
			command: "/opt/prime-agent",
			args: [],
			env: { PRESERVED: "yes", [BUN_RUNTIME_WORKER_ROLE_ENV]: "1" },
		});
	});
});
