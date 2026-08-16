import { inspect } from "node:util";
import vm from "node:vm";
import { createJiti } from "jiti";
import type { ExecutionAttachment, ExecutionDiff, ExecutionError, ExecutionResult } from "../execution-runtime.js";
import { transformBunCell } from "./cell-transform.js";

interface BunTranspiler {
	transformSync(code: string): string;
}

interface BunRuntimeApi {
	Transpiler: new (options: { loader: "ts"; target: "bun" }) => BunTranspiler;
}

export interface BunCellEvaluatorOptions {
	cwd?: string;
	importModule?: (specifier: string) => Promise<Record<string, unknown>>;
}

export interface BunCellExecutionOptions {
	onStream?: (chunk: string, name: "stdout" | "stderr") => void;
	maxOutputChars?: number;
	hostRequest?: (method: string, payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

function executionError(error: unknown): ExecutionError {
	if (typeof error === "object" && error !== null) {
		const candidate = error as { name?: unknown; message?: unknown; stack?: unknown };
		const name = typeof candidate.name === "string" ? candidate.name : "Error";
		const message = typeof candidate.message === "string" ? candidate.message : String(error);
		return {
			ename: name,
			evalue: message,
			traceback: typeof candidate.stack === "string" ? candidate.stack.split("\n") : [`${name}: ${message}`],
		};
	}
	return { ename: "Error", evalue: String(error), traceback: [String(error)] };
}

function bunApi(): BunRuntimeApi {
	const value = (globalThis as { Bun?: unknown }).Bun;
	if (!value || typeof value !== "object" || !("Transpiler" in value)) {
		throw new Error("The TypeScript execution runtime requires Bun");
	}
	return value as BunRuntimeApi;
}

export class BunCellEvaluator {
	private readonly context: vm.Context;
	private readonly transpiler = new (bunApi().Transpiler)({ loader: "ts", target: "bun" });
	private readonly namespaceNames = new Set<string>();
	private onStream?: (chunk: string, name: "stdout" | "stderr") => void;
	private maxOutputChars = 65_536;
	private stdout = "";
	private stderr = "";
	private diffs: ExecutionDiff[] = [];
	private attachments: ExecutionAttachment[] = [];
	private hostRequest?: (method: string, payload: Record<string, unknown>) => Promise<Record<string, unknown>>;

	constructor(options: BunCellEvaluatorOptions = {}) {
		const jiti = createJiti(options.cwd ?? process.cwd());
		const importModule =
			options.importModule ??
			(async (specifier: string): Promise<Record<string, unknown>> => {
				const imported: unknown = await jiti.import(specifier);
				if (typeof imported !== "object" || imported === null) {
					throw new Error(`Imported module ${specifier} did not provide a module namespace`);
				}
				return imported as Record<string, unknown>;
			});
		const write = (name: "stdout" | "stderr", values: unknown[]) => {
			const chunk = `${values.map((value) => (typeof value === "string" ? value : inspect(value, { colors: false }))).join(" ")}\n`;
			if (name === "stdout") this.stdout = `${this.stdout}${chunk}`.slice(0, this.maxOutputChars);
			else this.stderr = `${this.stderr}${chunk}`.slice(0, this.maxOutputChars);
			this.onStream?.(chunk, name);
		};
		this.context = vm.createContext({
			Bun: bunApi(),
			__primeImport: importModule,
			console: {
				log: (...values: unknown[]) => write("stdout", values),
				info: (...values: unknown[]) => write("stdout", values),
				warn: (...values: unknown[]) => write("stderr", values),
				error: (...values: unknown[]) => write("stderr", values),
			},
			prime: {
				hostRequest: (method: string, payload: Record<string, unknown>) => {
					if (!this.hostRequest) throw new Error("No Bun runtime host request handler is configured");
					return this.hostRequest(method, payload);
				},
				displayDiff: (diff: ExecutionDiff) => this.diffs.push(diff),
				attach: (attachment: ExecutionAttachment) => this.attachments.push(attachment),
			},
			Buffer,
			setTimeout,
			clearTimeout,
			setInterval,
			clearInterval,
			URL,
			URLSearchParams,
			TextEncoder,
			TextDecoder,
		});
	}

	async execute(code: string, options: BunCellExecutionOptions = {}): Promise<ExecutionResult> {
		const started = Date.now();
		this.onStream = options.onStream;
		this.hostRequest = options.hostRequest;
		this.maxOutputChars = options.maxOutputChars ?? 65_536;
		this.stdout = "";
		this.stderr = "";
		this.diffs = [];
		this.attachments = [];
		try {
			const transformed = transformBunCell(code);
			const javascript = this.transpiler.transformSync(`(async () => {\n${transformed.code}\n})()`);
			const script = new vm.Script(javascript, { filename: "prime-agent-cell.ts" });
			const value: unknown = await script.runInContext(this.context);
			for (const name of transformed.declaredNames) this.namespaceNames.add(name);
			return {
				stdout: this.stdout,
				stderr: this.stderr,
				result: value === undefined ? undefined : inspect(value, { colors: false, depth: 6 }),
				diffs: this.diffs.length > 0 ? this.diffs : undefined,
				attachments: this.attachments.length > 0 ? this.attachments : undefined,
				status: "ok",
				durationMs: Date.now() - started,
			};
		} catch (error) {
			return {
				stdout: this.stdout,
				stderr: this.stderr,
				diffs: this.diffs.length > 0 ? this.diffs : undefined,
				attachments: this.attachments.length > 0 ? this.attachments : undefined,
				status: "error",
				error: executionError(error),
				durationMs: Date.now() - started,
			};
		}
	}

	listNamespaceNames(): string[] {
		return [...this.namespaceNames].sort();
	}

	getNamespaceValue(name: string): unknown {
		if (!this.namespaceNames.has(name)) throw new Error(`Unknown Bun runtime binding: ${name}`);
		return Reflect.get(this.context, name);
	}

	setNamespaceValue(name: string, value: unknown): void {
		Reflect.set(this.context, name, value);
		this.namespaceNames.add(name);
	}
}
