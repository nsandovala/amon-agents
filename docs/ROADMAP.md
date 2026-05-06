# AMON Agents — Roadmap

> Fases de evolución del sistema AMON Agents.

---

## Fase 1: CLI + Single Card ✅

**Estado:** Completada.

**Entregables:**
- [x] CLI funcional: `amon run`, `amon push`, `amon status`, `amon help`.
- [x] Pipeline secuencial: planner → state-guardian → qa-reviewer → scorer.
- [x] Multi-provider LLM: ollama, lmstudio, openai, gemini, openrouter, mock.
- [x] Contrato de salida validado (`output-contract.yaml`).
- [x] Normalización de outputs del LLM.
- [x] Push a Sentinel Board vía `POST /api/agents/import`.
- [x] **Single-Card Architecture**: 1 ejecución = 1 card.
- [x] Card unificada con metadata, checklist, comments, timeline.
- [x] Outputs locales por agente preservados.
- [x] Retrocompatibilidad de `amon push` con formato legacy.
- [x] Playbooks (ej: `python-radar.yaml`).
- [x] Documentación técnica completa.

---

## Fase 2: `amon ingest .md`

**Estado:** Planeada.

**Objetivo:** Permitir alimentar Sentinel Board desde archivos Markdown sin pasar por LLM.

**Entregables:**
- [ ] Comando `amon ingest` que lee archivos `.md` con frontmatter YAML.
- [ ] Parser de frontmatter → `SBImportPayload`.
- [ ] Soporte de batch: `amon ingest ./backlog/*.md`.
- [ ] Flags: `--type`, `--priority`, `--tags`.
- [ ] Validación de frontmatter contra schema esperado.
- [ ] Dry-run mode: `--dry-run` para previsualizar sin enviar.

**Formato esperado del `.md`:**

```markdown
---
title: Migrar auth a OAuth 2.0
type: feature
priority: high
tags: [auth, security]
---

Descripción detallada de la tarea...
```

**Beneficio:** El equipo puede crear cards desde documentación, notas o templates sin necesidad de ejecutar agentes.

---

## Fase 3: `amon scan --repo`

**Estado:** Planeada.

**Objetivo:** Escanear un repositorio y generar tareas automáticas basadas en patrones detectados.

**Entregables:**
- [ ] Comando `amon scan --repo <path>`.
- [ ] Detector de TODOs / FIXMEs en código fuente.
- [ ] Detector de dependencias desactualizadas (`package.json`, `requirements.txt`).
- [ ] Detector de archivos sin tests.
- [ ] Detector de secretos hardcodeados.
- [ ] Generación de cards con findings priorizados.
- [ ] Flag `--focus` para limitar el scan (ej: `--focus security`).

**Beneficio:** Discovery automático al iniciar trabajo en un repo. Health-check periódico.

---

## Fase 4: `amon audit --repo`

**Estado:** Planeada.

**Objetivo:** Auditoría profunda de un repositorio con análisis multi-agente.

**Entregables:**
- [ ] Comando `amon audit --repo <path>`.
- [ ] Análisis de seguridad: secrets, permisos, dependencias vulnerables.
- [ ] Análisis de arquitectura: acoplamiento, patrones, deuda técnica.
- [ ] Análisis de calidad: cobertura, complejidad, consistencia.
- [ ] Reporte consolidado como card en Sentinel Board.
- [ ] Checklist actionable con findings priorizados.
- [ ] Flag `--focus`: `security`, `architecture`, `quality`.
- [ ] Soporte de playbooks para personalizar criterios.

**Diferencia con `scan`:** `scan` es rápido y basado en patrones. `audit` es profundo y usa LLM para análisis contextual.

---

## Fase 5: GitHub Issues/PR Bridge

**Estado:** Planeada.

**Objetivo:** Conectar AMON Agents con el flujo de GitHub para sincronización bidireccional.

**Entregables:**
- [ ] Leer GitHub Issues y convertirlas en contexto para `amon run`.
- [ ] Crear GitHub Issues desde cards de Sentinel Board.
- [ ] Analizar PRs y generar reviews automáticos.
- [ ] Sincronizar estado: card en SB ↔ issue/PR en GitHub.
- [ ] Webhook receiver para actualizaciones en tiempo real.
- [ ] Soporte de labels ↔ tags.

**Beneficio:** Cerrar el loop entre planificación (AMON/SB) y ejecución (GitHub).

---

## Fase 6: Event Stream

**Estado:** Planeada.

**Origen:** Patrón validado en `cortex-heo-lab` (Python event emitter).

**Objetivo:** Emitir eventos tipados durante la ejecución del pipeline para consumo en tiempo real por extensiones, dashboards o logs estructurados.

**Entregables:**
- [ ] `EventEmitter` tipado en TypeScript (`src/core/event-stream.ts`).
- [ ] Eventos por fase: `pipeline:start`, `agent:start`, `agent:done`, `agent:error`, `pipeline:done`.
- [ ] Payload de cada evento con `taskId`, `agent`, `timestamp`, `status`, `data`.
- [ ] Hook en `run-agent.ts` y `run.ts` para emitir eventos en cada paso.
- [ ] Writer de eventos a `stdout` (modo `--stream`) para consumo por pipes.
- [ ] Writer de eventos a archivo (`outputs/events/{taskId}.ndjson`).
- [ ] Interfaz `EventSink` para que extensiones futuras se suscriban.

**Ejemplo de evento:**

```json
{
  "event": "agent:done",
  "taskId": "TASK-005",
  "agent": "planner",
  "timestamp": "2026-05-06T18:30:00.000Z",
  "status": "ok",
  "data": {
    "valid": true,
    "outputFields": ["goal", "plan", "risks", "files_to_touch"],
    "durationMs": 4200
  }
}
```

**Reglas:**
- El event stream es **opt-in** — no afecta el flujo normal.
- Implementación nativa en TypeScript. No se porta código Python de cortex-heo-lab.
- Compatible con el patrón de `EventSink` para la Fase 7.

**Beneficio:** Observabilidad del pipeline. Base para la extensión VSCode.

---

## Fase 7: VSCode Extension / Pixel-like Agent Visualizer

**Estado:** Planeada.

**Origen:** Prototipo de visualizador en `cortex-heo-lab`.

**Objetivo:** Extensión de VSCode que visualiza la ejecución de AMON Agents en tiempo real, estilo Pixel — mostrando el pipeline como un flujo visual con estado por agente.

**Entregables:**
- [ ] Extensión VSCode básica (`amon-vscode`).
- [ ] Panel lateral con visualización del pipeline activo.
- [ ] Estado por agente: pending → running → done/error.
- [ ] Consumo del Event Stream (Fase 6) vía `EventSink`.
- [ ] Visualización de la card unificada resultante.
- [ ] Botón para ejecutar `amon run` desde el panel.
- [ ] Botón para push manual a Sentinel Board.
- [ ] Link directo a la card en Sentinel Board.

**Stack:**
- TypeScript (mismo que AMON Agents).
- VSCode Extension API.
- Webview panel para el visualizador.

**Reglas:**
- La extensión **no reemplaza** el CLI. Es un complemento visual.
- No introduce un runtime paralelo. Consume el mismo `amon` CLI.
- No porta el visualizador Python de cortex-heo-lab — se reimplementa nativo en TypeScript/Webview.

**Beneficio:** Experiencia de agentes visible sin salir del editor.

---

## Backlog futuro (sin fase asignada)

| Idea | Descripción |
|------|-------------|
| `amon diff` | Analizar un git diff y generar review con agentes |
| `amon replay` | Re-ejecutar una task con nuevo LLM o playbook |
| Dashboard local | UI web local para visualizar outputs sin SB |
| Webhooks SB → AMON | SB notifica a AMON cuando cambia el estado de una card |
| Cache de prompts | Evitar llamadas repetidas al LLM para misma tarea |
| Parallel agents | Ejecutar agentes independientes en paralelo |
| Custom agents | Permitir definir agentes desde YAML sin código |
| cortex-heo-lab graduation | Evaluar y graduar patrones validados en el sandbox Python |
| Provider hot-swap | Cambiar provider mid-pipeline si uno falla (sin mock fallback) |

