---
name: amon-preflight
description: Inspect a repository and local execution environment before installs, builds or changes; use for isolated worktree setup, iCloud/dataless failures, dependency links and uncertain process ownership.
metadata:
  version: "1.0.0"
---

# amon-preflight


1. Read repository instructions and `.agents/standards/policy.md` (ES-01–04, ES-09).
2. Inspect storage metadata first. Run the read-only collector from the authorized
   root: `python3 .agents/skills/amon-preflight/scripts/inspect_environment.py .`.
   It prints metadata only and never hydrates files, installs, starts or kills processes.
   Nonzero exit means stop and investigate. It cannot certify remote mounts or QA credentials.
3. Confirm mount identity, writability and enough space for this task; record Git
   root/branch/SHA/status/remotes/worktree list, existing changes and active listeners.
   Verify the requested remote revision read-only; do not fetch/pull or create another
   worktree if an adequate isolated worktree already exists. Do not expose credential URLs.
4. Capture approved roadmap hashes and the human's allowed paths/actions. Keep requirements
   separate from observations. Use `.agents/standards/contracts/preflight.schema.json`
   and `src/standards/gates.ts` to reject unknown/unsafe observations.
5. Only after preflight is safe, install once from the existing lockfile when needed.
   Inspect dependency links again after installation. Record exceptions and blockers.
