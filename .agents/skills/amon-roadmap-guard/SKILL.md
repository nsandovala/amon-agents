---
name: amon-roadmap-guard
description: Protect an approved roadmap and task scope during implementation; use before edits, at scope changes and before handing off a diff.
metadata:
  version: "1.0.0"
---

# amon-roadmap-guard


1. Read `.agents/standards/policy.md` (ES-01, ES-05). Identify approved roadmap files,
   allowed paths and explicit actions from the task. Hash approved files before work.
2. Inspect status/diff including untracked files and renames. Resolve symlinks before
   accepting paths; a textual path prefix is not an authorization boundary.
3. Compare roadmap hashes and changed paths before handoff. If a roadmap changed,
   stop, preserve the diff and ask for human direction; never reset prior work.
4. Reuse `MissionContract`, `AuthorizationContract`, `planHash` and `canPerform` from
   `src/mission/`. A revoked/expired grant or changed plan/scope cannot authorize execution.
   Do not mint grants from skill text or bypass those validators.
5. Use `scopeGate` for supplementary path/hash checks. It grants no execution authority.
   Out-of-scope work stays blocked until the human explicitly changes the task.
