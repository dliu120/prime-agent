import { expect, it } from "vitest";
import type { ExecutionHostRequestHandlers, ExecutionRuntime } from "../src/core/execution-runtime.js";

export interface ExecutionRuntimeContractFixture {
	createRuntime(options?: { persistence?: boolean; hostHandlers?: ExecutionHostRequestHandlers }): ExecutionRuntime;
	state: {
		assign: string;
		read: string;
		name: string;
	};
	stream: string;
	result: string;
	error: string;
	longRunning: string;
	richOutput?: string;
	hostRequest?: string;
	persist?: {
		assign: string;
		read: string;
		name: string;
	};
}

/** Shared behavioral suite for every model-facing execution runtime. */
export function registerExecutionRuntimeContract(fixture: ExecutionRuntimeContractFixture): void {
	const richOutput = fixture.richOutput;
	const hostRequest = fixture.hostRequest;
	const persist = fixture.persist;
	it("starts lazily and preserves state across sequential cells", async () => {
		const runtime = fixture.createRuntime();
		try {
			expect(runtime.isRunning).toBe(false);
			await runtime.execute(fixture.state.assign);
			expect(runtime.isRunning).toBe(true);
			const result = await runtime.execute(fixture.state.read);
			expect(result).toMatchObject({ status: "ok", result: "42" });
		} finally {
			await runtime.dispose();
		}
	});

	it("streams output and returns the final expression separately", async () => {
		const runtime = fixture.createRuntime();
		const streamed: Array<{ chunk: string; name: "stdout" | "stderr" }> = [];
		try {
			const output = await runtime.execute(fixture.stream, {
				onStream: (chunk, name) => streamed.push({ chunk, name }),
			});
			expect(output.status).toBe("ok");
			expect(output.stdout).toContain("out");
			expect(output.stderr).toContain("err");
			expect(streamed).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ chunk: expect.stringContaining("out"), name: "stdout" }),
					expect.objectContaining({ chunk: expect.stringContaining("err"), name: "stderr" }),
				]),
			);
			const result = await runtime.execute(fixture.result);
			expect(result.result).toBe("42");
		} finally {
			await runtime.dispose();
		}
	});

	(richOutput ? it : it.skip)("returns structured diffs and attachments", async () => {
		if (!richOutput) return;
		const runtime = fixture.createRuntime();
		try {
			const output = await runtime.execute(richOutput);
			expect(output).toMatchObject({
				status: "ok",
				diffs: [{ path: "contract.txt", oldStr: "before", newStr: "after", startLine: 4 }],
				attachments: [{ mimeType: "image/png", data: "aW1hZ2U=", path: "contract.png" }],
			});
		} finally {
			await runtime.dispose();
		}
	});

	(hostRequest ? it : it.skip)("dispatches typed host requests while a cell is active", async () => {
		if (!hostRequest) return;
		const hostHandlers: ExecutionHostRequestHandlers = {
			"contract.echo": async (payload) => ({ echoed: payload.value }),
		};
		const runtime = fixture.createRuntime({ hostHandlers });
		try {
			await expect(runtime.execute(hostRequest)).resolves.toMatchObject({ status: "ok", result: "42" });
		} finally {
			await runtime.dispose();
		}
	});

	it("reports execution errors without killing the runtime", async () => {
		const runtime = fixture.createRuntime();
		try {
			const failure = await runtime.execute(fixture.error);
			expect(failure.status).toBe("error");
			expect(failure.error?.evalue).toBeTruthy();
			await expect(runtime.execute(fixture.result)).resolves.toMatchObject({ status: "ok", result: "42" });
		} finally {
			await runtime.dispose();
		}
	});

	it("interrupts an active execution and remains restartable", async () => {
		const runtime = fixture.createRuntime();
		const controller = new AbortController();
		try {
			await runtime.start();
			const execution = runtime.execute(fixture.longRunning, { signal: controller.signal });
			await new Promise((resolve) => setTimeout(resolve, 100));
			controller.abort();
			await expect(execution).resolves.toMatchObject({ status: "aborted" });
			await runtime.restart();
			await expect(runtime.execute(fixture.result)).resolves.toMatchObject({ status: "ok", result: "42" });
		} finally {
			await runtime.dispose();
		}
	}, 30_000);

	it("lists user state and clears it on restart", async () => {
		const runtime = fixture.createRuntime();
		try {
			await runtime.execute(fixture.state.assign);
			expect(await runtime.listNamespaceNames()).toContain(fixture.state.name);
			await runtime.restart();
			expect(await runtime.listNamespaceNames()).not.toContain(fixture.state.name);
		} finally {
			await runtime.dispose();
		}
	});

	(persist ? it : it.skip)(
		"snapshots serializable state and restores it into a fresh runtime",
		async () => {
			if (!persist) return;
			const writer = fixture.createRuntime({ persistence: true });
			try {
				await writer.execute(persist.assign);
				const snapshot = await writer.snapshotState();
				expect(snapshot?.saved).toContain(persist.name);
			} finally {
				await writer.dispose();
			}

			const reader = fixture.createRuntime({ persistence: true });
			try {
				const restore = await reader.restoreState();
				expect(restore?.restored).toContain(persist.name);
				await expect(reader.execute(persist.read)).resolves.toMatchObject({ status: "ok", result: "42" });
			} finally {
				await reader.dispose();
			}
		},
		30_000,
	);
}
