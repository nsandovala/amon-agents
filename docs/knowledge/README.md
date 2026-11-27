# Engineering knowledge handoffs

Versioned, sanitized handoffs live in `handoffs/`. Read the mission file before
working on an existing increment. These records summarize observations and point to
local evidence; they are not execution grants, signed `AuthorizationContract`s, or
release approvals.

For LAB-01A, start with [`handoffs/LAB-01A.json`](handoffs/LAB-01A.json). Check its
base SHA, branch, incident history, test coverage and open risks against the current
worktree. The private raw handoff and diff remain under the worktree's ignored
`.execution-qa/LAB-01A/`. They are not included in Git. Before deleting that
worktree, a human must authorize a sanitized, hash-verified transfer of those
artifacts to an approved durable location; this directory is not a backup of them.

The seven standard output fields are checked by `validateOutput`. Additional
incident and provenance fields are review data and have no dedicated semantic
validator. Review them against the referenced evidence before relying on them.
