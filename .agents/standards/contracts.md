# Contract reuse and operating the standards

| Concern | Canonical existing contract | v1 decision |
| --- | --- | --- |
| Engineering handoff | `core/output-contract.yaml`, `StandardOutput`, `validateOutput` | Reuse all seven required fields; no duplicate schema. |
| Execution/lifecycle | `src/worker/types.ts`: WorkerJobState and CodingToolEvidence | Reuse; no second execution contract. The Worker still supports OpenCode only. Skills adapters do not add executors. |
| Mission evidence and authorization | `src/mission/contracts.ts`: EvidenceContract, AuthorizationContract, MissionContract; `src/mission/state.ts` | Reuse validators, plan hash and execution checks. Never reinterpret a revoked grant. |
| Worker review | `src/guardian/types.ts`: GuardianReview and GuardianVerdict | Compose with the functional gate. Existing PASS concerns worker evidence only. |
| Emulator inventory | Upstream 1.1.0 retains `amon-emulator-verification/preflight-v1` | Reuse inventory shape; postflight-v2 is a separate report. See the skill compatibility reference. |
| Storage preflight | No existing contract for dataless metadata, dependency links or disk capacity | New `contracts/preflight.schema.json`. |
| Functional acceptance | No existing contract binding HTTP/browser/auth observations to one run/revision | New `contracts/release-gate.schema.json`. |

The JSON Schemas describe **observations**, not permissions or a release decision.
Explicit TypeScript guards validate their shapes. Gates add the contextual checks.
No generic JSON Schema engine, service or new dependency is installed. Required
fields/enums and negative inputs are covered by directed tests; these tests are
not a general JSON Schema conformance suite.

## Run from the authorized repository root

```sh
python3 .agents/skills/amon-preflight/scripts/inspect_environment.py .
npm exec --no -- ts-node src/standards/cli.ts preflight observations.json trusted-requirements.json
npm exec --no -- vitest run src/standards
PYTHONDONTWRITEBYTECODE=1 python3 .agents/skills/amon-preflight/scripts/test_inspect.py
npm run typecheck
```

Choose an already installed working Node version if the system Node is broken.
Do not change the system installation or repeat dependency installation to solve
an unrelated loader failure. The collector only reads metadata and prints JSON.
Capture output into a task-authorized, ignored evidence directory; no secrets.
Its `writable` field reflects the executing context, so a sandbox denial does not
establish that the physical drive is read-only. Linux results do not certify a
remote/macOS iCloud filesystem: require an authorized native check there.
Internal skill links are allowed. External links anywhere in the scanned worktree
block build readiness conservatively, including dependency backup links.
Missing dependencies can pass an **install** preflight with `requireDependencies:false`,
but a **build** preflight must set it to true. Choose `minFreeBytes` for the planned
operation; no arbitrary universal capacity threshold is embedded in the collector.

### Trusted requirements

Derive this file from the human-approved task, not model-produced observations.
The CLI is read-only and assumes an authorized host provides the requirements.
It is not connected to the Worker scheduler and cannot grant execution rights.

Preflight example (replace context and times with actual observations):

```json
{
  "root": "/authorized/worktree",
  "startedAt": "2026-11-12T10:00:00.000Z",
  "now": "2026-11-12T10:10:00.000Z",
  "minFreeBytes": 1073741824,
  "requireDependencies": true
}
```

For `release`, requirements contain `runId`, canonical absolute `root`, `headSha`,
`branch`, `startedAt`, `now`, `required` and the actual `guardianVerdict`.
`required` selects `http`, `browser`, `authentication`, `business`, `emulator` as
applicable. Authentication requires browser evidence of a real session; business
requires real browser or official emulator evidence. The observation report must
match the JSON Schema and the run/revision/time window. All required checks must
pass in an appropriate real layer with an evidence reference. Duplicate checks,
stale evidence and observed failures block. An empty requirements list establishes
no runtime coverage. The gate cannot determine whether a human lied about an
artifact: evidence references and real observations must be reviewed.

For `emulator`, trusted requirements contain `projectId`, canonical `root`,
`startedAt`, `now`, `phase` (preflight or
postflight), and `ownedPids` identifying the intended run, **not permission to kill**.
Unknown ownership or inventory failure blocks; residual listeners block postflight.
Upstream 1.1.0 postflight-v2 is not a direct gate input. Follow
`.agents/skills/amon-emulator-verification/references/aa-compatibility.md`: preserve
the grace report, require clean, then collect a fresh v1 inventory for this gate.
Never infer that a residual PID caused a transaction failure. Keep 409/422 domain
assertions separate from unresolved 500/ECONNRESET. On macOS, imported Windows
scripts remain unexecuted; synthetic regression inputs do not certify Firebase.

For `provider`, observations contain `currentProvider`, `currentEndpoint`,
`requestedProvider`, `requestedEndpoint`, and `billable` (boolean or null when unknown).
Requirements are either null (no grant) or an exact trusted `provider`, `endpoint`,
`authorizationRef`. Unknown cost blocks even with a grant. No provider is called.

For `scope`, requirements contain canonical `root`, `allowedRealPaths` and approved
`roadmaps:[{path,before}]` (SHA-256). Observations contain `changedRealPaths` and
`roadmapHashes:{"path":"sha256"}`. The host must resolve symlinks, include deleted
and untracked files, and enumerate every approved roadmap before invoking the gate.
The CLI cannot auto-approve a missing baseline or broaden an allowlist.

## Client adapters

- Codex: `.agents/skills/` is canonical; `AGENTS.md` links the shared policy.
- Claude Code: `.claude/skills` is a relative directory link to the canonical source;
  `CLAUDE.md` retains all earlier instructions and adds the shared policy reference.
- OpenCode: `.opencode/skills` is the same relative link; `AGENTS.md` points to policy.

All six packages, references and scripts resolve to the exact same files. The
integration test hashes their complete contents through each adapter and checks
the pinned upstream scripts. No copied policy variants and no global client config.
Git must preserve symlinks: on Windows with symlinks disabled, adapter verification
fails and client distribution is NO-GO until an authorized checkout resolves it.
Windows prerequisites and read-only checks are documented in the Firebase skill
compatibility reference; no installer, global settings or copied variants are added.
This proves filesystem delivery parity, not actual LLM compliance or client invocation.
Client sessions and their own permission settings must still be checked when used.

Project skill paths were checked against the official
[Claude Code documentation](https://code.claude.com/docs/en/skills) and
[OpenCode documentation](https://opencode.ai/docs/skills/) on 2026-11-12.

## Regression provenance and boundaries

`src/standards/fixtures/incidents.json` contains synthetic cases derived from the
SB-FIX-001 report and AMON Shop PR #87. Tests reproduce dataless metadata, a backup
dependency link escaping the root, a missing browser/auth layer, a foreign/residual
Firestore PID, enumeration failure and unresolved HTTP failures. They execute no
Sentinel/Shop code, authentication, production DB, Firebase or billable provider.
Imported `references/upstream.json` now pins AMON Shop main at
`f0e576e9db13db12d56dd57bba43833e09e40bcf`, upstream version 1.1.0, each Git blob and
SHA-256; PR #87 remains historical incident provenance. The upstream README is
omitted because its distribution/pre-AA scope notes are superseded here. All 1.1.0
protocol, scripts and OpenAI metadata are exact upstream bytes; SKILL.md keeps the
upstream version and body intact with only an appended AA adaptation section.
The package's compatibility reference documents postflight-v2 and Windows links.
