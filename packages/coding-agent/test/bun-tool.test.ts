import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.js";
import { BunRuntimeProvisioner, createBunToolDefinition } from "../src/core/tools/bun.js";

const provisioners: BunRuntimeProvisioner[] = [];
const directories: string[] = [];

describe("bun tool", () => {
	afterEach(async () => {
		await Promise.all(provisioners.splice(0).map((provisioner) => provisioner.dispose()));
		for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	});

	it("is an opt-in persistent TypeScript tool", async () => {
		const snapshotDir = mkdtempSync(join(tmpdir(), "prime-agent-bun-tool-"));
		directories.push(snapshotDir);
		const provisioner = new BunRuntimeProvisioner(process.cwd(), { snapshotDir });
		provisioners.push(provisioner);
		const tool = createBunToolDefinition(process.cwd(), { provisioner });

		expect(tool).toMatchObject({ name: "bun", executionMode: "sequential" });
		const context = {} as ExtensionContext;
		const first = await tool.execute("call-1", { code: "const answer: number = 41" }, undefined, undefined, context);
		expect(first).toMatchObject({ isError: false });
		const second = await tool.execute("call-2", { code: "answer + 1" }, undefined, undefined, context);
		expect(second).toMatchObject({
			content: [{ type: "text", text: "42" }],
			details: { status: "ok", result: "42" },
			isError: false,
		});
	});
});
