# AMON Agents — Agent Pipeline

> Documentación del pipeline de agentes: flujo, responsabilidades, entradas/salidas y cómo se consolidan en una card única.

## Pipeline

```
planner → state-guardian → qa-reviewer → scorer
   │            │               │            │
   ▼            ▼               ▼            ▼
  Plan       Verdict         Review       Score
   │            │               │            │
   └────────────┴───────────────┴────────────┘
                        │
                        ▼
              buildUnifiedPayload()
                        │
                        ▼
              1 card → Sentinel Board
```

El pipeline es **secuencial**. Cada agente recibe el output del anterior como contexto. Si State-Guardian emite `BLOCKED`, el pipeline se detiene.

## Agentes

### 1. Planner (rol: `architect`)

**Archivo:** `src/agents/planner.ts`

**Misión:** Producir un plan de cambio estructurado para la tarea solicitada.

**Entrada:**

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `taskId` | `string` | ID de la tarea |
| `taskType` | `string` | Tipo de tarea (define routing) |
| `description` | `string` | Descripción libre de la tarea |
| `repo` | `string?` | Repositorio objetivo |
| `playbook` | `string?` | Playbook a aplicar |

**Salida (`StandardOutput`):**

| Campo | Tipo |
|-------|------|
| `goal` | `string` |
| `scope` | `string` |
| `files_to_touch` | `string[]` |
| `plan` | `string[]` |
| `risks` | `string[]` |
| `validations` | `string[]` |
| `done_when` | `string[]` |

**Contexto que lee:**
- `core/core-agents.yaml` → config del agente `architect`.
- `core/output-contract.yaml` → campos requeridos y tipos.

**Mapeo en la card unificada:**
- `title` ← `[AMON] {goal}`
- `description` ← `goal`
- `metadata.plan` ← `plan`
- `metadata.risks` ← `risks`
- `metadata.validations` ← `validations`
- `metadata.done_when` ← `done_when`
- `metadata.files_to_touch` ← `files_to_touch`

---

### 2. State-Guardian (rol: `security`)

**Archivo:** `src/agents/state-guardian.ts`

**Misión:** Validar que las propuestas cumplan las reglas globales y no introduzcan anti-patrones.

**Entrada:**

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `taskId` | `string` | ID de la tarea |
| `proposedChanges` | `string` | Output serializado del planner |

**Salida (`StateGuardianOutput`):**

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `verdict` | `"APPROVED" \| "BLOCKED" \| "NEEDS_REVIEW"` | Dictamen |
| `violations` | `string[]` | Violaciones detectadas |
| + todos los campos de `StandardOutput` | | |

**Contexto que lee:**
- `core/global-rules.yaml` → reglas, principios, anti-patrones.

**Comportamiento crítico:**
- Si `verdict === "BLOCKED"` → el pipeline se detiene con exit code 1.
- Si `valid === false` → el pipeline se detiene (output corrupto).

**Mapeo en la card unificada:**
- `metadata.state_guardian.verdict` ← `verdict`
- `metadata.state_guardian.violations` ← `violations`
- `metadata.state_guardian.valid` ← `valid`
- `checklist[]` ← cada violación como `[violation] ...`
- `comments[]` ← comentario con verdict y goal
- `timeline[]` ← evento con verdict
- `status` ← derivado del verdict (`APPROVED` → `validando`, `NEEDS_REVIEW` → `clarificando`, `BLOCKED` → `idea_bruta`)

---

### 3. QA-Reviewer (rol: `qa`)

**Archivo:** `src/agents/qa-reviewer.ts`

**Misión:** Revisar el plan contra el contrato de calidad AMON.

**Entrada:**

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `taskId` | `string` | ID de la tarea |
| `taskType` | `string` | Tipo de tarea |
| `plan` | `string?` | Output serializado del planner |
| `codeDiff` | `string?` | Diff de código (futuro) |

**Salida (`StandardOutput`):**
- Mismos campos estándar. Su `goal` es el resumen de la revisión.

**Contexto que lee:**
- `core/core-agents.yaml` → config del agente `qa`.
- `core/output-contract.yaml` → contrato de salida.

**Mapeo en la card unificada:**
- `metadata.qa_review.goal` ← `goal`
- `metadata.qa_review.validations` ← `validations`
- `metadata.qa_review.risks` ← `risks`
- `metadata.qa_review.valid` ← `valid`
- `checklist[]` ← cada validación como `[qa] ...`
- `comments[]` ← comentario con goal

---

### 4. Scorer (rol: `ops`)

**Archivo:** `src/agents/scorer.ts`

**Misión:** Evaluar la calidad del output del planner con métricas numéricas.

**Entrada:**

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `taskId` | `string` | ID de la tarea |
| `agentName` | `string` | Agente evaluado (siempre `"planner"`) |
| `taskType` | `string` | Tipo de tarea |
| `rawOutput` | `string` | Output serializado del planner |

**Salida (`ScorerOutput`):**

| Campo | Tipo | Rango |
|-------|------|-------|
| `score` | `number` | 0–100 |
| `completeness` | `number` | 0–100 |
| `quality` | `number` | 0–100 |
| `coherence` | `number` | 0–100 |
| `reasoning` | `string` | — |
| + todos los campos de `StandardOutput` | | |

**Contexto que lee:**
- `core/output-contract.yaml` → contrato de salida.

**Mapeo en la card unificada:**
- `metadata.score` ← `score` (sanitizado a 0–100)
- `metadata.scoring_detail` ← objeto completo con score, completeness, quality, coherence, reasoning
- `tags[]` ← `score:{value}`
- `comments[]` ← comentario con score y reasoning
- `timeline[]` ← evento con score

---

## Validación de outputs

Todos los agentes pasan por dos fases de validación:

1. **`validateOutput()`** — Valida campos requeridos del `StandardOutput` según `output-contract.yaml`.
2. **`validateFields()`** — Validaciones extra para campos específicos del agente (State-Guardian: `verdict`, `violations`; Scorer: `score`, `completeness`, etc.).

Los resultados se combinan con `mergeValidationResults()`. Un agente con `valid === false` sigue generando output local pero se marca como inválido en la card.

## Normalización

`normalizeOutput()` garantiza que el output del LLM cumple los tipos esperados:
- Strings que llegan como objetos → `JSON.stringify()`.
- Arrays que llegan como strings → `[value]`.
- Campos faltantes → defaults vacíos.

Esto es necesario porque los LLMs no siempre respetan el schema pedido.

## Outputs locales

Cada agente genera un archivo `{taskId}-{agent}.json` en el directorio correspondiente:

| Agente | Archivo | Directorio |
|--------|---------|------------|
| Planner | `TASK-005-architect.json` | `outputs/plans/` |
| State-Guardian | `TASK-005-security.json` | Según task type |
| QA-Reviewer | `TASK-005-qa.json` | Según task type |
| Scorer | `TASK-005-ops.json` | Según task type |

La card unificada se guarda en `outputs/sentinel/TASK-005-unified-board.json`.

Los outputs locales **siempre se generan**, independientemente del estado de push a SB.
