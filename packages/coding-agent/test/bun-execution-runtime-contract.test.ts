import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe } from "vitest";
import { BunExecutionRuntime } from "../src/core/bun-runtime/runtime.js";
import { registerExecutionRuntimeContract } from "./execution-runtime-contract.js";

const workerPath = fileURLToPath(new URL("../src/core/bun-runtime/worker-entry.ts", import.meta.url));

describe("Bun execution runtime contract", () => {
	let tempDir = "";
	let snapshotPath = "";
	let manifestPath = "";

	beforeAll(() => {
		tempDir = mkdtempSync(join(tmpdir(), "prime-agent-bun-runtime-contract-"));
		snapshotPath = join(tempDir, "state.v8");
		manifestPath = join(tempDir, "state.json");
	});

	afterAll(() => {
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	});

	registerExecutionRuntimeContract({
		createRuntime: ({ persistence = false } = {}) =>
			new BunExecutionRuntime({
				workerPath,
				snapshot: persistence ? { path: snapshotPath, manifestPath } : undefined,
			}),
		state: { assign: "const answer: number = 42", read: "answer", name: "answer" },
		stream: 'console.log("out"); console.error("err")',
		result: "40 + 2",
		error: 'throw new Error("contract failure")',
		longRunning: "while (true) { await new Promise((resolve) => setTimeout(resolve, 10)) }",
		persist: {
			assign: "const persistedAnswer = { value: 42 }",
			read: "persistedAnswer.value",
			name: "persistedAnswer",
		},
	});
});
