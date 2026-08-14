import { describe, expect, it } from "vitest";
import { transformBunCell } from "../src/core/bun-runtime/cell-transform.js";

describe("transformBunCell", () => {
	it("persists typed declarations and returns the final expression", () => {
		const result = transformBunCell("const answer: number = 42; answer");
		expect(result.declaredNames).toEqual(["answer"]);
		expect(result.code).toContain('globalThis["answer"] = answer;');
		expect(result.code).toContain("return (answer);");
	});

	it("persists every destructured binding", () => {
		const result = transformBunCell("const { one, nested: [two, ...rest] } = value;");
		expect(result.declaredNames).toEqual(["one", "two", "rest"]);
	});

	it("rewrites static imports to awaited runtime imports", () => {
		const result = transformBunCell(
			'import defaultValue, { readFile as read, type FileHandle } from "node:fs/promises"; typeof read',
		);
		expect(result.declaredNames).toEqual(["defaultValue", "read"]);
		expect(result.code).toContain('await __primeImport("node:fs/promises")');
		expect(result.code).toContain('const read = __primeModule0["readFile"]');
		expect(result.code).not.toContain("FileHandle");
	});

	it("drops type-only declarations and rejects exports", () => {
		const result = transformBunCell("interface User { name: string }\ntype Id = string\n42");
		expect(result.code).toContain("return (42)");
		expect(result.declaredNames).toEqual([]);
		expect(() => transformBunCell("export const x = 1")).toThrow("export declarations are not supported");
	});
});
