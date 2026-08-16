#!/usr/bin/env node
import { APP_NAME } from "../config.js";
import { BUN_RUNTIME_WORKER_ROLE_ENV } from "../core/bun-runtime/process.js";
import { runBunRuntimeWorker } from "../core/bun-runtime/worker.js";

process.title = APP_NAME;
process.emitWarning = (() => {}) as typeof process.emitWarning;

import { restoreSandboxEnv } from "./restore-sandbox-env.js";

restoreSandboxEnv();

if (process.env[BUN_RUNTIME_WORKER_ROLE_ENV] === "1") {
	runBunRuntimeWorker();
} else {
	await import("./register-bedrock.js");
	await import("../cli.js");
}
