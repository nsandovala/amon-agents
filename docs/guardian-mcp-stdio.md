# Guardian MCP stdio — MCP-001B

Local, read-only MCP binding over the existing MCP-001A adapter. It exposes only
`get_runtime_status`, `list_recent_jobs`, `get_guardian_summary` and
`get_mission_snapshot`. There is no HTTP listener, execution tool, mission mutation,
authorization grant, provider initialization or Sentinel integration.

## Launch

Build with `npm run build`, then let the MCP client launch
`node /absolute/path/to/amon-agents/dist/guardian/mcp-stdio.js` with its working
directory set by the trusted host to the authorized evidence directory. The binary
is also registered as `amon-guardian-mcp`. There are no CLI arguments. Never launch
through a command that prints banners to stdout; `npm --silent run mcp:guardian`
is an alternative when running from this package directory.

The host chooses the working directory at process creation; MCP requests cannot
change it. The existing reader captures that directory and uses only these sources:

| Tool | Existing fixed source |
| --- | --- |
| `get_runtime_status` | `outputs/worker/worker-status.json` and operational projection |
| `list_recent_jobs` | `outputs/worker/jobs/*.json` |
| `get_guardian_summary` | `outputs/guardian/reviews/*.json` |
| `get_mission_snapshot` | `outputs/mission/board-snapshot.json`, schema `sb-mission/1` |

No request can supply a path, URL or alternate root. Exporting a mission is a
separate host operation; the MCP server never creates or refreshes that export.
Local filesystem ownership remains the trust boundary. This phase does not add an
authentication mechanism or reinterpret existing authorization contracts.

## Contracts and limits

`mcp-server.ts` registers schemas from `READ_TOOL_CONTRACTS` and delegates calls to
`createGuardianReadAdapter`. The adapter retains strict unknown-key, enum, timestamp,
opaque-reference and limit validation. It reuses `src/ops/projection.ts`, Guardian
contracts and the mission board export type. No source reader or projection is
duplicated in the transport.

Responses include matching text JSON and structured content. All adapter envelopes
retain `schemaVersion: guardian-read/1` and `executionAuthorized: false`, including
errors. Worker status and heartbeat freshness are independent: an explicitly
offline Worker with an old heartbeat stays offline and stale; unavailable evidence
remains unknown. Historical records do not demonstrate a currently running Worker.

The binding requires MCP initialization, rejects task execution and pagination,
and permits at most four simultaneous adapter reads with no additional queue.
The stdio SDK input buffer is capped at 64 KiB. Existing reader limits remain:
100 returned items, 1,000 directory records, 256 KiB per file and 4 MiB cumulative
read budget. Symlinks and hardlinks remain rejected by MCP-001A.

Only JSON-RPC frames go to stdout. Diagnostics on stderr are fixed strings; SDK
error messages and error data are replaced before serialization. Source failures
retain the adapter's safe error codes, without paths, raw records, private IDs,
secrets or stack traces. stdin EOF closes the server without sending process signals.
An oversized input buffer closes the transport with a fixed diagnostic.

The dependency is pinned to `@modelcontextprotocol/sdk` 1.32.2. This official SDK
line supplies CommonJS-compatible server/client transports for this repository.
See the [official v1 SDK documentation](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x)
for protocol APIs. No MCP framework or second adapter is introduced.

## Validation and acceptance boundary

Run only the affected tests and TypeScript checks:

```sh
npx --no-install vitest run src/guardian/mcp-server.test.ts src/guardian/mcp-stdio.test.ts src/guardian/read-adapter.test.ts src/guardian/read-sources.test.ts
npm run typecheck
npm run build
git diff --check
```

The binding tests use SDK in-memory transport. The stdio tests launch a real child
process using the official SDK client, with isolated empty sources; they verify
initialization, discovery, all four calls, safe failures, framing and EOF shutdown.
These tests do not establish acceptance with real mission evidence.

Functional acceptance must additionally query all four tools through the official
stdio client against authorized real evidence. Preserve a local sanitized protocol
transcript and compare hashes of operational originals and evidence copies before
and after. Check filters and limits, reject source overrides/execution tool names,
and verify `executionAuthorized: false`. Artifacts and source copies belong in
ignored `.execution-qa`, never in a commit.

Local functional acceptance passed for all four tools using the official SDK
client over stdio. Historical Worker/Jobs/Guardian evidence contained 14 jobs and
one Guardian review; the Worker was offline with a stale heartbeat. The initial
mission call verified the safe `SOURCE_UNAVAILABLE` error path.

Mission acceptance was completed in a separate stdio session against the same
implementation, using the authorized public `sb-mission/1` export from the
successful Sentinel QA context for JARVIS-MISSION-001E. The snapshot was copied
byte-for-byte to the ignored fixed mission source with mode 0600. The response
reported `ok: true`, a completed historical inspection, decision `revoked`, recorded
effective status `expired`, and `freshness: stale`. Both the envelope and mission
data retained `executionAuthorized: false`; timestamps were preserved and private
identifiers and internal evidence fields were omitted.

Original files and evidence copies retained their hashes, modification times and
permissions. No jobs were executed, missions modified, approvals granted or
process signals sent. This establishes local read-only acceptance, not current
Worker availability or execution authority. The public export has no independent
signature: its provenance relies on the authorized host-owned file. Local evidence
and transcripts remain excluded from publication. Technical GO remains subject to
human publication approval.
