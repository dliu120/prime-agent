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
- Exposes Bun APIs through the `Bun` global.
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

Run focused Bun tests from `packages/coding-agent`, then run the repository gate:

```bash
bun ../../node_modules/vitest/dist/cli.js --run test/bun-cell-transform.test.ts test/bun-cell-evaluator.test.ts test/bun-persistence.test.ts
npx tsx ../../node_modules/vitest/dist/cli.js --run test/bun-runtime-protocol.test.ts test/bun-runtime-process.test.ts test/bun-execution-runtime-contract.test.ts test/bun-tool.test.ts
npm run check
```
