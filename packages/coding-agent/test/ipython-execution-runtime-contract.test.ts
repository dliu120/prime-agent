import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe } from "vitest";
import { KernelManager } from "../src/core/kernel/index.js";
import { registerExecutionRuntimeContract } from "./execution-runtime-contract.js";

function resolveKernelPython(): string | null {
	const candidates = [
		process.env.PRIME_AGENT_KERNEL_PYTHON,
		join(homedir(), ".prime", "agent", "kernel-venv", "bin", "python"),
	].filter((candidate): candidate is string => Boolean(candidate));
	for (const candidate of candidates) {
		if (!existsSync(candidate)) continue;
		if (spawnSync(candidate, ["-c", "import ipykernel, dill, rlm"]).status === 0) return candidate;
	}
	return null;
}

const python = resolveKernelPython();
const describeIfKernel = python ? describe : describe.skip;

describeIfKernel("IPython execution runtime contract", { tags: ["kernel-heavy"] }, () => {
	let tempDir = "";
	let snapshotPath = "";
	let manifestPath = "";

	beforeAll(() => {
		tempDir = mkdtempSync(join(tmpdir(), "prime-agent-runtime-contract-"));
		snapshotPath = join(tempDir, "state.dill");
		manifestPath = join(tempDir, "state.json");
	});

	afterAll(() => {
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	});

	registerExecutionRuntimeContract({
		createRuntime: ({ persistence = false, hostHandlers } = {}) =>
			new KernelManager({
				python: python as string,
				cwd: tempDir,
				snapshot: persistence ? { path: snapshotPath, manifestPath } : undefined,
				hostHandlers,
			}),
		state: { assign: "answer = 42", read: "answer", name: "answer" },
		stream: "import sys\nprint('out')\nprint('err', file=sys.stderr)",
		result: "40 + 2",
		error: "raise RuntimeError('contract failure')",
		longRunning: "while True:\n    pass",
		richOutput: [
			"from IPython.display import display",
			"display({'application/vnd.prime-agent.diff+json': {'path': 'contract.txt', 'old_str': 'before', 'new_str': 'after', 'start_line': 4}}, raw=True)",
			"display({'application/vnd.prime-agent.attachment+json': {'mime_type': 'image/png', 'data': 'aW1hZ2U=', 'path': 'contract.png'}}, raw=True)",
		].join("\n"),
		hostRequest: "from rlm import host_request\n(await host_request('contract.echo', {'value': 42}))['echoed']",
		persist: { assign: "persisted_answer = 42", read: "persisted_answer", name: "persisted_answer" },
	});
});
