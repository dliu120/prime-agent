import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BunCellEvaluator } from "../src/core/bun-runtime/evaluator.js";
import { restoreBunState, snapshotBunState } from "../src/core/bun-runtime/persistence.js";

const tempDirs: string[] = [];

function snapshotPaths(): { path: string; manifestPath: string } {
	const directory = mkdtempSync(join(tmpdir(), "prime-agent-bun-persistence-"));
	tempDirs.push(directory);
	return { path: join(directory, "state.v8"), manifestPath: join(directory, "state.json") };
}

describe("Bun runtime persistence", () => {
	afterEach(() => {
		for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
	});

	it("serializes bindings independently and skips unsupported live values", async () => {
		const evaluator = new BunCellEvaluator();
		await evaluator.execute("const data = { answer: 42 }; const liveFunction = () => 42");
		const paths = snapshotPaths();

		const snapshot = await snapshotBunState(evaluator, paths.path, paths.manifestPath);
		expect(snapshot.saved).toEqual(["data"]);
		expect(snapshot.skipped).toEqual([expect.objectContaining({ name: "liveFunction" })]);
		expect(JSON.parse(readFileSync(paths.manifestPath, "utf8"))).toMatchObject({ version: 1 });

		const restored = new BunCellEvaluator();
		await expect(restoreBunState(restored, paths.path, paths.manifestPath)).resolves.toMatchObject({
			restored: ["data"],
			failed: [],
		});
		await expect(restored.execute("data.answer")).resolves.toMatchObject({ status: "ok", result: "42" });
	});

	it("rejects a payload that does not match the manifest", async () => {
		const evaluator = new BunCellEvaluator();
		await evaluator.execute("const answer = 42");
		const paths = snapshotPaths();
		await snapshotBunState(evaluator, paths.path, paths.manifestPath);
		writeFileSync(paths.path, "corrupt");

		await expect(restoreBunState(new BunCellEvaluator(), paths.path, paths.manifestPath)).rejects.toThrow(
			"does not match its manifest",
		);
	});
});
