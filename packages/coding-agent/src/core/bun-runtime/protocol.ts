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

export interface BunRuntimeHostResponseMessage {
	version: typeof BUN_RUNTIME_PROTOCOL_VERSION;
	type: "host_response";
	id: string;
	requestId: string;
	result?: Record<string, unknown>;
	error?: string;
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

export interface BunRuntimeHostRequestMessage {
	version: typeof BUN_RUNTIME_PROTOCOL_VERSION;
	type: "host_request";
	id: string;
	requestId: string;
	method: string;
	payload: Record<string, unknown>;
}

export type BunRuntimeHostMessage = BunRuntimeRequestMessage | BunRuntimeHostResponseMessage;
export type BunRuntimeWorkerMessage =
	| BunRuntimeReadyMessage
	| BunRuntimeResponseMessage
	| BunRuntimeErrorMessage
	| BunRuntimeStreamMessage
	| BunRuntimeHostRequestMessage;

export type BunRuntimeRequest =
	| { type: "ping" }
	| { type: "shutdown" }
	| { type: "list_namespace" }
	| {
			type: "snapshot";
			path: string;
			manifestPath: string;
			maxBytes?: number;
			maxVariableBytes?: number;
			pruneOversized?: boolean;
	  }
	| { type: "restore"; path: string; manifestPath: string }
	| { type: "execute"; code: string; maxOutputChars?: number };
export type BunRuntimeResponse =
	| { type: "pong" }
	| { type: "shutting_down" }
	| { type: "namespace"; names: string[] }
	| { type: "snapshot_result"; result: BunRuntimeSnapshotResult }
	| { type: "restore_result"; result: BunRuntimeRestoreResult }
	| { type: "execute_result"; result: BunRuntimeExecutionResult };

export interface BunRuntimeSnapshotResult {
	saved: string[];
	skipped: Array<{ name: string; reason: string }>;
	pruned?: string[];
	bytes: number;
	path: string;
}

export interface BunRuntimeRestoreResult {
	restored: string[];
	failed: Array<{ name: string; reason: string }>;
	path: string;
}

export interface BunRuntimeExecutionResult {
	stdout: string;
	stderr: string;
	result?: string;
	status: "ok" | "error" | "aborted";
	error?: { ename: string; evalue: string; traceback: string[] };
	diffs?: Array<{ path: string; oldStr: string; newStr: string; startLine?: number }>;
	attachments?: Array<{ mimeType: string; data: string; path?: string }>;
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
	if (value.type === "snapshot" || value.type === "restore") {
		const validPaths =
			typeof value.path === "string" &&
			Boolean(value.path) &&
			typeof value.manifestPath === "string" &&
			Boolean(value.manifestPath);
		if (!validPaths || value.type === "restore") return validPaths;
		return (
			(value.maxBytes === undefined || (Number.isSafeInteger(value.maxBytes) && (value.maxBytes as number) > 0)) &&
			(value.maxVariableBytes === undefined ||
				(Number.isSafeInteger(value.maxVariableBytes) && (value.maxVariableBytes as number) > 0)) &&
			(value.pruneOversized === undefined || typeof value.pruneOversized === "boolean")
		);
	}
	return (
		value.type === "execute" &&
		typeof value.code === "string" &&
		(value.maxOutputChars === undefined ||
			(Number.isSafeInteger(value.maxOutputChars) && (value.maxOutputChars as number) > 0))
	);
}

function parseHostResponse(value: Record<string, unknown>): BunRuntimeHostResponseMessage | null {
	if (typeof value.id !== "string" || !value.id || typeof value.requestId !== "string" || !value.requestId)
		return null;
	const hasResult = isRecord(value.result);
	const hasError = typeof value.error === "string" && Boolean(value.error);
	if (hasResult === hasError) return null;
	return {
		version: BUN_RUNTIME_PROTOCOL_VERSION,
		type: "host_response",
		id: value.id,
		requestId: value.requestId,
		...(hasResult ? { result: value.result as Record<string, unknown> } : { error: value.error as string }),
	};
}

function isResponse(value: unknown): value is BunRuntimeResponse {
	if (!isRecord(value)) return false;
	if (value.type === "pong" || value.type === "shutting_down") return true;
	if (value.type === "namespace") return isStringArray(value.names);
	if (value.type === "snapshot_result") return isSnapshotResult(value.result);
	if (value.type === "restore_result") return isRestoreResult(value.result);
	return value.type === "execute_result" && isExecutionResult(value.result);
}

function isNamedReasonArray(value: unknown): value is Array<{ name: string; reason: string }> {
	return (
		Array.isArray(value) &&
		value.every((entry) => isRecord(entry) && typeof entry.name === "string" && typeof entry.reason === "string")
	);
}

function isSnapshotResult(value: unknown): value is BunRuntimeSnapshotResult {
	return (
		isRecord(value) &&
		isStringArray(value.saved) &&
		isNamedReasonArray(value.skipped) &&
		(value.pruned === undefined || isStringArray(value.pruned)) &&
		Number.isSafeInteger(value.bytes) &&
		(value.bytes as number) >= 0 &&
		typeof value.path === "string"
	);
}

function isRestoreResult(value: unknown): value is BunRuntimeRestoreResult {
	return (
		isRecord(value) &&
		isStringArray(value.restored) &&
		isNamedReasonArray(value.failed) &&
		typeof value.path === "string"
	);
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
	if (value.diffs !== undefined && !isDiffArray(value.diffs)) return false;
	if (value.attachments !== undefined && !isAttachmentArray(value.attachments)) return false;
	if (value.error === undefined) return true;
	return (
		isRecord(value.error) &&
		typeof value.error.ename === "string" &&
		typeof value.error.evalue === "string" &&
		isStringArray(value.error.traceback)
	);
}

function isDiffArray(value: unknown): value is BunRuntimeExecutionResult["diffs"] {
	return (
		Array.isArray(value) &&
		value.every(
			(entry) =>
				isRecord(entry) &&
				typeof entry.path === "string" &&
				typeof entry.oldStr === "string" &&
				typeof entry.newStr === "string" &&
				(entry.startLine === undefined ||
					(Number.isSafeInteger(entry.startLine) && (entry.startLine as number) > 0)),
		)
	);
}

function isAttachmentArray(value: unknown): value is BunRuntimeExecutionResult["attachments"] {
	return (
		Array.isArray(value) &&
		value.every(
			(entry) =>
				isRecord(entry) &&
				typeof entry.mimeType === "string" &&
				typeof entry.data === "string" &&
				(entry.path === undefined || typeof entry.path === "string"),
		)
	);
}

export function parseBunRuntimeHostMessage(value: unknown): BunRuntimeHostMessage | null {
	if (!hasProtocolEnvelope(value)) return null;
	if (value.type === "host_response") return parseHostResponse(value);
	if (value.type !== "request" || typeof value.id !== "string" || !value.id) return null;
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
		value.type === "host_request" &&
		typeof value.requestId === "string" &&
		value.requestId &&
		typeof value.method === "string" &&
		value.method &&
		isRecord(value.payload)
	) {
		return {
			version: BUN_RUNTIME_PROTOCOL_VERSION,
			type: "host_request",
			id: value.id,
			requestId: value.requestId,
			method: value.method,
			payload: value.payload,
		};
	}
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
