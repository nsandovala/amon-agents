# ARCH-001: AMON Agents Orchestration Engine Boundary

- Status: Accepted — implementation pending
- Date: 2026-09-30
- Scope: AMON Agents and its integration boundary with Sentinel Board
- Decision type: Architecture boundary and staged migration
- Implementation status: Not implemented
- Review: Adversarial review 2026-09-30 → ACCEPT_WITH_CHANGES; accepted changes
  applied in-place below (Stage 1 surface reduction, boundary guardrails, and
  explicit deferrals). See §18 recovery checkpoint.

## 1. Decision summary

AMON Agents will be the single orchestration and execution engine for agent work.
Sentinel Board will be the human control plane and Kanban. The CLI will remain a
developer, administrator, and debugging adapter over the same engine API.

The minimum extraction is not a rewrite, daemon, queue, or new worker system. It
is an in-process public engine facade around the existing pipeline, with
process-specific behavior moved to adapters and with an explicit result contract.
The existing pipeline, agents, prompts, provider calls, validation, routing, event
writer, local output format, and Sentinel payload builder should be preserved as
far as their current behavior permits.

The target dependency direction is:

```text
Sentinel Board UI/API       CLI       future scheduler       Liev cockpit
          |                 |                |                    |
          +-----------------+----------------+--------------------+
                                    |
                              Engine API contract
                                    |
                         AMON Agents Engine facade
                                    |
             routing -> policy -> agents -> providers/tools
                                    |
                    run state -> events -> artifacts
                                    |
                         approval request/decision
```

Sentinel Board must not become a second orchestration engine. Its existing local
agent executor can remain temporarily for compatibility, but it must not be
extended with orchestration, run state, tools, queues, or additional generic
agent definitions. It should be replaced by delegation to AMON Agents only after
the engine API provides equivalent behavior.

## 2. Context and evidence

### 2.1 Current AMON Agents runtime

AMON Agents is currently a Node.js/TypeScript batch runtime exposed primarily
through a CLI:

- Both package binaries resolve to `dist/cli/amon.js` in
  `amon-agents/package.json:7-10`.
- CLI dispatch and process termination live in
  `amon-agents/src/cli/amon.ts:75-142`.
- The direct runner parses `process.argv`, creates a run ID, calls the pipeline,
  and invokes `process.exit` in `amon-agents/src/core/run-agent.ts:20-60`.
- `runCommand` creates task/run identifiers and maps CLI arguments into
  `runPipeline` in `amon-agents/src/commands/run.ts:30-76`.
- The actual sequential orchestration is already concentrated in
  `amon-agents/src/core/pipeline.ts:62-191`.
- Agent execution is resolved through the registry in
  `amon-agents/src/agents/registry.ts:16-89`.
- Routing is loaded from YAML by
  `amon-agents/src/llm/router.ts:15-64`.

The current orchestration path is:

```text
CLI command
  -> runCommand
  -> runPipeline
  -> architect
  -> security
  -> qa
  -> ops/scorer
  -> local files
  -> unified Sentinel payload
  -> optional Sentinel HTTP push
```

The pipeline is therefore already separable from argument parsing, but it is not
yet a stable engine API. It accepts process-oriented primitives, returns an exit
code, writes directly to the current working directory, emits to a global file,
and imports the Sentinel Board adapter directly.

### 2.2 Current Sentinel Board runtime duplication

Sentinel Board contains a separate in-process agent execution path:

- `POST /api/agents/run` synchronously invokes a local agent in
  `sentinel-board/app/api/agents/run/route.ts:5-38`.
- The executor loads a local definition, builds prompts, calls a Board-local
  provider router, and parses output in
  `sentinel-board/lib/agents/run-agent.ts:7-38`.
- Sentinel defines its own `planner`, `frontend-builder`, `qa-reviewer`,
  `state-guardian`, and `backlog-analyzer` contracts in
  `sentinel-board/lib/agents/load-agent.ts:3-105`.
- Analyze mode calls this endpoint directly from
  `sentinel-board/components/console/dock/dock-workspace.tsx:268-335`.
- Backlog analysis calls the same endpoint from
  `sentinel-board/components/board/board-view.tsx:199-253`.

This Board-local path is not an orchestrator. It is one synchronous LLM request
per HTTP request and has no durable run, lifecycle, queue, artifacts, approvals,
tools, retries, or cancellation. It nevertheless duplicates canonical agent
identity, prompt construction, output contracts, provider routing, and execution.

Sentinel also has a read-only runtime projection that polls AMON's NDJSON file:

- `sentinel-board/app/api/runtime/events/route.ts:1-13` explicitly reads events
  without executing commands.
- It assumes a sibling AMON repository when `AMON_EVENTS_PATH` is absent in
  `sentinel-board/app/api/runtime/events/route.ts:119-125`.
- It reconstructs transient run and agent snapshots instead of reading durable
  engine run state.

The existing import endpoint is only a handshake:

- `sentinel-board/app/api/agents/import/route.ts:4-10` explicitly states that it
  does not persist.
- It validates only `externalTaskId`, logs summary fields, and returns success in
  `sentinel-board/app/api/agents/import/route.ts:27-63`.

This means the current AMON push can report delivery success without creating a
durable Board task.

### 2.3 Current data ownership evidence

Sentinel Board already persists projects, tasks, checklists, comments, and Board
timeline events. Its task schema is in
`sentinel-board/lib/db/schema.ts:28-140`. It has no durable runtime tables for
runs, engine events, artifacts, approvals, providers, tools, jobs, or workers.

AMON Agents currently owns:

- Agent and task type definitions in `amon-agents/src/core/types.ts:6-20`.
- Agent results in `amon-agents/src/core/types.ts:93-116`.
- Routing in `amon-agents/core/routing.yaml`.
- Agent executors in `amon-agents/src/agents/registry.ts`.
- Provider execution in `amon-agents/src/llm/call-llm.ts`.
- Runtime events in `amon-agents/src/events/types.ts:29-104`.
- Local result and unified-card artifacts in
  `amon-agents/src/core/pipeline.ts:41-52,160-176`.

## 3. Goals

- Make orchestration callable without invoking the CLI or terminating a process.
- Establish AMON Agents as the only generic agent execution runtime.
- Keep Sentinel Board responsible for human workflow, prioritization, assignment,
  approval UX, and presentation.
- Preserve current working behavior and formats during migration.
- Allow CLI, Sentinel Board, a scheduler, and future clients to invoke the same
  engine contract.
- Preserve final human authority for consequential actions.
- Create a boundary that can later support durable runs, tools, workers, and
  asynchronous transports without requiring those systems now.

## 4. Non-goals

This decision does not implement or require:

- A daemon, HTTP server, queue, worker pool, or scheduler.
- Parallel agent execution.
- New agents or workers.
- Claude, Codex, JEV, or any new provider.
- Tool execution.
- A new database in AMON Agents.
- Immediate removal of the CLI.
- Immediate removal of Sentinel Board's local agent endpoint.
- Immediate persistence changes in Sentinel Board.
- A redesign of prompts, routing, provider behavior, or output contracts.
- A rewrite of `runPipeline`.

## 5. Architectural boundary

### 5.1 Sentinel Board responsibilities

Sentinel Board is the human control plane. It owns:

- Creation, prioritization, assignment, and Kanban state of human-visible tasks.
- Project/workspace context and access control.
- Presentation of runs, events, artifacts, evidence, and failures.
- Human approval and rejection UX, including authenticated actor identity.
- Mapping engine state into Board-native views, comments, checklists, and timeline.
- Board-specific features such as HEO Copilot when they are not generic agent
  orchestration.

Sentinel Board must not own:

- Generic agent definitions or execution contracts.
- Task-to-agent routing.
- Generic provider selection for engine runs.
- Tool registries or tool invocation.
- Engine run state machines.
- Agent execution queues or workers.
- Canonical engine event or artifact schemas.

### 5.2 AMON Agents Engine responsibilities

AMON Agents Engine owns:

- Acceptance and validation of execution requests.
- Creation and identity of runs.
- Planning and routing by required capability.
- Policy and governance evaluation.
- Agent definitions, capabilities, and execution.
- Provider selection and invocation for engine work.
- Future tool selection and invocation.
- Run state transitions, cancellation semantics, and terminal outcomes.
- Canonical runtime events and evidence.
- Artifact production and integrity metadata.
- Approval gates and enforcement of decisions supplied by the control plane.

### 5.3 CLI responsibilities

The CLI is an adapter. It owns:

- Argument parsing and terminal output.
- Loading developer-local environment configuration.
- Invoking the Engine API.
- Mapping engine outcomes to process exit codes.
- Diagnostic and administrative commands.

The CLI must not own:

- Run ID generation policy beyond requesting or displaying an engine run ID.
- Agent routing or execution order.
- Run state transitions.
- Sentinel-specific delivery decisions.
- Process-global orchestration state.

## 6. Minimum engine extraction

### 6.1 Required extraction

The minimum extraction is a public, in-process engine facade with **one**
execution function. No other engine methods are exposed in Stage 1. Publishing
an interface shape is itself a contract; consumers will build against whatever
appears, so the initial surface must not advertise capabilities the engine
cannot enforce.

The first implementation exports exactly:

```ts
export function execute(request: ExecuteTaskRequest): Promise<RunResult>;
```

Explicitly deferred (do **not** ship in Stage 1, not even as `throw` stubs, not
even as unimplemented interface members):

- `getRun` — requires a durable `RunStore` that does not exist yet.
- `listEvents` — the current NDJSON feed remains the compatibility bridge.
- `getArtifact` — requires an artifact store and identity model.
- `submitApproval` — requires an approval state machine and attested actor
  identity.

These reappear as first-class API only at Stage 4 (run state) and Stage 5
(transport), when their semantics exist. They must not be simulated through
new duplicate state in Sentinel Board.

The current `runPipeline` should become an internal implementation detail or be
adapted behind this facade. Its first behavior-preserving evolution is:

```text
runPipeline(params): Promise<number>

becomes internally callable as:

execute(request, dependencies): Promise<RunResult>

CLI mapping:
RunResult.status completed -> exit 0
RunResult.status blocked/failed/cancelled -> non-zero exit
```

This is the smallest meaningful boundary because returning only an exit code does
not expose run identity, state, evidence, artifacts, or approval requirements to
non-CLI callers.

### 6.2 Dependencies, not a framework

The engine facade should accept a small dependency object rather than introducing
a service container. **In Stage 1 the only injected seam is `ResultSink`** —
because that is the coupling the current pipeline actually violates (it imports
the Sentinel adapter directly). All other seams (`RunStore`, `EventSink`,
`ArtifactStore`, clock/id generators) are deferred until the stage that needs
them:

```ts
// Stage 1
export interface Stage1EngineDependencies {
  resultSinks?: ResultSink[]; // default: [] — no implicit Sentinel dependency
}
```

Stage 1 default: `resultSinks = []`. The existing Sentinel push is added only
when `AMON_AGENTS_PUSH_TO_SB === "true"`, matching current behavior exactly.

Later stages will introduce, in order:

- Stage 3: `EventSink` (wraps the existing NDJSON emitter), `ArtifactStore`
  (wraps the existing JSON output paths).
- Stage 4: `RunStore` (introduces durable run state), `Clock`, `IdGenerator`.
- Stage 5: Transport DTO mapping; no new domain seams.

Introducing all seams up front would encode Stage 4/5 shape into Stage 1 and
force the extraction to become a rewrite.

### 6.3 Process lifecycle to remove from orchestration

The following behavior belongs outside the engine:

| Current behavior | Current location | Target owner |
|---|---|---|
| Read `process.argv` | `src/cli/amon.ts`, `src/core/run-agent.ts` | CLI adapter |
| Load `.env.local` | CLI/direct runner | Composition root |
| Call `process.exit` | `src/cli/amon.ts`, `src/core/run-agent.ts` | CLI adapter |
| Map result to exit code | `src/commands/run.ts`, pipeline return value | CLI adapter |
| Print operational logs | CLI, commands, pipeline | CLI/log adapter |
| Generate a second run ID | `src/commands/run.ts` | Engine once per run |
| Resolve paths from `process.cwd()` | router, agents, pipeline, events | Config/path adapter |
| Decide whether to push to Sentinel | pipeline/env | Result sink configuration |
| Push directly to Sentinel | `src/core/pipeline.ts` | Sentinel result sink |

The engine must not call `process.exit`, parse command-line arguments, assume a
current working directory, or require Sentinel Board to complete a run.

### 6.4 Stage 1 boundary guardrails

Stage 1 must apply three guardrails at the facade before delegating to the
existing pipeline. These do not modify `runPipeline`; they close the seams that
would otherwise turn known defects into public engine behavior. Rationale is
tracked in §14.

1. **Task ID safety.** Reject any `task.id` that does not match
   `/^[A-Za-z0-9_-]{1,64}$/`. Prevents path traversal via `${taskId}`
   filepaths in the current pipeline and push command. The pipeline itself is
   left unchanged; sanitization lives at the boundary so the behavior of a
   compliant `taskId` is byte-for-byte identical.

2. **State Guardian mock fail-open prevention.** If
   `AMON_AGENTS_ALLOW_MOCK_FALLBACK === "true"`, refuse to execute any request
   whose routing includes the `security` (State Guardian) agent. The current
   mock deterministically returns `verdict: "APPROVED"`; letting it substitute
   for a failing provider on the policy path would silently publish "policy
   rubber-stamped by mock" as engine behavior.

3. **`NEEDS_REVIEW` cannot be `completed`.** After `runPipeline` returns, if
   the State Guardian verdict is `NEEDS_REVIEW`, coerce
   `RunResult.status = "blocked"` with `EngineError.code = "APPROVAL_REQUIRED"`.
   An LLM label is not an authenticated human decision (§14.6); until real
   approval semantics exist (Stage 4), NEEDS_REVIEW must not present as done.

These guardrails are the entire safety delta of Stage 1. They do not depend on
new stores, transports, or persistence.

## 7. Existing modules to preserve

The following modules can remain unchanged during the first extraction or be
wrapped without changing their behavior:

| Module | Preserve because |
|---|---|
| `src/agents/planner.ts` | Existing planner behavior and contract |
| `src/agents/state-guardian.ts` | Existing policy review behavior |
| `src/agents/qa-reviewer.ts` | Existing QA review behavior |
| `src/agents/scorer.ts` | Existing scoring behavior |
| `src/agents/registry.ts` | Existing executor lookup and context |
| `src/prompts/*.ts` | Existing prompts |
| `src/llm/call-llm.ts` | Existing provider integrations |
| `src/llm/router.ts` | Existing YAML route lookup, initially behind configured paths |
| `src/core/normalize-output.ts` | Existing normalization behavior |
| `src/core/validate-json.ts` | Existing validation behavior |
| `src/utils/clean-json.ts` | Existing response parsing behavior |
| `src/events/event-emitter.ts` | Existing NDJSON sink implementation |
| `src/adapters/sentinel-board.ts` | Existing payload mapping and delivery adapter |
| `core/*.yaml` | Existing declarative configuration |

Preservation does not imply that known audit findings are accepted permanently.
Contract validation, mock security fallback, task ID safety, path resolution,
provider metrics, and Sentinel delivery semantics remain separate correctness work.
They should not be mixed into the boundary extraction unless required to avoid
codifying an unsafe public contract.

The modules that require boundary changes are limited primarily to:

- `src/core/pipeline.ts`, to return a domain result and receive side-effect seams.
- `src/commands/run.ts`, to invoke the engine rather than own run creation.
- `src/core/run-agent.ts`, to remain a thin CLI/direct-execution adapter.
- A new public package entrypoint, because `package.json` currently advertises
  `dist/index.js` while no `src/index.ts` exists.

## 8. Proposed public Engine API

### 8.1 Core identifiers and request

Stage 1 keeps the request DTO minimal. Anything not consumed by the current
pipeline is deferred until the stage that actually implements the corresponding
semantics.

```ts
// Stage 1 (what actually ships)
export type TaskId = string;
export type RunId = string;

export interface ExecuteTaskRequest {
  task: TaskSnapshot;
  requestedBy: ActorRef;
}

export interface TaskSnapshot {
  id: TaskId;                    // must match /^[A-Za-z0-9_-]{1,64}$/
  source: "sentinel-board" | "cli" | string;
  type: string;
  description: string;
  repo?: string;                 // kept as string; RepositoryRef deferred
  playbook?: string;
}

export interface ActorRef {
  type: "human" | "service";
  id: string;
  displayName?: string;
}
```

Explicitly deferred from Stage 1 (do not add fields, types, or IDs before
their consumer exists):

- `ArtifactId`, `ApprovalId` — introduced with their respective stores.
- `ExecutionContext` (`correlationId`, `parentRunId`, `workspaceSlug`,
  `projectSlug`) — no consumer in Stage 1.
- `requestedCapabilities`, `idempotencyKey`, `delivery`
  (`DeliveryPreference[]`) — no consumer in Stage 1; would encode
  scheduler/mobile hypotheticals.
- `TaskSnapshot.title`, `priority`, `constraints`, `metadata`, `revision` — not
  read by the current pipeline. `revision`/snapshot integrity is a Stage 4
  concern (§15).
- `RepositoryRef`, `ProjectRef` — Sentinel has no exposed
  project→repo mapping today; `repo?: string` is sufficient.

`TaskSnapshot` is an immutable execution input. The engine does not become the
system of record for Board task title, priority, assignment, or Kanban state.

### 8.2 Run result

Stage 1's synchronous pipeline can only produce terminal states. Publishing a
status the engine cannot enforce (e.g. `awaiting_approval` with no store to
pause in) would let consumers render states AMON never emits.

```ts
// Stage 1 RunStatus — closed set
export type RunStatus = "completed" | "blocked" | "failed";

export interface RunResult {
  runId: RunId;
  taskId: TaskId;
  status: RunStatus;
  startedAt: string;
  endedAt: string;
  agentResults: AgentExecutionResult[];
  errors: EngineError[];
}
```

Deferred from Stage 1 (each returns when its enabling stage lands):

- `"accepted" | "planning" | "running"` — Stage 4, when the engine can report
  non-terminal transitions.
- `"awaiting_approval"` — Stage 4, when a real approval store can pause a run.
- `"cancelled"` — with cancellation/`AbortSignal` support (§15).
- `RunResult.artifacts: ArtifactRef[]` — Stage 3/4, when the artifact store and
  identity model exist.
- `RunResult.approvals: ApprovalRequestRef[]` — Stage 4 with the approval API.
- `RunResult.summary` — added when a canonical summary shape is agreed.

The API will grow additively; Stage 1 consumers see only the closed enum above
and must not switch on values not present in it.

### 8.3 Agent, evidence, and errors

Stage 1 advertises only fields it can populate. `AgentExecutionResult.valid`
reflects the current guardian shape check; it does not yet indicate semantic
non-emptiness (§14.8).

```ts
// Stage 1
export interface AgentExecutionResult {
  agentId: string;
  capability: string;
  status: "completed" | "blocked" | "failed" | "skipped";
  startedAt: string;
  endedAt: string;
  valid: boolean;
  output?: unknown;
  errors?: EngineError[];
  metrics?: UsageMetrics; // Stage 1: only durationMs populated
}

export interface EngineError {
  code: EngineErrorCode; // see closed taxonomy below
  message: string;
  agentId?: string;
  details?: Record<string, unknown>;
}

// Stage 1 closed error taxonomy — additive-only after this
export type EngineErrorCode =
  | "INVALID_TASK_ID"
  | "APPROVAL_REQUIRED"
  | "POLICY_BLOCKED"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_UNAVAILABLE"
  | "SENTINEL_UNAVAILABLE"
  | "PIPELINE_INCOMPLETE"
  | "UNKNOWN";

export interface UsageMetrics {
  durationMs?: number; // Stage 1
  // Deferred: promptTokens, completionTokens, totalTokens, provider, model
  // — not currently propagated from callLLM to pipeline; advertising them
  // before propagation would create a hollow contract.
}
```

Deferred from Stage 1:

- `EngineError.retryable` — no retry policy exists yet.
- `UsageMetrics.{promptTokens,completionTokens,totalTokens,provider,model}` —
  the LLM response usage is currently discarded in the pipeline; add these
  fields only after `callLLM.usage` is threaded through.
- `AgentExecutionResult.artifactIds` — introduced with the artifact store.

### 8.4 Events

**Stage 1 makes no changes to the NDJSON event schema.** The existing
`AmonEvent` shape and file layout are preserved so current readers (including
Sentinel's runtime projection) continue to work unchanged. No `version` field
is introduced in Stage 1; a versioned `EngineEvent` type appears only when the
first breaking change is actually required (Stage 4+).

Canonical run identity rules for Stage 1:

- The engine mints one canonical `runId` inside `execute()`. Pipeline, agents,
  artifacts, and delivery events for a single execution share this ID.
- The CLI's **command envelope** (`command.started` / `command.done` emitted by
  `withCommandEvents` in `src/events/event-emitter.ts`) is a **separate**
  identity concern and must be preserved. It wraps CLI-only commands such as
  `doctor`, `audit`, and `scan`, none of which have an engine run. Sentinel's
  runtime projector already handles the two-runId shape for those commands.
- Only the second `newRunId()` calls inside `commands/run.ts` and
  `core/run-agent.ts` are removed — the CLI envelope runId is kept.

NDJSON concurrency remains best-effort intra-line (`appendFile` unlocked).
Canonical run ordering will live in `RunStore` from Stage 4 onward (§15).

### 8.5 Artifacts — deferred beyond Stage 1

`ArtifactRef` (and any `ArtifactId`, `sha256`, `mediaType`, `uri`, `producer`,
`metadata` fields) is **not** part of the Stage 1 public API. The current
per-agent JSON files and the unified Sentinel JSON continue to be written to
disk exactly as today, but they are not surfaced through `RunResult` yet.

`ArtifactRef` returns in Stage 3 (behind an `ArtifactStore` seam) and gains
integrity/identity fields in Stage 4/5, when a store, addressing scheme, and
redaction policy exist. Publishing content-addressed identity before there is a
store forces speculative design.

Raw provider output (`AgentResult.rawResponse`) redaction is tracked as a
separate correctness item in §15; it must be resolved before Stage 5 exposes
artifacts remotely.

### 8.6 Approval — deferred beyond Stage 1

The approval API (`ApprovalRequestRef`, `ApprovalDecision`, `ApprovalId`,
`submitApproval`, `expectedRunVersion`) is **not** part of the Stage 1 public
API. It requires a run/approval store and an attested actor identity model,
neither of which exist yet.

Stage 1 preserves the human-authority boundary through guardrail 3 (§6.4):
a State Guardian `NEEDS_REVIEW` verdict is coerced to
`RunResult.status = "blocked"` with `EngineError.code = "APPROVAL_REQUIRED"`.
This blocks the run without pretending an approval subsystem exists.

Full approval semantics land in Stage 4, at which point:

- An LLM verdict remains distinct from an authenticated human decision (§14.6).
- `NEEDS_REVIEW` transitions the run to `awaiting_approval`.
- The engine will not continue a consequential action until it receives a
  valid, attested decision from the control plane.
- Approval decision authenticity (nonce/attestation binding a decision to its
  request) and non-reliance on loopback authentication are tracked in §15.

## 9. Sentinel Board to Engine contract

### 9.1 Logical operations

The transport-neutral contract is:

| Direction | Operation | Purpose |
|---|---|---|
| Board -> Engine | `execute(request)` | Start one run from a task snapshot |
| Board -> Engine | `getRun(runId)` | Read canonical run state |
| Board -> Engine | `listEvents(query)` | Incrementally consume runtime events |
| Board -> Engine | `getArtifact(id)` | Resolve evidence or generated output |
| Board -> Engine | `submitApproval(decision)` | Resume or stop an approval-gated run |
| Engine -> Board | Event delivery or polling | Project execution state into UI |
| Engine -> Board | Result delivery | Attach final summary/artifact references |
| Engine -> Board | Approval request | Ask for authenticated human decision |

The first implementation may expose only the in-process TypeScript API to the
CLI. A later HTTP or message transport should be a thin adapter over the same
types, not a second engine implementation.

### 9.2 Task submission semantics

- Sentinel supplies its stable task ID and task revision.
- AMON creates and returns the run ID.
- Repeated submissions with the same idempotency key return the same accepted run
  or a defined conflict, not a second execution.
- Sentinel task edits after submission do not mutate an active run's snapshot.
- A new execution uses a new run and a new snapshot revision.
- Submission acceptance is distinct from successful completion.

### 9.3 Run and event semantics

- AMON is authoritative for run state.
- Events are append-only facts, not the sole durable run model in the target.
- Events carry a stable run ID and monotonic sequence when durable state exists.
- Sentinel may persist a projection for UI performance but must not invent engine
  transitions absent a canonical event or run response.
- Polling the shared filesystem is a compatibility bridge, not the final API.

### 9.4 Result and artifact semantics

- Engine completion returns artifact references and a bounded summary.
- Sentinel stores Board presentation and links, not provider raw responses by
  default.
- Artifact access must be authorized and integrity-verifiable.
- Sentinel comments/checklists may be derived from engine results but remain
  Board-native presentation records.

### 9.5 Approval semantics

- AMON evaluates policy and creates approval requests.
- Sentinel authenticates the human, displays evidence, records the decision, and
  submits it to AMON.
- AMON validates that the request is pending and the run version is current.
- Approval is scoped to a specific action and run, not a blanket task approval.
- Rejection is terminal for the gated action unless a new run is created.
- Deploy, merge, destructive repository changes, credential use, and other
  consequential actions require explicit policy classification and human control.

### 9.6 Compatibility with current Sentinel import

`POST /api/agents/import` is currently Engine-to-Board result delivery, not
Board-to-Engine execution. It may remain as a compatibility sink while the new
boundary is introduced, subject to these corrections in a separate change:

- A success response must mean the payload was durably persisted.
- The response must return the persisted Board task/card identifier.
- Delivery must be idempotent by external task and run identity.
- Project mapping and authentication must be explicit.
- The current token-name mismatch between AMON's
  `SENTINEL_BOARD_AGENT_TOKEN` and Sentinel's `SENTINEL_API_TOKEN` must be
  resolved without silently weakening authentication.

## 10. Ownership model

| Entity | Canonical owner | Other system responsibility |
|---|---|---|
| Task | Sentinel Board | AMON consumes an immutable task snapshot; CLI-created tasks use an external/client-owned ID until represented in Board |
| Run | AMON Agents Engine | Sentinel projects state and links the run to a task |
| Agent | AMON Agents Engine | Sentinel displays identity/capability and must not redefine execution behavior |
| Event | AMON Agents Engine | Sentinel consumes and may persist a read model; Board UI events remain a separate presentation domain |
| Artifact | AMON Agents Engine | Sentinel stores references, previews, and task associations; storage may be delegated but lifecycle/schema remain engine-owned |
| Approval | Sentinel Board for authenticated human decision; AMON for request and enforcement | Both share one approval ID and immutable audit data; an engine cannot self-approve |
| Provider | AMON Agents Engine for agent execution | Sentinel may retain providers only for clearly Board-local Copilot features |
| Tool | AMON Agents Engine | Sentinel requests capabilities and displays evidence; it does not execute generic tools |

The split ownership of Approval is intentional and bounded. AMON owns the gate
that prevents execution. Sentinel owns the human authority and decision record.
Neither side can complete approval alone.

## 11. Treatment of Sentinel Board's duplicate runtime

### 11.1 Decision

Do not move Sentinel's local runtime into AMON and do not build a shared third
runtime. AMON Agents remains canonical. Sentinel's generic local agent path is a
temporary compatibility implementation to be strangled after delegation exists.

**Freeze rule (effective immediately, independent of Stage 1 implementation
timing):** Sentinel's `POST /api/agents/run`, `lib/agents/run-agent.ts`, and
`lib/agents/load-agent.ts` are frozen. No new agents, providers, tools, run
state, queues, retries, or generic orchestration behavior may be added there.
Bug fixes and Board-native UX iteration (Analyze, Backlog) remain permitted.
Any new generic capability must land in AMON Agents behind the engine facade.

### 11.2 What must migrate to AMON ownership

- Generic agent execution now implemented by
  `sentinel-board/lib/agents/run-agent.ts`.
- Generic definitions overlapping planner, QA, and state guardian in
  `sentinel-board/lib/agents/load-agent.ts`.
- Generic prompt/output contracts in `sentinel-board/lib/agents/`.
- Generic provider routing when used by `/api/agents/run`.

### 11.3 What remains in Sentinel

- Analyze and backlog UX.
- Human confirmation before creating or promoting cards.
- Mapping an engine result to the current UI response shape during migration.
- Heuristic fallback only if explicitly retained as a Board UI behavior, clearly
  labeled as non-engine output.
- Board-specific `backlog-analyzer` product behavior until an explicit AMON
  capability and contract are designed.
- Board-specific HEO Copilot provider use, provided it is not presented as AMON
  orchestration.

### 11.4 Transition rule

`POST /api/agents/run` may remain temporarily, but its implementation should
eventually become a delegation adapter:

```text
Sentinel UI
  -> POST /api/agents/run (compatibility route)
  -> Engine client execute/getRun
  -> map Engine response to existing UI DTO
```

The route must not gain its own run table, queue, tool registry, approval engine,
or additional generic providers while this transition is pending.

## 12. Staged migration plan

### Stage 0: Freeze and characterize

- Record current CLI flags, exit codes, output paths, event shapes, agent names,
  Sentinel payloads, and environment variables as compatibility fixtures.
- Add no new orchestration behavior to Sentinel's local agent runtime.
- Treat known correctness/security findings as tracked constraints, not reasons to
  rewrite the pipeline during extraction.

Exit criterion: current observable behavior is documented sufficiently to detect
accidental regressions.

### Stage 1: Add the in-process Engine API (safety-first, minimal surface)

- Add a public `src/index.ts` exporting **only**
  `execute(request: ExecuteTaskRequest): Promise<RunResult>`.
  No `AmonEngine` interface, no other methods, no stubs.
- Types shipped are exactly those in §8.1 (Stage 1), §8.2 (three-value
  `RunStatus`), §8.3 (Stage 1 fields), and §8.4 (no schema change).
- Generate one canonical `runId` inside `execute()`. Remove the second
  `newRunId()` calls in `commands/run.ts` and `core/run-agent.ts`. Keep the
  CLI command-envelope runId in `cli/amon.ts` — it is a distinct concern
  (§8.4) and Sentinel's projector depends on it for `doctor`/`audit`/`scan`.
- Delegate internally to `runPipeline` unchanged; map its return code to
  `status`.
- Apply the three boundary guardrails from §6.4 before delegation:
  - Reject unsafe `task.id` (`INVALID_TASK_ID`).
  - Refuse to run when `AMON_AGENTS_ALLOW_MOCK_FALLBACK === "true"` and the
    routing includes `security`.
  - Coerce `NEEDS_REVIEW` to `blocked` + `APPROVAL_REQUIRED`.
- Introduce a single injected seam: `resultSinks?: ResultSink[]`, defaulting
  to `[]`. Sentinel push is added only when `AMON_AGENTS_PUSH_TO_SB === "true"`.
- Do not modify NDJSON schema, per-agent JSON paths, unified Sentinel payload,
  or the `sentinel-board.ts` adapter internals.
- Do not touch Sentinel Board.

Exit criterion: a TypeScript caller can `execute(request)` without
`process.argv`, CLI dispatch, or `process.exit`; observable CLI output, exit
codes, NDJSON, and Sentinel push are byte-for-byte compatible when the three
guardrails do not trigger; each guardrail is covered by a unit test.

This is the minimum first implementation step. It is tracked as ticket
`AA-SEC-001` (Stage 1 safety prerequisites) — see §18.

### Stage 2: Make CLI a pure adapter

- Change `amon run` and direct runner to call `AmonEngine.execute()`.
- Map `RunResult` to existing logs and exit codes.
- Preserve all current CLI commands, flags, aliases, and output locations.
- Remove the duplicate command-level/pipeline-level run ID for execution events.

Exit criterion: no orchestration decision is made in CLI command modules.

### Stage 3: Isolate side effects behind existing adapters

- Wrap event emission as `EventSink`.
- Wrap local JSON writes as `ArtifactStore`.
- Wrap Sentinel push as `ResultSink`.
- Make paths explicit engine configuration instead of implicit `process.cwd()`.
- Preserve NDJSON and JSON formats through compatibility adapters.

Exit criterion: engine orchestration can be tested with in-memory sinks and does
not require Sentinel availability or a specific working directory.

### Stage 4: Introduce canonical run state and approval pauses

- Add a minimal `RunStore` with explicit status transitions.
- Persist enough state to inspect terminal runs and safely represent
  `awaiting_approval`.
- Define approval request and decision validation.
- Do not add distributed workers until synchronous run semantics are stable.

Exit criterion: run state is not reconstructed solely from logs, and a human gate
can pause rather than merely label a run.

### Stage 5: Add a transport adapter for Sentinel

- Expose the Engine API through the smallest appropriate transport.
- Keep transport DTOs as mappings of the public engine types.
- Make Sentinel create a run from a Board task snapshot.
- Let Sentinel poll or subscribe to canonical run/events and display artifacts.
- Keep human approval in Sentinel and submit decisions to AMON.

Exit criterion: Sentinel can initiate and observe AMON work without shelling out,
reading sibling repository files, or executing a local generic agent.

### Stage 6: Strangle Sentinel's local generic runtime

- Redirect Analyze mode through the engine compatibility adapter.
- Redirect only capabilities that have an explicit AMON contract and parity.
- Preserve current human confirmation before card creation/promotion.
- Remove local overlapping definitions and execution only after consumers migrate.
- Retain Board-only Copilot or backlog behavior until separately classified.

Exit criterion: generic agent orchestration and execution occur only in AMON.

### Stage 7: Add asynchronous execution only when required

- Introduce queue/worker/lease/cancellation semantics behind the same Engine API.
- Keep run, event, artifact, and approval identities stable.
- Add scheduler and mobile consumers without bypassing the engine.

Exit criterion: process topology changes without changing domain ownership or
forcing CLI/Sentinel contract rewrites.

## 13. Backwards-compatibility requirements

The migration must preserve unless a separately approved breaking change says
otherwise:

- `amon` and `amon-agents` binaries.
- Existing CLI commands, flags, and positional argument behavior.
- Existing exit-code behavior during the initial facade extraction.
- Existing task type and agent identifiers.
- Current YAML configuration files and route order.
- Existing provider environment variables and provider behavior.
- Current per-agent JSON output locations and envelopes.
- Current unified Sentinel payload and local filename.
- Existing NDJSON event fields and readers.
- Existing `AMON_EVENTS_PATH` and event opt-out behavior.
- Current optional Sentinel push behavior.
- Legacy `amon push` support until an explicit deprecation window ends.
- Sentinel Analyze and backlog UI behavior until engine capability parity exists.
- Human confirmation before Board task creation or promotion.

Compatibility does not require preserving defects such as two run IDs for one
execution, false-positive delivery success, unsafe task IDs, or mock security
approval. Those require explicit migration notes because correcting them changes
observed behavior in beneficial but potentially breaking ways.

## 14. Architectural risks

### 14.1 Facade without real separation

A facade that merely re-exports `runPipeline` and its exit code would make the
package callable but would preserve CLI/process and Sentinel coupling. The first
API must return a domain result and own run identity.

### 14.2 Premature distributed architecture

Adding HTTP, queues, workers, or a new database before stabilizing the in-process
contract would multiply failure modes and encourage a rewrite. Transport follows
the engine boundary, not the reverse.

### 14.3 Dual runtime drift

If Sentinel's local agent runtime continues to gain agents, providers, tools, or
run state, contracts will diverge further. A temporary compatibility route must
not become a second permanent engine.

### 14.4 Shared database coupling

AMON must not obtain direct access to Sentinel's Board tables as a shortcut. The
systems have distinct ownership and should exchange contracts, not internal DB
schemas.

### 14.5 Event log treated as state database

The current NDJSON file is useful evidence and a compatibility feed, but lacks
transactions, retention, indexing, and robust concurrency. It must not become the
only source of truth for approvals or resumable runs.

### 14.6 Approval ambiguity

State Guardian's `APPROVED`, `BLOCKED`, and `NEEDS_REVIEW` are policy review
outputs, not authenticated human decisions. Conflating them would violate the
human-authority requirement.

### 14.7 Artifact and secret exposure

Current agent files retain raw provider responses. Exposing these directly to
Sentinel or mobile consumers may leak sensitive task or provider data. Artifact
authorization and redaction need an explicit policy before remote access.

### 14.8 Existing correctness defects becoming API guarantees

Known issues include validation after coercion, mock fail-open behavior, unsafe
task IDs, ignored provider usage, direct filesystem writes, and swallowed
Sentinel failures. Compatibility fixtures must distinguish intentional behavior
from defects that must not become permanent contracts.

### 14.9 Capability mismatch

Sentinel currently has `frontend-builder` and `backlog-analyzer`; AMON currently
has unimplemented `designer` and `dev` roles. Names must not be equated without a
capability mapping and output contract.

## 15. Unresolved decisions and deferred correctness work

### 15.1 Open architectural questions

- Which transport should Sentinel use after the in-process API: HTTP, message
  queue, local sidecar, or another deployment-specific adapter?
- Where will canonical durable run state live when Stage 4 begins?
- Will AMON store artifact bodies, or only metadata pointing to object/file
  storage?
- What is the minimum approval policy taxonomy for merge, deploy, destructive
  changes, credentials, and external side effects?
- Which Sentinel-local behaviors are Board-specific Copilot features versus
  generic AMON capabilities?
- How should `backlog-analyzer` map to an engine capability without moving Board
  product logic into AMON?
- How are repository credentials and workspace access delegated to future tools?
- What is the idempotency key and revision policy for Board task resubmission?
- Should final result delivery continue through `/api/agents/import`, or should
  Sentinel derive results entirely from run/artifact APIs?
- How will old NDJSON events and legacy per-agent Board artifacts be versioned and
  retired?

### 15.2 Deferred correctness work (must be resolved before the stage that needs them)

These items are explicitly out of scope for Stage 1 but are required for later
stages. Each is a tracked constraint, not an accepted defect.

- **Authenticated approval identity must not rely on localhost.** Sentinel's
  request guard currently short-circuits on loopback. Before Stage 5, the
  boundary must define "authenticated" as an authenticated actor, not merely a
  local host, and remove the loopback bypass from any approval-facing route.
- **Approval decision authenticity/attestation.** Before Stage 4 approvals
  ship, bind each `ApprovalDecision` to its `ApprovalRequest` cryptographically
  (engine-issued nonce echoed by Sentinel with the decision), so a compromised
  transport cannot inject decisions or forge `decidedBy`.
- **Per-capability provider policy.** The State Guardian and other
  policy-relevant capabilities must be able to pin a provider distinct from the
  global `AMON_AGENTS_PROVIDER` and refuse mock fallback. Required before Stage
  4 approval semantics rely on the guardian's verdict.
- **NDJSON concurrency limitation.** `appendFile` is unlocked; concurrent
  writers may interleave lines. Canonical run ordering moves to `RunStore` in
  Stage 4; NDJSON remains a best-effort compatibility feed only.
- **Sentinel projection schema requirement.** Stage 5's exit criterion requires
  Sentinel to hold projection tables (`runs`, `run_events`, `approvals`) so it
  no longer reads AMON's NDJSON file directly. This is Sentinel-side work and
  must be scheduled before Stage 5.
- **Cancellation / `AbortSignal`.** Stage 4 introduces an `AbortSignal`
  parameter on `execute()`; Stage 7 wires it to the transport. Retrofitting
  cancellation to an uncooperative synchronous pipeline is expensive — plan
  the seam before Stage 4 lands.
- **Closed `EngineErrorCode` taxonomy.** The Stage 1 set is defined in §8.3.
  Additions are additive-only and require an ADR amendment.
- **Task snapshot integrity.** Before Stage 4, `TaskSnapshot` gains a required
  `revision` (or `snapshotHash`) that the engine stores with the run so
  Sentinel-side edits after submission cannot silently mutate an in-flight
  run's input.
- **Raw provider output redaction.** `AgentResult.rawResponse` is written to
  the per-agent JSON. Before Stage 5 exposes artifacts remotely, define a
  redaction/retention policy and strip `rawResponse` from any publicly served
  artifact.
- **Sentinel token env-name mismatch is separate correctness work.** AMON
  sends `SENTINEL_BOARD_AGENT_TOKEN`; Sentinel reads `SENTINEL_API_TOKEN`. This
  must be resolved without silently weakening authentication (§9.6), but it is
  a standalone fix — do **not** fold it into the Stage 1 extraction, where it
  would hide behavior changes.
- **Semantic (non-empty) output validation for State Guardian.** Current
  validation checks shape only; a normalized-empty output can pass. This must
  land alongside or before Stage 4 approval semantics rely on the verdict.
- **Phantom Sentinel delivery.** `/api/agents/import` today returns `ok:true`
  without persisting; the current adapter treats any 2xx as delivered. Any
  future `SentinelResultSink` that surfaces "delivered" through `RunResult`
  must first depend on persistence and return the persisted Board task ID.

## 16. Consequences

### Positive

- One canonical orchestration runtime.
- CLI and Sentinel become interchangeable consumers of the same engine behavior.
- Existing working agent/provider code is preserved.
- Future queue, scheduler, and mobile consumers can be added behind a stable
  contract.
- Human approval becomes a first-class boundary rather than an LLM label.
- Sentinel can focus on control-plane UX and durable human workflow.

### Negative

- A temporary period of dual execution paths remains in Sentinel.
- Compatibility adapters add explicit interfaces around currently direct calls.
- Run and approval persistence require a later storage decision.
- Some current behavior cannot be preserved indefinitely because it is unsafe or
  reports false success.

## 17. End report

### Files changed

- `docs/architecture/ARCH-001-AMON-ENGINE-BOUNDARY.md`

### Architectural recommendation

Establish AMON Agents as the single engine through a small in-process
`AmonEngine` facade. Keep orchestration, agents, providers, policy, run state,
events, artifacts, and future tools in AMON. Keep tasks, Kanban, human approval
UX, and runtime projections in Sentinel Board. Treat CLI and Sentinel as adapters.

### Minimum first implementation step

Add a public `execute(ExecuteTaskRequest): Promise<RunResult>` function (single
free function, no `AmonEngine` interface) that creates one canonical engine run
ID, delegates to the existing pipeline, applies the three §6.4 boundary
guardrails, returns the Stage 1 `RunResult` shape, and can be called without
`process.argv` or `process.exit`. Change no execution behavior in that first
step beyond eliminating duplicate engine run identity and enforcing the
guardrails. The CLI command-envelope runId is preserved.

### Risks

- A facade may preserve hidden process and filesystem coupling.
- Sentinel's temporary runtime may continue to drift.
- Existing defects may accidentally become public compatibility guarantees.
- Approval ownership can become ambiguous without one shared approval ID.
- Remote artifact/event access can expose sensitive raw output.
- Premature queue or transport work can turn an extraction into a rewrite.

### Unresolved decisions

- Transport and deployment topology between Sentinel and AMON.
- Durable run-state and artifact storage.
- Approval policy taxonomy and identity model.
- Capability mapping for Sentinel-only agents.
- Event/artifact retention and redaction.
- Idempotency and task revision semantics.
- Long-term role of `/api/agents/import`.

## 18. Recovery checkpoint — 2026-09-30

- **Architecture status:** recovered and accepted. This ADR is the canonical
  boundary between AMON Agents and Sentinel Board. Verdict from the 2026-09-30
  adversarial review: ACCEPT_WITH_CHANGES; all accepted changes are applied
  above (Stage 1 API reduced to `execute()` only, Stage 1 `RunStatus` reduced
  to `completed | blocked | failed`, speculative contracts postponed, three
  boundary guardrails recorded in §6.4, command-envelope identity preserved,
  deferred correctness work listed in §15.2, Sentinel's duplicate runtime
  frozen per §11.1).
- **Implementation status:** implementation has **NOT** started. No code in
  `amon-agents` or `sentinel-board` has been modified as part of this
  checkpoint. Only this document changed.
- **Next implementation ticket when work resumes:** `AA-SEC-001` — Stage 1
  safety prerequisites. Scope is exactly §12 Stage 1 and §6.4 guardrails
  (single-function `execute()` facade, canonical engine `runId`, three
  guardrails, `ResultSink` seam with empty default). No other stage begins
  before `AA-SEC-001` ships and its exit criterion is met.
- **Pause reason:** AMON Agents development is intentionally paused while
  AMON ERP is prioritized. The freeze in §11.1 remains in effect during the
  pause: Sentinel's local generic runtime accepts no new agents, providers,
  tools, or orchestration behavior; bugfixes and Board-native UX (Analyze,
  Backlog) are still permitted.
- **Resumption preconditions:** before `AA-SEC-001` starts, confirm no drift
  in Sentinel's `lib/agents/` and `app/api/agents/run/`, confirm the token
  env-name mismatch (§15.2) has not been silently "fixed" in a way that
  weakens auth, and re-verify that the pipeline defects listed in §14.8 still
  match reality.
