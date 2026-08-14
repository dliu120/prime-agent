export const BUN_RUNTIME_PROTOCOL_VERSION = 1;
export const BUN_RUNTIME_MAX_LINE_CHARS = 16 * 1024 * 1024;

export interface BunRuntimeReadyMessage {
	version: typeof BUN_RUNTIME_PROTOCOL_VERSION;
	type: "ready";
	bunVersion: string;
}

export interface BunRuntimeRequestMessage {
	version: typeof BUN_RUNTIME_PROTOCOL_VERSION;
	type: "request";
	id: string;
	request: BunRuntimeRequest;
}

export interface BunRuntimeResponseMessage {
	version: typeof BUN_RUNTIME_PROTOCOL_VERSION;
	type: "response";
	id: string;
	response: BunRuntimeResponse;
}

export interface BunRuntimeErrorMessage {
	version: typeof BUN_RUNTIME_PROTOCOL_VERSION;
	type: "error";
	id: string;
	error: string;
}

export interface BunRuntimeStreamMessage {
	version: typeof BUN_RUNTIME_PROTOCOL_VERSION;
	type: "stream";
	id: string;
	name: "stdout" | "stderr";
	chunk: string;
}

export type BunRuntimeHostMessage = BunRuntimeRequestMessage;
export type BunRuntimeWorkerMessage =
	| BunRuntimeReadyMessage
	| BunRuntimeResponseMessage
	| BunRuntimeErrorMessage
	| BunRuntimeStreamMessage;

export type BunRuntimeRequest =
	| { type: "ping" }
	| { type: "shutdown" }
	| { type: "list_namespace" }
	| { type: "execute"; code: string; maxOutputChars?: number };
export type BunRuntimeResponse =
	| { type: "pong" }
	| { type: "shutting_down" }
	| { type: "namespace"; names: string[] }
	| { type: "execute_result"; result: BunRuntimeExecutionResult };

export interface BunRuntimeExecutionResult {
	stdout: string;
	stderr: string;
	result?: string;
	status: "ok" | "error" | "aborted";
	error?: { ename: string; evalue: string; traceback: string[] };
	durationMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasProtocolEnvelope(value: unknown): value is Record<string, unknown> & { type: string } {
	return isRecord(value) && value.version === BUN_RUNTIME_PROTOCOL_VERSION && typeof value.type === "string";
}

function isRequest(value: unknown): value is BunRuntimeRequest {
	if (!isRecord(value)) return false;
	if (value.type === "ping" || value.type === "shutdown" || value.type === "list_namespace") return true;
	return (
		value.type === "execute" &&
		typeof value.code === "string" &&
		(value.maxOutputChars === undefined ||
			(Number.isSafeInteger(value.maxOutputChars) && (value.maxOutputChars as number) > 0))
	);
}

function isResponse(value: unknown): value is BunRuntimeResponse {
	if (!isRecord(value)) return false;
	if (value.type === "pong" || value.type === "shutting_down") return true;
	if (value.type === "namespace") return isStringArray(value.names);
	return value.type === "execute_result" && isExecutionResult(value.result);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isExecutionResult(value: unknown): value is BunRuntimeExecutionResult {
	if (!isRecord(value)) return false;
	if (typeof value.stdout !== "string" || typeof value.stderr !== "string") return false;
	if (value.result !== undefined && typeof value.result !== "string") return false;
	if (value.status !== "ok" && value.status !== "error" && value.status !== "aborted") return false;
	if (typeof value.durationMs !== "number" || !Number.isFinite(value.durationMs) || value.durationMs < 0) return false;
	if (value.error === undefined) return true;
	return (
		isRecord(value.error) &&
		typeof value.error.ename === "string" &&
		typeof value.error.evalue === "string" &&
		isStringArray(value.error.traceback)
	);
}

export function parseBunRuntimeHostMessage(value: unknown): BunRuntimeHostMessage | null {
	if (!hasProtocolEnvelope(value) || value.type !== "request" || typeof value.id !== "string" || !value.id) {
		return null;
	}
	if (!isRequest(value.request)) return null;
	return {
		version: BUN_RUNTIME_PROTOCOL_VERSION,
		type: "request",
		id: value.id,
		request: value.request,
	};
}

export function parseBunRuntimeWorkerMessage(value: unknown): BunRuntimeWorkerMessage | null {
	if (!hasProtocolEnvelope(value)) return null;
	if (value.type === "ready") {
		if (typeof value.bunVersion !== "string" || !value.bunVersion) return null;
		return { version: BUN_RUNTIME_PROTOCOL_VERSION, type: "ready", bunVersion: value.bunVersion };
	}
	if (typeof value.id !== "string" || !value.id) return null;
	if (
		value.type === "stream" &&
		(value.name === "stdout" || value.name === "stderr") &&
		typeof value.chunk === "string"
	) {
		return {
			version: BUN_RUNTIME_PROTOCOL_VERSION,
			type: "stream",
			id: value.id,
			name: value.name,
			chunk: value.chunk,
		};
	}
	if (value.type === "response" && isResponse(value.response)) {
		return {
			version: BUN_RUNTIME_PROTOCOL_VERSION,
			type: "response",
			id: value.id,
			response: value.response,
		};
	}
	if (value.type === "error" && typeof value.error === "string" && value.error) {
		return { version: BUN_RUNTIME_PROTOCOL_VERSION, type: "error", id: value.id, error: value.error };
	}
	return null;
}

export function decodeBunRuntimeHostLine(line: string): BunRuntimeHostMessage | null {
	try {
		return parseBunRuntimeHostMessage(JSON.parse(line));
	} catch {
		return null;
	}
}

export function decodeBunRuntimeWorkerLine(line: string): BunRuntimeWorkerMessage | null {
	try {
		return parseBunRuntimeWorkerMessage(JSON.parse(line));
	} catch {
		return null;
	}
}

export function encodeBunRuntimeMessage(message: BunRuntimeHostMessage | BunRuntimeWorkerMessage): string {
	return `${JSON.stringify(message)}\n`;
}
