import { describe, expect, it } from "vitest";
import {
	BUN_RUNTIME_PROTOCOL_VERSION,
	decodeBunRuntimeHostLine,
	decodeBunRuntimeWorkerLine,
	encodeBunRuntimeMessage,
	parseBunRuntimeHostMessage,
	parseBunRuntimeWorkerMessage,
} from "../src/core/bun-runtime/protocol.js";

describe("Bun runtime protocol", () => {
	it("round-trips valid host and worker messages", () => {
		const request = {
			version: BUN_RUNTIME_PROTOCOL_VERSION,
			type: "request" as const,
			id: "request-1",
			request: { type: "ping" as const },
		} as const;
		const response = {
			version: BUN_RUNTIME_PROTOCOL_VERSION,
			type: "response" as const,
			id: "request-1",
			response: { type: "pong" as const },
		} as const;

		expect(decodeBunRuntimeHostLine(encodeBunRuntimeMessage(request).trimEnd())).toEqual(request);
		expect(decodeBunRuntimeWorkerLine(encodeBunRuntimeMessage(response).trimEnd())).toEqual(response);
	});

	it("rejects unknown versions, shapes, and malformed JSON", () => {
		expect(
			parseBunRuntimeHostMessage({ version: 2, type: "request", id: "x", request: { type: "ping" } }),
		).toBeNull();
		expect(parseBunRuntimeHostMessage({ version: 1, type: "request", id: "", request: { type: "ping" } })).toBeNull();
		expect(
			parseBunRuntimeHostMessage({ version: 1, type: "request", id: "x", request: { type: "execute" } }),
		).toBeNull();
		expect(parseBunRuntimeWorkerMessage({ version: 1, type: "ready", bunVersion: "" })).toBeNull();
		expect(
			parseBunRuntimeWorkerMessage({ version: 1, type: "response", id: "x", response: { type: "wat" } }),
		).toBeNull();
		expect(decodeBunRuntimeHostLine("{")).toBeNull();
		expect(decodeBunRuntimeWorkerLine("not json")).toBeNull();
	});

	it("preserves request correlation and error details", () => {
		expect(
			parseBunRuntimeWorkerMessage({
				version: BUN_RUNTIME_PROTOCOL_VERSION,
				type: "error",
				id: "request-9",
				error: "execution failed",
			}),
		).toEqual({
			version: BUN_RUNTIME_PROTOCOL_VERSION,
			type: "error",
			id: "request-9",
			error: "execution failed",
		});
	});

	it("validates execution requests, stream events, and results", () => {
		expect(
			parseBunRuntimeHostMessage({
				version: BUN_RUNTIME_PROTOCOL_VERSION,
				type: "request",
				id: "execute-1",
				request: { type: "execute", code: "42", maxOutputChars: 1024 },
			}),
		).not.toBeNull();
		expect(
			parseBunRuntimeWorkerMessage({
				version: BUN_RUNTIME_PROTOCOL_VERSION,
				type: "stream",
				id: "execute-1",
				name: "stdout",
				chunk: "hello\n",
			}),
		).not.toBeNull();
		expect(
			parseBunRuntimeWorkerMessage({
				version: BUN_RUNTIME_PROTOCOL_VERSION,
				type: "response",
				id: "execute-1",
				response: {
					type: "execute_result",
					result: { stdout: "", stderr: "", status: "ok", result: "42", durationMs: 1 },
				},
			}),
		).not.toBeNull();
		expect(
			parseBunRuntimeHostMessage({
				version: BUN_RUNTIME_PROTOCOL_VERSION,
				type: "request",
				id: "execute-2",
				request: { type: "execute", code: "42", maxOutputChars: 0 },
			}),
		).toBeNull();
		expect(
			parseBunRuntimeHostMessage({
				version: BUN_RUNTIME_PROTOCOL_VERSION,
				type: "request",
				id: "snapshot-1",
				request: {
					type: "snapshot",
					path: "/tmp/state.v8",
					manifestPath: "/tmp/state.json",
					maxBytes: 1024,
					maxVariableBytes: 512,
					pruneOversized: true,
				},
			}),
		).not.toBeNull();
		expect(
			parseBunRuntimeHostMessage({
				version: BUN_RUNTIME_PROTOCOL_VERSION,
				type: "request",
				id: "snapshot-2",
				request: {
					type: "snapshot",
					path: "/tmp/state.v8",
					manifestPath: "/tmp/state.json",
					maxVariableBytes: 0,
				},
			}),
		).toBeNull();
	});
});
