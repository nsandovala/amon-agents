# AMON Execution Standards v1

Read this policy before executing any of the six skills. Instructions describe a
workflow; they do not grant permissions. Session authorization and repository
instructions remain binding. Only a human can approve an expansion of scope.

- **ES-01 — Scope:** record the authorized repository, worktree, base SHA, branch,
  allowed paths/actions and acceptance requirements. Preserve prior changes and
  other worktrees. Do not commit, push, create a PR, merge or deploy without authorization.
- **ES-02 — Storage:** inspect metadata before reading/building cloud-backed files.
  A dataless file, unknown inspection result or unresolved dependency path blocks
  a build. Recover into one authorized local worktree, preserving the old copy.
  Never copy incomplete Git objects, node_modules, build caches or backups from iCloud.
- **ES-03 — Dependencies:** install from the lockfile without changing versions.
  Reject node_modules or dependency links resolving outside the isolated worktree,
  including backup links crawled by build tools. No repeated install/build without
  new evidence explaining why it is necessary.
- **ES-04 — Processes:** inventory listeners and ownership. Never stop a process
  without explicit authorization for that exact process, including a residual
  process created by a test. No broad kill, mass cleanup or worktree deletion.
- **ES-05 — Roadmap:** preserve approved roadmap content and scope. Capture hashes
  before editing and compare afterward. A changed plan requires a new human decision;
  do not silently update a roadmap or treat a prior grant as valid for a new plan.
- **ES-06 — Evidence:** distinguish simulated, automated unit/integration, official
  emulator and real browser observations. Build, typecheck, unit tests, a listener
  or a server's Ready message cannot establish functional acceptance.
- **ES-07 — Functional gate:** required HTTP, real browser and authentication checks
  must each be verified for the same run/revision. Missing, blocked, failed or mock
  checks prevent PASS. Observe the required business state, including revocation
  and unauthorized execution when in scope. Never disable auth or permissions.
- **ES-08 — Providers:** do not activate billable APIs, switch providers/endpoints or
  introduce services without human authorization covering the exact change. A mock
  fallback is simulation, never equivalent acceptance. Do not expose secrets in evidence.
- **ES-09 — QA data:** use only explicitly identified QA credentials/data. Unknown DB
  provenance blocks DB-dependent checks. Report the exact connection/schema/seed
  needed; do not invent credentials or migrate production. Sandbox denial calls
  for an authorized execution context, not application security changes.
- **ES-10 — Honest diagnosis:** distinguish environment, compilation, authentication,
  DB and application failures. Preserve 500/ECONNRESET as failures; residual processes
  alone do not prove cause. Record commands, timestamps, results and untested layers.

The validators are advisory deterministic checks over observations, not a sandbox,
credential verifier or authorization service. Host-provided requirements and grants
must come from the human-approved task, never from model-generated evidence.
