# Bun runtime

The `bun` built-in tool is an additive, experimental TypeScript execution surface. It does not replace or disable the default `ipython` tool.

## Selection

```bash
# TypeScript/Bun only
prime-agent --tools bun

# Keep both model-facing runtimes available
prime-agent --tools ipython,bun
```

Without `--tools`, Prime Agent continues to expose only `ipython`. Existing Python-backed skills therefore keep their current discovery, installation, and execution path.

## Behavior

- Runs TypeScript in an isolated Bun subprocess over versioned JSONL IPC.
- Preserves top-level variables, functions, classes, and static imports across sequential cells.
- Supports top-level `await`, streamed `console` output, structured errors, and restart after interruption.
- Exposes Bun APIs through the `Bun` global, including `Bun.$` and `Bun.spawn` for project commands.
- Exposes `prime.hostRequest(method, payload)`, `prime.displayDiff(diff)`, and `prime.attach(attachment)` for typed host capabilities and rich output.
- Discovers TypeScript-backed skills and loads their module namespace into the persistent runtime.
- Snapshots each binding independently with V8 serialization. Unsupported live values are skipped and reported rather than invalidating serializable state.

The payload and JSON manifest are written separately with atomic replacement and tied together by a SHA-256 digest. Restore rejects a mismatched or corrupt pair.

## Limitations

- Python-backed skills are not translated automatically. Select `ipython` when a task requires one.
- Functions, module namespaces, promises, subprocesses, sockets, and other live resources generally cannot be restored. Recreate them after resume.
- Interrupting a cell terminates the Bun worker. This guarantees that stuck work stops, but clears unsnapshotted in-memory state.
- The worker boundary isolates protocol and lifecycle failure; it is not a security sandbox. Executed code has the worker's operating-system permissions.
- TypeScript skills do not automatically translate Python-only skills or their dependencies.

## TypeScript-backed skills

A TypeScript skill keeps the standard `SKILL.md` and adds a module package:

```text
my-skill/
├── SKILL.md
├── package.json
└── src/
    └── index.ts
```

The module namespace is exposed under the skill name with hyphens converted to underscores. For `my-skill`, call exports through `my_skill`:

```typescript
await my_skill.run({ input: "example" })
```

Dependencies must already be resolvable from the skill or workspace. Automatic dependency installation is intentionally not part of runtime startup.

## Upstream synchronization

Keep this fork's Python/IPython implementation unchanged wherever possible. After pulling `upstream/main`, evaluate changes to the shared execution contract, IPython tool behavior, host request handlers, rich output, and persistence. Mirror relevant behavior into the Bun adapter with parity tests instead of editing away the upstream path.

### Last upstream review

Reviewed on 2026-08-24 after fetching `upstream/main`.

- Fork head before this sync: `a1982e93732e18b6653c4864d2fdb2f6a22b1e19`
- Prior reviewed upstream head: `c75a637b00d3b52762841e72efe92289a0d55b49`
- Reviewed upstream head: `a9b5d88b52794c7d2234261973205630d4d84d82`
- Commit range: `c75a637b00d3b52762841e72efe92289a0d55b49..a9b5d88b52794c7d2234261973205630d4d84d82` (15 commits)
- Integration result: merged the current upstream TypeScript/application head into the Bun fork, retained the fork's Bun runtime files and parser dependency, advanced the workspace to Prime Agent 0.8.0, and intentionally left `prime-agent-runtime/` unchanged.

| Classification | Upstream changes | Disposition |
| --- | --- | --- |
| Already runtime-neutral | ACP terminal-quiescence fixes, RLM depth defaults and goal settlement, refinement lifecycle/status, model catalog and fast-mode updates, MCP provider refresh, heartbeat filtering, and shared UI rendering | Integrated in the shared TypeScript host. Both notebook runtimes receive the host-side behavior without adapter changes. |
| Python-specific | No `prime-agent-runtime/` changes were imported in this sync. | The fork-owned Python runtime remains byte-for-byte unchanged from the first parent. |
| Must also be implemented in Bun | No new Bun adapter parity change was required by this upstream range. | Existing Bun runtime, persistence, and compaction behavior remain intact and covered by the focused suite. |

Intentional differences remain unchanged: Python-backed skills and generic MCP connections belong to IPython; TypeScript-backed skills belong to Bun. Unsupported live Bun values are skipped and recreated after restore. The Bun worker remains a process boundary rather than a security sandbox.

Verification for this review covered the repository gate, the complete Bun-focused suite, and the shared compaction suite. The Python runtime was excluded from the sync and verified unchanged against the first parent.

Run focused runtime tests from `packages/coding-agent`, then run the repository gate:

```bash
bun ../../node_modules/vitest/dist/cli.js --run test/bun-cell-transform.test.ts test/bun-cell-evaluator.test.ts test/bun-persistence.test.ts
npx tsx ../../node_modules/vitest/dist/cli.js --run test/bun-runtime-protocol.test.ts test/bun-runtime-process.test.ts test/bun-execution-runtime-contract.test.ts test/bun-tool.test.ts
npx tsx ../../node_modules/vitest/dist/cli.js --run test/suite/agent-session-compaction.test.ts
npm run check
```
