import { v4 as uuid } from "uuid";
import { attachJsonlLineReader } from "../../modes/rpc/jsonl.js";
import { BunCellEvaluator } from "./evaluator.js";
import { restoreBunState, snapshotBunState } from "./persistence.js";
import {
	BUN_RUNTIME_MAX_LINE_CHARS,
	BUN_RUNTIME_PROTOCOL_VERSION,
	type BunRuntimeResponse,
	decodeBunRuntimeHostLine,
	encodeBunRuntimeMessage,
} from "./protocol.js";

function send(message: Parameters<typeof encodeBunRuntimeMessage>[0]): void {
	process.stdout.write(encodeBunRuntimeMessage(message));
}

function respond(id: string, response: BunRuntimeResponse): void {
	send({ version: BUN_RUNTIME_PROTOCOL_VERSION, type: "response", id, response });
}

function fail(id: string, error: string): void {
	send({ version: BUN_RUNTIME_PROTOCOL_VERSION, type: "error", id, error });
}

let executionQueue: Promise<void> = Promise.resolve();
const evaluator = new BunCellEvaluator();
const pendingHostRequests = new Map<
	string,
	{ resolve: (result: Record<string, unknown>) => void; reject: (error: Error) => void }
>();

function hostRequest(id: string, method: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
	const requestId = uuid();
	const response = new Promise<Record<string, unknown>>((resolve, reject) => {
		pendingHostRequests.set(requestId, { resolve, reject });
	});
	send({ version: BUN_RUNTIME_PROTOCOL_VERSION, type: "host_request", id, requestId, method, payload });
	return response;
}

function execute(id: string, code: string, maxOutputChars?: number): void {
	const execution = executionQueue.then(async () => {
		const result = await evaluator.execute(code, {
			maxOutputChars,
			onStream: (chunk, name) => send({ version: BUN_RUNTIME_PROTOCOL_VERSION, type: "stream", id, chunk, name }),
			hostRequest: (method, payload) => hostRequest(id, method, payload),
		});
		respond(id, { type: "execute_result", result });
	});
	executionQueue = execution.catch(() => undefined);
	void execution.catch((error: unknown) => fail(id, error instanceof Error ? error.message : String(error)));
}

function snapshot(id: string, path: string, manifestPath: string): void {
	const operation = executionQueue.then(async () => {
		const result = await snapshotBunState(evaluator, path, manifestPath);
		respond(id, { type: "snapshot_result", result });
	});
	executionQueue = operation.catch(() => undefined);
	void operation.catch((error: unknown) => fail(id, error instanceof Error ? error.message : String(error)));
}

function restore(id: string, path: string, manifestPath: string): void {
	const operation = executionQueue.then(async () => {
		const result = await restoreBunState(evaluator, path, manifestPath);
		respond(id, { type: "restore_result", result });
	});
	executionQueue = operation.catch(() => undefined);
	void operation.catch((error: unknown) => fail(id, error instanceof Error ? error.message : String(error)));
}

function handleLine(line: string): void {
	const message = decodeBunRuntimeHostLine(line);
	if (!message) {
		process.stderr.write("Invalid Bun runtime protocol message\n");
		return;
	}
	if (message.type === "host_response") {
		const pending = pendingHostRequests.get(message.requestId);
		if (!pending) return;
		pendingHostRequests.delete(message.requestId);
		if (message.error) pending.reject(new Error(message.error));
		else pending.resolve(message.result ?? {});
		return;
	}
	try {
		switch (message.request.type) {
			case "ping":
				respond(message.id, { type: "pong" });
				return;
			case "shutdown":
				respond(message.id, { type: "shutting_down" });
				process.stdin.pause();
				return;
			case "list_namespace":
				respond(message.id, { type: "namespace", names: evaluator.listNamespaceNames() });
				return;
			case "snapshot":
				snapshot(message.id, message.request.path, message.request.manifestPath);
				return;
			case "restore":
				restore(message.id, message.request.path, message.request.manifestPath);
				return;
			case "execute":
				execute(message.id, message.request.code, message.request.maxOutputChars);
				return;
		}
	} catch (error) {
		fail(message.id, error instanceof Error ? error.message : String(error));
	}
}

export function runBunRuntimeWorker(): void {
	attachJsonlLineReader(process.stdin, handleLine, {
		maxLineLength: BUN_RUNTIME_MAX_LINE_CHARS,
		onLineOverflow: () => process.stderr.write("Bun runtime protocol message exceeded maximum length\n"),
	});
	process.stdin.resume();

	send({
		version: BUN_RUNTIME_PROTOCOL_VERSION,
		type: "ready",
		bunVersion: process.versions.bun ?? "unknown",
	});
}
