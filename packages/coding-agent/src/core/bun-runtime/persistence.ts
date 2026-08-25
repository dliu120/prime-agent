import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { deserialize, serialize } from "node:v8";
import type { ExecutionRestoreResult, ExecutionSnapshotResult } from "../execution-runtime.js";
import type { BunCellEvaluator } from "./evaluator.js";

interface SnapshotEntry {
	name: string;
	offset: number;
	length: number;
}

export const DEFAULT_BUN_SNAPSHOT_MAX_BYTES = 256 * 1024 * 1024;
export const DEFAULT_BUN_SNAPSHOT_MAX_VARIABLE_BYTES = 16 * 1024 * 1024;

export interface BunSnapshotOptions {
	maxBytes?: number;
	maxVariableBytes?: number;
	pruneOversized?: boolean;
}

interface SnapshotManifest {
	version: 1;
	payloadSha256: string;
	entries: SnapshotEntry[];
	skipped: Array<{ name: string; reason: string }>;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function atomicWrite(path: string, data: string | Uint8Array): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporaryPath, data);
		await rename(temporaryPath, path);
	} catch (error) {
		await unlink(temporaryPath).catch(() => undefined);
		throw error;
	}
}

function parseManifest(value: unknown): SnapshotManifest {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("Invalid snapshot manifest");
	const candidate = value as Record<string, unknown>;
	if (candidate.version !== 1 || typeof candidate.payloadSha256 !== "string") {
		throw new Error("Unsupported snapshot manifest");
	}
	if (!Array.isArray(candidate.entries) || !Array.isArray(candidate.skipped))
		throw new Error("Invalid snapshot manifest");
	const entries = candidate.entries.map((entry): SnapshotEntry => {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry))
			throw new Error("Invalid snapshot entry");
		const item = entry as Record<string, unknown>;
		if (
			typeof item.name !== "string" ||
			!item.name ||
			!Number.isSafeInteger(item.offset) ||
			(item.offset as number) < 0 ||
			!Number.isSafeInteger(item.length) ||
			(item.length as number) < 0
		) {
			throw new Error("Invalid snapshot entry");
		}
		return { name: item.name, offset: item.offset as number, length: item.length as number };
	});
	const skipped = candidate.skipped.map((entry): { name: string; reason: string } => {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error("Invalid skipped entry");
		const item = entry as Record<string, unknown>;
		if (typeof item.name !== "string" || typeof item.reason !== "string") throw new Error("Invalid skipped entry");
		return { name: item.name, reason: item.reason };
	});
	return { version: 1, payloadSha256: candidate.payloadSha256, entries, skipped };
}

export async function snapshotBunState(
	evaluator: BunCellEvaluator,
	path: string,
	manifestPath: string,
	options: BunSnapshotOptions = {},
): Promise<ExecutionSnapshotResult> {
	const maxBytes = options.maxBytes ?? DEFAULT_BUN_SNAPSHOT_MAX_BYTES;
	const maxVariableBytes = options.maxVariableBytes ?? DEFAULT_BUN_SNAPSHOT_MAX_VARIABLE_BYTES;
	const chunks: Buffer[] = [];
	const entries: SnapshotEntry[] = [];
	const skipped: Array<{ name: string; reason: string }> = [];
	const oversized: string[] = [];
	let offset = 0;
	for (const name of evaluator.listNamespaceNames()) {
		try {
			const chunk = serialize(evaluator.getNamespaceValue(name));
			if (chunk.length > maxVariableBytes) {
				skipped.push({ name, reason: "exceeds per-variable snapshot size cap" });
				oversized.push(name);
				continue;
			}
			if (offset + chunk.length > maxBytes) {
				skipped.push({ name, reason: "exceeds aggregate snapshot size cap" });
				continue;
			}
			chunks.push(chunk);
			entries.push({ name, offset, length: chunk.length });
			offset += chunk.length;
		} catch (error) {
			skipped.push({ name, reason: errorMessage(error) });
		}
	}
	const payload = Buffer.concat(chunks);
	const manifest: SnapshotManifest = {
		version: 1,
		payloadSha256: createHash("sha256").update(payload).digest("hex"),
		entries,
		skipped,
	};
	await atomicWrite(path, payload);
	await atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
	const pruned = options.pruneOversized ? oversized : [];
	for (const name of pruned) evaluator.deleteNamespaceValue(name);
	return {
		saved: entries.map((entry) => entry.name),
		skipped,
		...(pruned.length > 0 ? { pruned } : {}),
		bytes: payload.length,
		path,
	};
}

export async function restoreBunState(
	evaluator: BunCellEvaluator,
	path: string,
	manifestPath: string,
): Promise<ExecutionRestoreResult> {
	const [payload, manifestSource] = await Promise.all([readFile(path), readFile(manifestPath, "utf8")]);
	const manifest = parseManifest(JSON.parse(manifestSource) as unknown);
	const digest = createHash("sha256").update(payload).digest("hex");
	if (digest !== manifest.payloadSha256) throw new Error("Bun snapshot payload does not match its manifest");
	const restored: string[] = [];
	const failed: Array<{ name: string; reason: string }> = [];
	for (const entry of manifest.entries) {
		if (entry.offset + entry.length > payload.length) {
			failed.push({ name: entry.name, reason: "Snapshot entry exceeds payload bounds" });
			continue;
		}
		try {
			const value: unknown = deserialize(payload.subarray(entry.offset, entry.offset + entry.length));
			evaluator.setNamespaceValue(entry.name, value);
			restored.push(entry.name);
		} catch (error) {
			failed.push({ name: entry.name, reason: errorMessage(error) });
		}
	}
	return { restored, failed, path };
}
