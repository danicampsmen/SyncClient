---
name: ubuntu-sync-verify
description: Verify an Ubuntu synchronization change with focused tests and failure-scenario checks.
argument-hint: "[files, commit, or behavior to verify]"
agent: ubuntu-sync-implementer
---

Verify only this Ubuntu Desktop synchronization change:
`${input:change:describe the files, commit, or behavior to verify}`.

Read the relevant diff and tests first. Check SQLite persistence, Drive retry
behavior, checksum/temporary-file handling, cursor safety, conflict behavior,
and watcher anti-loop protections as applicable. Run only existing focused
validation commands. Do not modify files unless the user explicitly asks for
fixes. Report passed checks, failed checks, and evidence.
