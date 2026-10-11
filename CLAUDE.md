# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

**AMON Agents Engine** is a TypeScript-based agent orchestration system for AI-assisted software development. It's the runtime layer that standardizes how AI agents (planner, state-guardian, qa-reviewer, scorer) work within the AMON ecosystem.

- **Role in ecosystem:** Core orchestrator for amon-delivery, jarvis_sentinel, sentinel-board, and thebestburger-bot
- **Key principle:** "Humans direct. AI executes within explicit limits."
- **Entry point:** `amon` CLI (binaries in package.json: `amon` and `amon-agents`)
- **Configuration:** YAML-driven (`core/*.yaml` files are source of truth for agents, routing, rules)

## Development commands

```bash
npm run build              # Compile TypeScript to dist/
npm run dev               # Run agent pipeline via ts-node
npm run amon -- <cmd>     # Force this repo's amon CLI (safe alias if global amon exists)
npm test                  # Run vitest suite
npm run test:watch       # Watch mode
npm run test:coverage    # Coverage report
npm run typecheck        # TypeScript check without emitting
```

**Single test file:**
```bash
npx vitest src/path/to/file.test.ts
npx vitest src/path/to/file.test.ts -t "test name"  # Single test
```

**CLI usage (local development):**
```bash
npm run amon -- run --task TEST-001 --type feature_small "test task"
npm run amon -- status
npm run amon -- doctor
npm run amon -- worker
npm run amon -- worker-job --job JARVIS-004C --action prepare_worktree --repo <path> --branch worker/JARVIS-004C
npm run amon -- guardian-review --review GUARDIAN-004E --job JARVIS-004D-RUN-004
npm run amon -- ops-server --port 4785
```

## High-level architecture

```
amon CLI
    ↓
  run-agent.ts / commands/run.ts
    ↓
core/pipeline.ts (orchestrates agent flow)
    ├─ agents/planner.ts (architect role)
    ├─ agents/state-guardian.ts (security gating)
    ├─ agents/qa-reviewer.ts (quality checks)
    └─ agents/scorer.ts (ops scoring)
    ↓
llm/call-llm.ts (multi-provider: ollama, lmstudio, openai, gemini, openrouter, mock)
    ↓
adapters/sentinel-board.ts (unifies 4 results → 1 card)
    ↓
events/event-emitter.ts (NDJSON append-only stream)
```

**Key flow:**
1. CLI parses args, emits `run.started`
2. Pipeline reads `core/routing.yaml` to determine agent sequence for task type
3. Each agent: reads YAML config → builds prompt → calls LLM → validates against output contract
4. Results saved locally to `outputs/` (per-agent JSON files)
5. Unified card built and pushed to Sentinel Board (if enabled)
6. Events streamed to `~/.amon/events.jsonl` (or `AMON_EVENTS_PATH`)

## Critical source files

| File | Purpose |
|------|---------|
| `src/core/types.ts` | Canonical type definitions (AgentName, TaskType, StandardOutput, AgentResult) |
| `src/core/pipeline.ts` | Central orchestrator; reads routing.yaml, executes agent registry |
| `src/agents/registry.ts` | Static map of agent executors; throws if agent defined in routing but not implemented |
| `src/llm/router.ts` | Reads routing.yaml; maps task types → agent flows → output paths |
| `src/llm/call-llm.ts` | Multi-provider dispatcher; handles timeouts, sanitization, fallback |
| `src/core/validate-json.ts` | Validates agent outputs against `core/output-contract.yaml` |
| `src/cli/amon.ts` | CLI entry point with command dispatcher |
| `src/cli/parse-args.ts` | Argument parser (custom; not yargs/commander) |
| `src/events/event-emitter.ts` | Event stream logic; append-only NDJSON, sanitizes secrets |
| `core/*.yaml` | **Live configuration** (agents, routing, rules, contracts) — NOT auto-generated |

## Configuration-driven system

AMON is configuration-first. These YAMLs are the source of truth:

| File | Content |
|------|---------|
| `core/core-agents.yaml` | Agent missions, deliverables, constraints |
| `core/routing.yaml` | Task type → agent flow mapping (which agents execute for which task) |
| `core/global-rules.yaml` | Global constraints (human approval, audit, state rules) |
| `core/output-contract.yaml` | Required fields + types each agent output must have |
| `core/agent-ownership.yaml` | Scopes, approval flags, review requirements per agent |

**Important:** Changes to YAML affect pipeline behavior without code recompile. Router and validators read YAML at runtime.

## Modules overview

### `src/agents/`
- `planner.ts` — Architect role; receives task description, generates plan
- `state-guardian.ts` — Security gating; validates proposed changes vs. global rules
- `qa-reviewer.ts` — QA role; reviews plan for coverage, edge cases
- `scorer.ts` — Ops role; scores execution readiness
- `registry.ts` — Maps AgentName → executor function; validates against routing.yaml

### `src/commands/`
- `run.ts` — `amon run` command; wraps pipeline
- `audit.ts` — `amon audit --repo` for codebase analysis
- `scan.ts` — `amon scan --repo` for pattern/security checks
- `status.ts` — `amon status` for pipeline state
- `doctor.ts` — `amon doctor` for environment validation
- `push.ts` — Re-push card to Sentinel Board
- `history.ts` — List recent runs
- `worker.ts` — Worker Host MVP; local heartbeat
- `worker-job.ts` — Execute isolated worker job (inspect_repo, prepare_worktree, run_coding_tool)
- `guardian-review.ts` — Deterministic evidence gate on worker output
- `ops-server.ts` — Local HTTP server for ops snapshot bridge

### `src/core/`
- `pipeline.ts` — Main orchestrator
- `run-agent.ts` — Thin wrapper calling pipeline
- `types.ts` — Canonical types
- `validate-json.ts` — Output contract validation
- `normalize-output.ts` — JSON cleaning/fixing

### `src/llm/`
- `call-llm.ts` — Provider dispatcher (ollama, openai, etc.)
- `router.ts` — Reads routing.yaml; maps task type → flow
- `Provider` implementations (implied by env vars)

### `src/worker/`
- `host.ts` — Worker host coordination
- `jobs.ts` — Worker job execution (isolated repo inspection, worktree prep, tool runs)
- `types.ts` — Job types and status

### `src/guardian/`
- `evidence-gate.ts` — Deterministic validation of worker output (no LLM; rules-based)

### `src/ops/`
- `projection.ts` — Operational snapshot of system state
- `server.ts` — HTTP endpoint for ops bridge

### `src/events/`
- `event-emitter.ts` — Append-only NDJSON stream; sanitizes secrets; fail-soft
- `types.ts` — AmonEvent schema

### `src/adapters/`
- `sentinel-board.ts` — Builds unified card from 4 agent results; posts to SB

## Testing patterns

- **Test files:** Colocated with source (e.g., `planner.test.ts` next to `planner.ts`)
- **Framework:** Vitest (globals enabled in vitest.config.ts)
- **Mocking LLM:** Use `AMON_AGENTS_PROVIDER=mock` in `.env.local` or set `provider: "mock"` in tests
- **Mock responses:** Hardcoded in `src/llm/call-llm.ts` under `mock` provider case
- **Event stream testing:** Tests often set `AMON_EVENTS_ENABLED=false` to avoid disk writes during tests

## Environment variables

**Required:**
- `AMON_AGENTS_PROVIDER` — `ollama`, `lmstudio`, `openai`, `gemini`, `openrouter`, or `mock`

**Optional:**
- `AMON_AGENTS_MODEL` — Fallback model name
- `AMON_AGENTS_PUSH_TO_SB` — `true` to auto-push unified card to Sentinel Board
- `AMON_AGENTS_ALLOW_MOCK_FALLBACK` — `true` to fall back to mock if provider fails
- `AMON_AGENTS_LLM_TIMEOUT_MS` — LLM call timeout (default: 120000)
- `AMON_EVENTS_PATH` — Override path for events.jsonl (default: ~/.amon/events.jsonl)
- `AMON_EVENTS_ENABLED` — `false` to opt-out of event streaming
- `OLLAMA_THINK` — `true` to enable ollama reasoning mode
- `OLLAMA_NUM_PREDICT` — Token limit for ollama generation (default: 1536)

**Provider-specific:**
- `OLLAMA_BASE_URL` — e.g., `http://localhost:11434`
- `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`
- `LM_STUDIO_BASE_URL` — e.g., `http://localhost:1234/v1`

Read from `.env.local` by CLI entry point.

## Key design decisions

1. **YAML-driven routing:** Task type → agent flow is read from `routing.yaml`, not hardcoded. Adding a new task type doesn't require code changes.

2. **Registry pattern:** `AGENT_REGISTRY` in `registry.ts` maps agent names to executors. Pipeline calls `getAgentExecutor()` to resolve agents dynamically. Missing agents throw clear errors.

3. **Output contract validation:** Each agent output validated against `core/output-contract.yaml`. If validation fails, pipeline blocks (return code 1).

4. **Multi-provider LLM:** Single `call-llm.ts` dispatcher handles ollama, openai, lmstudio, etc. Providers are swappable via env var.

5. **Append-only events:** `events/event-emitter.ts` writes NDJSON to disk. Fail-soft (errors swallowed). Secrets sanitized automatically.

6. **Worker isolation:** Worker jobs run in isolated git worktrees (`src/worker/host.ts`). Evidence gate (`src/guardian/evidence-gate.ts`) validates output deterministically (no LLM).

7. **Unified card pattern:** `adapters/sentinel-board.ts` transforms 4 separate agent results into 1 card posted to Sentinel Board. Decouples agent structure from consumer expectations.

## Recent work (current branch: feat/jarvis-004-worker-host-mvp)

- **Worker Host MVP:** Local heartbeat and job orchestration (`src/worker/`)
- **Guardian Evidence Gate:** Deterministic (rule-based, no LLM) validation of worker output (`src/guardian/`)
- **Ops Projection:** Local snapshot of system operational state (`src/ops/`)
- **Worker job types:** `inspect_repo`, `prepare_worktree`, `run_coding_tool`

## Debugging tips

1. **Check .env.local first:** CLI reads it. Missing vars cause silent failures.
2. **Logs are prefixed:** `[Pipeline]`, `[LLM]`, `[Agent name]` make tracking easy. Set `setLevel("debug")` in logger.ts if needed.
3. **Outputs are saved locally first:** Check `outputs/` folder before assuming Sentinel Board integration failed.
4. **Events are append-only:** Check `~/.amon/events.jsonl` for detailed event log (even if SB push fails).
5. **Mock provider is fast:** Use `AMON_AGENTS_PROVIDER=mock` for rapid iteration without calling real LLMs.
6. **TypeScript strict mode:** Config has `"strict": true`. Respect it; don't ignore types.

## Common patterns

**Adding a new agent:**
1. Implement in `src/agents/newagent.ts` with signature `(ctx: PipelineContext) => Promise<AgentResult>`
2. Add to `AGENT_REGISTRY` in `registry.ts`
3. Update `routing.yaml` if this agent should be in a flow
4. Update type definitions in `core/types.ts` if needed

**Adding a new task type:**
1. Add to `core/routing.yaml` with agent flow
2. Update `TaskType` union in `core/types.ts` if needed
3. Router will auto-discover the flow

**Validating a new output format:**
1. Update `core/output-contract.yaml` with required fields
2. Validator in `core/validate-json.ts` will enforce it
3. Test with `npm run test -- src/core/validate-json.test.ts`

**Adding a new LLM provider:**
1. Add case to `call-llm.ts` dispatcher
2. Implement provider-specific API call
3. Test with `AMON_AGENTS_PROVIDER=<newprovider>`
