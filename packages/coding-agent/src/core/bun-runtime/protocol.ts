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

export type BunRuntimeHostMessage = BunRuntimeRequestMessage;
export type BunRuntimeWorkerMessage = BunRuntimeReadyMessage | BunRuntimeResponseMessage | BunRuntimeErrorMessage;

export type BunRuntimeRequest = { type: "ping" } | { type: "shutdown" };
export type BunRuntimeResponse = { type: "pong" } | { type: "shutting_down" };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasProtocolEnvelope(value: unknown): value is Record<string, unknown> & { type: string } {
	return isRecord(value) && value.version === BUN_RUNTIME_PROTOCOL_VERSION && typeof value.type === "string";
}

function isRequest(value: unknown): value is BunRuntimeRequest {
	return isRecord(value) && (value.type === "ping" || value.type === "shutdown");
}

function isResponse(value: unknown): value is BunRuntimeResponse {
	return isRecord(value) && (value.type === "pong" || value.type === "shutting_down");
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
