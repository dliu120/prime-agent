/** A file edit emitted by a model-facing execution runtime. */
export interface ExecutionDiff {
	path: string;
	oldStr: string;
	newStr: string;
	/** 1-based line where `oldStr` begins in the file. */
	startLine?: number;
}

/** A media attachment emitted by a model-facing execution runtime. */
export interface ExecutionAttachment {
	mimeType: string;
	/** Base64-encoded bytes. */
	data: string;
	path?: string;
}

/** An agent message emitted while a cell executes. */
export interface ExecutionSentAgentMessage {
	id: string;
	message: string;
	deliveryStatus: "delivered" | "queued";
	receiverRole?: "parent" | "sibling" | "child";
	target: {
		activeSessionId: string;
		sessionId: string;
		sessionName?: string;
	};
}

export interface ExecutionError {
	ename: string;
	evalue: string;
	traceback: string[];
}

export interface ExecutionResult {
	stdout: string;
	stderr: string;
	result?: string;
	diffs?: ExecutionDiff[];
	attachments?: ExecutionAttachment[];
	sentAgentMessages?: ExecutionSentAgentMessage[];
	status: "ok" | "error" | "aborted";
	error?: ExecutionError;
	durationMs: number;
}

export interface ExecutionOptions {
	/** Aborting requests interruption of the active execution. */
	signal?: AbortSignal;
	onStream?: (chunk: string, name: "stdout" | "stderr") => void;
	onLateSentAgentMessage?: (message: ExecutionSentAgentMessage) => void;
	maxOutputChars?: number;
	/** Runtime bookkeeping execution excluded from user-cell attribution. */
	internal?: boolean;
}

export interface ExecutionRuntimeStartOptions {
	onProgress?: (message: string) => void;
	signal?: AbortSignal;
}

export interface ExecutionSnapshotResult {
	saved: string[];
	skipped: { name: string; reason: string }[];
	/** Oversized live values removed by an explicit compaction snapshot. */
	pruned?: string[];
	bytes: number;
	path: string;
}

export interface ExecutionRestoreResult {
	restored: string[];
	failed: { name: string; reason: string }[];
	path: string;
}

/** Handles one typed request from code running inside an execution runtime. */
export type ExecutionHostRequestHandler = (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;

export type ExecutionHostRequestHandlers = Record<string, ExecutionHostRequestHandler>;

/** The previous interrupted cell has not stopped, so another cell cannot start safely. */
export class ExecutionRuntimeBusyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ExecutionRuntimeBusyError";
	}
}

/**
 * Language-neutral process boundary used by the model-facing notebook tool.
 *
 * Implementations execute one cell at a time, isolate runtime failure from the
 * session host, and treat persistence as best effort. Live resources may be
 * skipped as long as the restore result reports the loss.
 */
export interface ExecutionRuntime {
	readonly isRunning: boolean;
	start(options?: ExecutionRuntimeStartOptions): Promise<void>;
	execute(code: string, options?: ExecutionOptions): Promise<ExecutionResult>;
	interrupt(): Promise<void>;
	restart(): Promise<void>;
	kill(): Promise<void>;
	dispose(): Promise<void>;
	listNamespaceNames(signal?: AbortSignal): Promise<string[] | null>;
	snapshotState(signal?: AbortSignal): Promise<ExecutionSnapshotResult | null>;
	pruneOversizedVariables(signal?: AbortSignal): Promise<ExecutionSnapshotResult | null>;
	restoreState(): Promise<ExecutionRestoreResult | null>;
}
