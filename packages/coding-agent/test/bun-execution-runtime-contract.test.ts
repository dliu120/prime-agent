import { fileURLToPath } from "node:url";
import { describe } from "vitest";
import { BunExecutionRuntime } from "../src/core/bun-runtime/runtime.js";
import { registerExecutionRuntimeContract } from "./execution-runtime-contract.js";

const workerPath = fileURLToPath(new URL("../src/core/bun-runtime/worker-entry.ts", import.meta.url));

describe("Bun execution runtime contract", () => {
	registerExecutionRuntimeContract({
		createRuntime: () => new BunExecutionRuntime({ workerPath }),
		state: { assign: "const answer: number = 42", read: "answer", name: "answer" },
		stream: 'console.log("out"); console.error("err")',
		result: "40 + 2",
		error: 'throw new Error("contract failure")',
		longRunning: "while (true) { await new Promise((resolve) => setTimeout(resolve, 10)) }",
	});
});
