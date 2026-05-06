# AMON Agents — Sentinel Board Integration

> Cómo AMON Agents se conecta a Sentinel Board, el payload unificado, y por qué ya no se crean 4 cards.

## Endpoint oficial

```
POST /api/agents/import
```

- **Host:** Valor de `SENTINEL_BOARD_API_URL` (default: `http://localhost:3000`).
- **Auth:** `Authorization: Bearer {SENTINEL_BOARD_AGENT_TOKEN}`.
- **Content-Type:** `application/json`.
- **Fuente canónica:** Este es el único endpoint que AMON Agents usa para comunicarse con Sentinel Board.

## ¿Por qué ya no se crean 4 cards?

### Problema anterior

Cada ejecución de `amon run` creaba **4 cards** en Sentinel Board:

| Card | Agente | Título |
|------|--------|--------|
| 1 | `architect` | `[ARCHITECT] Crear login OAuth` |
| 2 | `security` | `[SECURITY] Validación de estado...` |
| 3 | `qa` | `[QA] Revisión de plan...` |
| 4 | `ops` | `[OPS] Score de output...` |

Esto generaba:
- **Ruido en el board** — 4 cards por tarea atomiza la información.
- **Pérdida de contexto** — no hay relación visual entre las cards de una misma ejecución.
- **Dificultad de tracking** — ¿cuál card representa "la tarea"?

### Solución: Single-Card Architecture

Ahora cada ejecución genera **1 sola card** con `agent: "amon-pipeline"`:

- **Planner** define el cuerpo principal (título, descripción, plan, risks).
- **State-Guardian** se guarda como metadata + checklist.
- **QA-Reviewer** se guarda como metadata + comments.
- **Scorer** se guarda como metadata + tags.
- **Todos** generan eventos en el timeline.

## Payload unificado (`SBUnifiedImportPayload`)

```json
{
  "source": "amon-agents",
  "externalTaskId": "TASK-005",
  "agent": "amon-pipeline",
  "title": "[AMON] Crear login OAuth",
  "description": "Implementar flujo OAuth 2.0 con Google provider...",
  "priority": "low",
  "status": "validando",
  "type": "feature",
  "tags": [
    "task-type:feature_small",
    "score:85",
    "verdict:approved"
  ],
  "metadata": { ... },
  "checklist": [ ... ],
  "comments": [ ... ],
  "timeline": [ ... ]
}
```

### Campos principales

| Campo | Fuente | Descripción |
|-------|--------|-------------|
| `source` | Fijo | Siempre `"amon-agents"` |
| `externalTaskId` | CLI flag `--task` | ID externo de la tarea |
| `agent` | Fijo | Siempre `"amon-pipeline"` |
| `title` | Planner | `[AMON] {goal}` (max 80 chars) |
| `description` | Planner | Goal completo |
| `priority` | Calculado | Worst-case de todos los agentes |
| `status` | State-Guardian | Derivado del verdict |
| `type` | Planner | Mapeado desde `taskType` |
| `tags` | Calculado | task-type, score, verdict |

### Priority (calculado)

| Condición | Priority |
|-----------|----------|
| Algún agente tiene `valid === false` | `high` |
| Algún agente tiene warnings | `medium` |
| Todo OK | `low` |

### Status (derivado del verdict)

| Verdict | Status |
|---------|--------|
| `APPROVED` | `validando` |
| `NEEDS_REVIEW` | `clarificando` |
| `BLOCKED` | `idea_bruta` |

### Type (mapeado desde taskType)

| taskType | Card type |
|----------|-----------|
| `feature_small`, `ui_change` | `feature` |
| `bugfix` | `bug` |
| `infra_change`, `security_check` | `task` |
| `research_task` | `research` |

## Metadata

```json
{
  "metadata": {
    "plan": ["Paso 1: ...", "Paso 2: ..."],
    "risks": ["Riesgo de..."],
    "validations": ["Test de..."],
    "done_when": ["Cuando..."],
    "files_to_touch": ["src/auth/oauth.ts"],
    "score": 85,
    "state_guardian": {
      "verdict": "APPROVED",
      "violations": [],
      "valid": true
    },
    "qa_review": {
      "goal": "Revisión de cobertura y edge cases...",
      "validations": ["Cobertura > 80%", "..."],
      "risks": ["Edge case en refresh token"],
      "valid": true
    },
    "scoring_detail": {
      "score": 85,
      "completeness": 90,
      "quality": 80,
      "coherence": 85,
      "reasoning": "Plan bien estructurado con..."
    }
  }
}
```

| Sección | Fuente | Descripción |
|---------|--------|-------------|
| `plan`, `risks`, `validations`, `done_when`, `files_to_touch` | Planner | Datos principales del plan |
| `score` | Scorer | Score global (0–100) |
| `state_guardian` | State-Guardian | Verdict + violations + validity |
| `qa_review` | QA-Reviewer | Goal + validaciones + risks + validity |
| `scoring_detail` | Scorer | Detalle: score, completeness, quality, coherence, reasoning |

## Checklist

```json
{
  "checklist": [
    "[done_when] Tests unitarios pasan",
    "[done_when] OAuth flow funciona end-to-end",
    "[qa] Cobertura de tests > 80%",
    "[qa] Error handling en token refresh",
    "[violation] Secreto hardcodeado detectado"
  ]
}
```

| Prefijo | Fuente | Significado |
|---------|--------|-------------|
| `[done_when]` | Planner | Criterio de completitud |
| `[qa]` | QA-Reviewer | Validación de calidad |
| `[violation]` | State-Guardian | Violación de regla global |

## Comments

```json
{
  "comments": [
    {
      "agent": "state-guardian",
      "timestamp": "2026-05-06T18:30:00.000Z",
      "body": "Verdict: APPROVED. No se detectaron violaciones."
    },
    {
      "agent": "qa-reviewer",
      "timestamp": "2026-05-06T18:30:15.000Z",
      "body": "Plan cubre los requisitos principales. Falta edge case..."
    },
    {
      "agent": "scorer",
      "timestamp": "2026-05-06T18:30:30.000Z",
      "body": "Score: 85/100. Plan bien estructurado con buen balance..."
    }
  ]
}
```

Cada agente (excepto Planner, que ya define el cuerpo principal) genera un comentario con su resumen.

## Timeline

```json
{
  "timeline": [
    {
      "agent": "planner",
      "timestamp": "2026-05-06T18:29:45.000Z",
      "event": "Plan generado",
      "status": "ok"
    },
    {
      "agent": "state-guardian",
      "timestamp": "2026-05-06T18:30:00.000Z",
      "event": "Evaluación: APPROVED",
      "status": "ok"
    },
    {
      "agent": "qa-reviewer",
      "timestamp": "2026-05-06T18:30:15.000Z",
      "event": "Revisión QA completada",
      "status": "ok"
    },
    {
      "agent": "scorer",
      "timestamp": "2026-05-06T18:30:30.000Z",
      "event": "Score: 85/100",
      "status": "ok"
    }
  ]
}
```

Cada agente genera un evento. El status refleja si el agente fue exitoso.

## Configuración

| Variable | Default | Descripción |
|----------|---------|-------------|
| `SENTINEL_BOARD_API_URL` | `http://localhost:3000` | Base URL de la API |
| `SENTINEL_BOARD_AGENT_TOKEN` | — | Bearer token de autenticación |
| `AMON_AGENTS_PUSH_TO_SB` | `false` | Habilita push automático en `amon run` |

## Push manual

Si `AMON_AGENTS_PUSH_TO_SB=false` (default), `amon run` guarda la card localmente en `outputs/sentinel/` pero no la envía. Para enviarla:

```bash
amon push --task TASK-005
```

`amon push` siempre fuerza el push, ignorando `AMON_AGENTS_PUSH_TO_SB`.

## Retrocompatibilidad

`amon push` soporta dos formatos:

1. **Unificado** (actual): `{taskId}-unified-board.json` → 1 card.
2. **Legacy**: `{taskId}-*-board.json` → múltiples cards por agente.

Si existe el archivo unificado, se usa. Si no, se buscan los archivos legacy. Esto permite re-pushear outputs generados antes de la migración a single-card.
