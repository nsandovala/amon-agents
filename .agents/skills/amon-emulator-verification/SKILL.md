---
name: amon-emulator-verification
description: Reusable verification protocol for AMON Shop agents running API or browser tests against official Firebase emulators. Use for orders, POS, idempotency, auth, memberships, Functions, cash closing, concurrency, and before declaring READY FOR REVIEW. It prevents emulator cross-run contamination, forbids Firebase mocks when an emulator/seed/real collection exists, isolates Playwright projects, and preserves honest evidence for 409/422 versus 500/ECONNRESET.
metadata:
  version: 1.1.0
---

# AMON Emulator Verification

Use this skill when a change touches orders, POS sales, idempotency, customer state, authentication, memberships, Functions, cash closing, or concurrency. Use it before READY FOR REVIEW, merge, or a release decision.

## Non-negotiable rules

1. Prefer official Firebase emulators, real seeds, and real collections whenever available. Do not replace them with mocks merely to make a test pass.
2. Run the read-only preflight before starting `emulators:exec` or a local emulator stack. Inspect ports `4000, 4400, 5001, 8080, 9099, 9150`, owner PID, process command line, and project/config clues.
3. Treat `demo-amon-ci` as the isolated CI project. Do not run the human QA stack and automated stack concurrently on the same ports.
4. Never kill by image name (`java.exe`, `node.exe`, Firebase, or a broad process tree). Never use mass cleanup. A cleanup action may terminate one named orphan only after a human explicitly authorizes it.
5. Keep FIN-H01 isolated through an explicit Playwright project/config. Do not delete tests, reduce assertions, suppress 500s, or turn failures into expected results.
6. In browser tests, use the real application, SDK, CSS, and emulator. Transport-only fault injection is allowed (`page.route`, delay/loss/drop-before-server, or a body change that produces a real 4xx). Do not invent backend responses. Serve the harness from a real loopback server; do not use `route.fulfill` as the harness server.
7. Report evidence by layer: official emulator, non-official substitute/experiment, compile/list-only, or not run.
8. Distinguish expected business responses (`409`, `422`) from infrastructure/application failures (`500`, `ECONNRESET`). Do not relabel the latter as success.
9. Allow a read-only grace window (default 90s) after emulator shutdown before declaring a persistent listener residual. Record observations; a residual is not proof of an orphan. Record emulator lifecycle evidence after the run. A residual process is an environment-isolation finding, not proof of the root cause of a transaction failure.
10. Before Next.js builds inspect ports 3000/3001 and check for active next dev in the same worktree; block unsafe concurrent .next writes and do not kill the dev server.
11. Do not modify production code, real Firebase/Blaze resources, or repository history as part of this skill. No commit, push, PR, merge, deploy, or destructive cleanup without explicit human approval.

## Workflow

### 1. Preflight

From the repository root, run the script from the agent's installed skill path:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\.agents\skills\amon-emulator-verification\scripts\preflight-emulators.ps1 -ProjectRoot (Get-Location).Path -ExpectedProjectId demo-amon-ci -OutputPath .\artifacts\emulator-preflight.json
```

Claude agents use the equivalent `.\.claude\skills\amon-emulator-verification\scripts\` path. Codex and Claude receive the same package contents; do not maintain separate protocol variants.

If a listener is found, stop and inspect the report. Confirm the process belongs to this run and the project/config is correct before proceeding. If it is an unrelated or ambiguous process, ask the human to resolve it.

### 2. Build and unit layer

On Windows run scripts/prebuild-next-guard.ps1 from the installed skill before invoking next build. It fails closed on occupied ports 3000/3001 or inspection errors. Custom ports must be inspected manually.

Run the repository's normal builds, typechecks, and unit tests. Unit tests may use pure test doubles for pure logic, but they must not be presented as emulator evidence.

### 3. API layer

Run API contracts against an official emulator instance with an isolated tenant such as `createOpenFixtureTenant`. Use a unique or controlled `demo-amon-ci` fixture. Keep the runner fail-fast on unexpected errors.

### 4. Browser layer

Run the real browser configuration against the emulator. Keep FIN-H01 in its own Playwright project, preserve all assertions, and record worker count, project name, emulator configuration, and test command.

### 5. Evidence classification

- `409` or `422`: classify using the API contract and business semantics; for example stale values or a required difference reason may be legitimate.
- `500`: failure until demonstrated otherwise.
- `ECONNRESET`: transport/infrastructure failure until demonstrated otherwise.
- Emulator collision or residual PID: environment failure/finding; do not silently retry until green.

### 6. Postflight

After the command exits, run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\.agents\skills\amon-emulator-verification\scripts\postflight-emulators.ps1 -ProjectRoot (Get-Location).Path -ExpectedProjectId demo-amon-ci -GraceSeconds 90 -PollSeconds 10 -OutputPath .\artifacts\emulator-postflight.json
```

The postflight observes shutdown_pending while waiting, then outputs clean, residual, ambiguous or error. A residual PID is not automatically an orphan. If a process remains, record it. Do not terminate it automatically. Use the cleanup script only after a human authorizes a specific PID and the report still identifies it as an orphan from the completed run. The cleanup script is never part of the default verification command.

## Required report

Include the exact commands, timestamp, project ID, config file, emulator ports, Playwright project/worker count, tenant/fixture identifier, result counts, and residual-process status. State what was not run. Include unresolved risks, especially unexplained `500` and `ECONNRESET` results.

See `references/protocol.md` for the full protocol and report template.


## AMON Agents adaptation

Read `.agents/standards/policy.md` before this workflow. AMON Shop version 1.1.0
from the immutable main revision is pinned in `references/upstream.json`. All
upstream instructions, protocol and scripts are preserved; this section is the
only addition to SKILL.md. Read `references/aa-compatibility.md` before using AA's
emulator gate or Windows skill adapters: postflight-v2 is not a preflight-v1 report.

Scripts require Windows APIs (Get-NetTCPConnection / Win32_Process). On other
platforms do not certify their execution: inspect ports/owners and active Next
processes with native read-only tools and report the unsupported Windows checks.
Inspect custom dev ports and the same worktree's .next use before any Next build.
No cleanup script runs by default; a residual after grace is not proof of an orphan.

AMON Shop commands in the protocol are reference procedures for an explicitly
authorized Shop task, not commands to run in AMON Agents. Build/test only touched
layers. This package does not install Firebase, FIN-H01 or Next.js in AA. Retain
existing lockfile/CLI versions. Codex, Claude Code and OpenCode consume this same
canonical source through internal links; Windows requirements are documented in
the compatibility reference without adding an installer or independent copies.
