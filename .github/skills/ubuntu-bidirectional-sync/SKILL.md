---
name: ubuntu-bidirectional-sync
description: Analyze, design, implement, and verify the Ubuntu Desktop bidirectional synchronization engine for Google Drive. Use when a task concerns src/backend/syncEngine.ts, SQLite state, local filesystem watching, Drive changes, resumable transfers, conflicts, recovery, or performance for large folders.
argument-hint: "[goal or file to inspect]"
---

# Ubuntu bidirectional synchronization

Use this skill only for the Linux Desktop/Ubuntu path. Do not change Android
behavior unless the task explicitly requires a shared contract or parity fix.

## Scope

- Primary engine: [`src/backend/syncEngine.ts`](../../../src/backend/syncEngine.ts)
- Shared planning logic: [`src/shared/CoreSyncLogic.ts`](../../../src/shared/CoreSyncLogic.ts)
- SQLite schema: [`src/shared/schema.ts`](../../../src/shared/schema.ts)
- Storage abstraction: [`src/shared/StorageBackend.ts`](../../../src/shared/StorageBackend.ts)
- Local scanner: [`src/shared/Scanner.ts`](../../../src/shared/Scanner.ts)
- Desktop service boundary: [`src/services/syncService.ts`](../../../src/services/syncService.ts)
- Relevant tests: `src/**/*.test.ts`

Read only the smallest set of files and symbols needed. Do not load
`node_modules/`, builds, releases, binaries, archives, credentials, databases,
or real synchronized data.

## Required design rules

1. Treat SQLite as durable synchronization state, not as a file-content store.
2. Keep all network transfers outside SQLite transactions.
3. Persist operation intent before network work and commit resulting state
   atomically with the relevant journal/cursor update.
4. Use Google Drive `changes.list` with durable page tokens for incremental
   remote discovery. A full recursive listing is only for initial indexing or
   deliberate reconciliation.
5. Confirm a remote cursor only after every page and operation before it has been
   applied successfully. Recover invalid cursors with a controlled rescan.
6. Use resumable uploads in 256 KiB multiples for large files. Persist the
   session URI and confirmed offset, and query the server range after an
   interrupted chunk before retrying.
7. Download to a unique temporary file, stream the checksum, verify size and
   checksum when available, then atomically rename and call `markSelfWritten()`.
8. Never infer content identity from `mtime` alone. Use size and hashes as the
   definitive check; use timestamps only as a fast path.
9. Preserve watcher loop protections: `markSelfWritten()`, `isSelfWritten()`,
   `activeSyncs`, cooldowns, debounce, and adaptive backoff.
10. Treat deletion-versus-modification as a conflict unless the persisted base
    state proves the deletion is authoritative.
11. Bound concurrency to the existing resource limits and use exponential
    backoff with jitter for transient Drive/network failures.
12. Surface errors. Do not add broad catches, silent fallbacks, or automatic
    destructive deletion.

## Workflow

1. Inspect the relevant symbols and existing tests.
2. State the current behavior and the invariant being protected.
3. Design the smallest compatible change.
4. Add or update focused tests before or with implementation.
5. Run the narrowest existing tests, then `npm run lint` when possible.
6. For changes involving transfers or persistence, test restart, retry,
   duplicate-event, cursor, conflict, and partial-file scenarios.
7. Report changed files, validation commands, failures, and remaining risks.

## Verification checklist

- No Drive token is logged or embedded in output.
- No transfer loads a large file entirely into memory.
- Failed operations remain recoverable after restart.
- A cursor is never advanced past an unapplied change.
- A self-generated filesystem event cannot start a sync loop.
- A network failure for one file does not discard unrelated queued work.
- Tests cover equal timestamps, deletions, conflicts, checksum mismatch,
  interrupted uploads, and invalid/expired cursors.
