import { attachJsonlLineReader } from "../../modes/rpc/jsonl.js";
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

function handleLine(line: string): void {
	const message = decodeBunRuntimeHostLine(line);
	if (!message) {
		process.stderr.write("Invalid Bun runtime protocol message\n");
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
