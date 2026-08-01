---
name: ubuntu-sync-plan
description: Create a focused, read-only plan for improving Ubuntu Google Drive bidirectional synchronization.
argument-hint: "[problem or improvement goal]"
agent: ubuntu-sync-planner
---

Analyze only the Ubuntu Desktop bidirectional synchronization path for this
request: `${input:goal:describe the sync problem or improvement}`.

Use the Ubuntu synchronization skill and inspect the minimum relevant symbols.
Do not edit files. Include current behavior, evidence, risks, exact files,
focused tests, acceptance criteria, and rollback steps. Prefer official
Google Drive and SQLite sources when API or database behavior is involved.
