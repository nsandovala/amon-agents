# Sesión Mes 2 — Notas de Avance

> Repo: `amon-agents`  
> Fecha: 2026-06-08  
> Estado: push realizado a `origin/main`

---

## Mes 1 — Completado

| Commit | Descripción |
|--------|-------------|
| (varios) | **A1**: Vitest instalado, scripts `test` / `test:watch` / `test:coverage`. |
| (varios) | **A2**: 11 tests para `src/cli/parse-args.test.ts`. |
| (varios) | **A3**: 22 tests para `src/utils/clean-json.test.ts` (documenta regex greedy). |
| (varios) | **A4**: `validateOutput(data, contract?)` acepta contrato inyectado. |
| (varios) | **A5**: 19 tests para `normalize-output` + `validate-json` → **64 tests totales**. |
| (varios) | **B1**: CI GitHub Actions workflow (`typecheck` → `test` → `build`). |
| (varios) | **C1**: Extraer `src/core/pipeline.ts` con orquestación completa. |
| (varios) | **C2**: `src/commands/run.ts` delega a `runPipeline()`. |
| (varios) | **C3**: `src/core/run-agent.ts` es wrapper delgado. |
| (varios) | **D1**: `src/agents/registry.ts` con `AGENT_REGISTRY`, `PipelineContext`, `AgentExecutor`. |
| (varios) | **D2**: `core/routing.yaml` alineado a flujo real `[architect, security, qa, ops]`. |
| (varios) | **D3**: `pipeline.ts` usa `getFlowForTaskType()` + `getAgentExecutor()` dinámicamente. |
| (varios) | **D4**: 12 tests para `registry.ts`. |

**Verificaciones vigentes:**
- `npm test` → 64 tests verdes.
- `npm run typecheck` → verde.
- `npm run build` → verde.
- CI configurado en `.github/workflows/ci.yml`.

---

## Mes 2 — Completado hasta ahora

| Código | Descripción | Archivos principales |
|--------|-------------|----------------------|
| **M2-B1** | Diagnóstico 404 mejorado en AA: trunca HTML, mensaje claro. | `src/adapters/sentinel-board.ts` |
| **M2-B2** | Endpoint `POST /api/agents/import` creado en `sentinel-board`. | `sentinel-board/app/api/agents/import/route.ts` |
| **M2-C1** | Métricas por agente: duración en `pipeline.ts` + evento `agent.metrics`. | `src/core/pipeline.ts`, `src/events/types.ts` |
| **M2-C2** | Comando CLI `amon history` lee `outputs/events.jsonl`. | `src/commands/history.ts`, `src/cli/amon.ts` |
| **M2-C3** | `amon status` enriquecido con resumen runtime (total runs, últimos 5, score, duración, errores). | `src/commands/status.ts` |

**Handshake AA ↔ SB:**
- `POST localhost:3000/api/agents/import` responde `{ ok: true, received: true, taskId }`.
- Pipeline AA envía card unificada al terminar (non-blocking).

---

## Estado Actual

- **Tests:** 64 verdes.
- **Typecheck:** verde.
- **Build:** verde.
- **Push:** `main` actualizado en GitHub (`ffa36b3`).
- **Working tree:** limpio.

---

## Pendientes Próxima Sesión

### JARVIS-002 handoff — First Heartbeat

- **Run correlation:** PASS. `amon run` now preserves one `runId` from CLI `command.started` through `runPipeline` events.
- **First Heartbeat:** partial FAIL, controlled.
- **Failure:** Ollama `qwen3.5:9b` timed out in `planner` before any ticket outputs were persisted.
- **runId:** `242f935d-4d57-43bc-a8fe-a3d39171edc3`
- **Events present:** `command.started`, `run.started`, `agent.started` (`planner`), `agent.error` (`planner`), `command.error`.
- **Events absent:** no `run.done`, no `command.done`.
- **Outputs:** no persisted outputs for `BF-JARVIS-SMOKE-001`.
- **BracketFlow:** intact; pre/post `git status --short` stayed `?? CLAUDE.md`.
- **Sentinel Board:** not running during verification, so Runtime read was blocked.
- **Next investigation:** diagnose real Ollama/provider timeout before touching pipeline behavior.

1. **Revisar GitHub Actions** después del push (verificar que el workflow siga pasando).
2. **Revisar lint preexistente** en `sentinel-board` (el endpoint nuevo puede tener advertencias de ESLint / TypeScript).
3. **M2-D1: diseñar fallback LLM.**
   - Primero auditar `src/llm/call-llm.ts`.
   - No implementar fallback sin diagnóstico previo.
   - Evaluar si `call-llm.ts` ya soporta múltiples providers o necesita refactor.
4. **Persistencia real del payload importado en SB:**
   - El endpoint `/api/agents/import` acepta el payload pero no persiste en base de datos.
   - Evaluar si SB necesita un modelo `AgentRun` o si basta con log.
5. **Opcional:** agregar tests para `history.ts` y `status.ts` (actualmente sin cobertura directa).

---

## Riesgos / Reglas de Oro

- **No mezclar fallback LLM con cambios SB.** Trabajar uno a la vez.
- **No tocar pipeline si no es necesario.** `pipeline.ts` está estable.
- **No hacer `npm audit fix --force`.** Puede romper dependencias.
- **Mantener commits pequeños y verificables.**
- **No tocar repo `sentinel-board` salvo cuando se autorice explícitamente.**

---

## Comandos de Verificación Rápida

```bash
npm test
npm run typecheck
npm run build
npm run amon -- status
npm run amon -- history --limit 5
```

---

*Generado automáticamente al finalizar sesión.*
