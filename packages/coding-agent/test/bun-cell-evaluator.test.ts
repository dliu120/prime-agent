import { describe, expect, it } from "vitest";
import { BunCellEvaluator } from "../src/core/bun-runtime/evaluator.js";

describe("BunCellEvaluator", () => {
	it("executes TypeScript and preserves declarations across cells", async () => {
		const evaluator = new BunCellEvaluator();
		expect(await evaluator.execute("const answer: number = 41")).toMatchObject({ status: "ok" });
		expect(await evaluator.execute("answer + 1")).toMatchObject({ status: "ok", result: "42" });
		expect(evaluator.listNamespaceNames()).toEqual(["answer"]);
	});

	it("supports top-level await, functions, classes, and redeclaration", async () => {
		const evaluator = new BunCellEvaluator();
		await evaluator.execute("function double(value: number): number { return value * 2 }");
		await evaluator.execute("class Box { constructor(public value: number) {} }");
		expect(await evaluator.execute("await Promise.resolve(double(new Box(21).value))")).toMatchObject({
			status: "ok",
			result: "42",
		});
		await evaluator.execute("const double: number = 42");
		expect(await evaluator.execute("double")).toMatchObject({ status: "ok", result: "42" });
	});

	it("loads static imports through the injected importer", async () => {
		const evaluator = new BunCellEvaluator({
			importModule: async (specifier) => {
				expect(specifier).toBe("contract-module");
				return { value: 42 };
			},
		});
		expect(await evaluator.execute('import { value as answer } from "contract-module"; answer')).toMatchObject({
			status: "ok",
			result: "42",
		});
		expect(evaluator.listNamespaceNames()).toEqual(["answer"]);
	});

	it("returns structured errors and remains usable", async () => {
		const evaluator = new BunCellEvaluator();
		expect(await evaluator.execute("throw new Error('failed')")).toMatchObject({
			status: "error",
			error: { ename: "Error", evalue: "failed" },
		});
		expect(await evaluator.execute("40 + 2")).toMatchObject({ status: "ok", result: "42" });
	});

	it("exposes Bun APIs without exposing the host process", async () => {
		const evaluator = new BunCellEvaluator();
		await expect(evaluator.execute("[typeof Bun.version, typeof process]")).resolves.toMatchObject({
			status: "ok",
			result: "[ 'string', 'undefined' ]",
		});
	});
});
