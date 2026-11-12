# AA compatibility for upstream 1.1.0

The upstream SKILL.md prefix, protocol and scripts are preserved byte-for-byte.
The manifest pins the main SHA, original Git blob IDs and SHA-256 values. The
upstream README is omitted because its copy-based distribution and pre-AA scope
notes do not describe AA's canonical links. No installation system is added.

## Report contracts and AA gate

| Producer | 1.1.0 report | AA consumer |
| --- | --- | --- |
| preflight-emulators.ps1 | preflight-v1, unchanged | emulatorGate accepts this inventory |
| postflight-emulators.ps1 | postflight-v2; grace/poll and observations | Not a direct emulatorGate input; rejected as BLOCKED |
| prebuild-next-guard.ps1 | prebuild-next-v1 | Independent guard; not an emulatorGate input |

The postflight report changed from 1.0.0. Do not relabel its schema, drop grace
observations, reinterpret residual/ambiguous as clean, or treat exit code zero as
clean shutdown. Upstream postflight may exit zero with residual or ambiguous status.
The existing AA gate is intentionally unchanged in this package-only update.

For an authorized Windows run using the existing AA gate:

1. Run postflight after the emulator command exits, with the upstream bounded grace
   window (default 90 seconds, polls every 10). Preserve the complete postflight-v2
   JSON and the original test result. Never replace a failed test with lifecycle success.
2. Require final status `clean`, no inspection errors and no listeners. Any error,
   ambiguous or residual state blocks the handoff. Record it; no automatic retries
   until green, process termination or orphan inference.
3. Only after that clean result, collect one fresh inventory using the unchanged
   preflight-emulators.ps1 for the same absolute worktree, project and ports. Pass
   that **preflight-v1** inventory to AA's gate with `phase: postflight` and a current
   trusted time window. Keep both reports. Any new listener/error blocks the gate.
4. A gate PASS describes the fresh inventory only. Functional acceptance still
   requires the approved API/browser/auth checks. The gate does not ingest v2
   history; automated v2 ingestion would require a separately scoped runtime change.

Cleanup still requires human authorization for exactly one verified PID and the
upstream command-line checks. Neither a residual nor a pending shutdown grants it.
The Next prebuild guard blocks on any 3000/3001 listener or inspection error.
Inspect custom ports and all active `next dev` processes for the same worktree
manually; do not run dev/build against the same .next directory or stop dev implicitly.
The guard does not replace AA storage/dataless/dependency preflight.

## Windows links: documented prerequisite, no new installer

Codex reads `.agents/skills`. `.claude/skills` and `.opencode/skills` must be real
directory symlinks resolving to that same source, not copied packages or text files.
Windows needs a filesystem supporting symlinks, permission to create them (for
example an authorized Developer Mode setup), and Git symlink support at checkout.
Git with `core.symlinks=false` checks links out as plain files containing their
target text. Changing that setting later does not itself materialize existing links.
See [Git core.symlinks](https://git-scm.com/docs/git-config#Documentation/git-config.txt-coresymlinks)
and [Git for Windows symlinks](https://gitforwindows.org/symbolic-links.html).

Read-only checks from the authorized repository root:

```powershell
git config --show-origin --get core.symlinks
Get-Item -Force .claude/skills, .opencode/skills | Select-Object FullName, LinkType, Target
```

An unset Git option alone is not proof of working links. Run the existing affected
adapter test in that Windows checkout to verify real path identity and all bytes:

```powershell
node node_modules/vitest/vitest.mjs run src/standards/adapters.test.ts
```

If either path is a text file, missing, or a separate copy, client distribution is
NO-GO on that host. Preserve it and let the authorized operator correct the checkout
after inspecting local changes. Do not automatically delete/replace paths, change
global Git/Windows settings, create another clone or introduce a copy-sync installer.
Passing these checks on macOS establishes only local delivery parity, not Windows
execution or client-model compliance. PowerShell tests require a suitable runtime;
the upstream fail-closed test specifically invokes powershell.exe. Mark unrun tests
as not run; synthetic tests never establish official emulator/browser coverage.
