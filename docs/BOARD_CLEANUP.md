# AMON Agents — Board Cleanup Guide

> Criterios y procedimiento para limpiar cards legacy en Sentinel Board generadas antes de la Single-Card Architecture.

## Contexto

Antes de la migración a Single-Card Architecture, cada ejecución de `amon run` creaba **4 cards separadas** en Sentinel Board — una por agente. Estas cards legacy siguen existiendo en el board y deben limpiarse.

## Cards legacy a identificar

Las cards legacy siguen un patrón de título con prefijo del agente:

| Patrón de título | Agente origen | Campo `agent_source` |
|------------------|---------------|----------------------|
| `[ARCHITECT] ...` | Planner | `architect` |
| `[SECURITY] ...` | State-Guardian | `security` |
| `[QA] ...` | QA-Reviewer | `qa` |
| `[OPS] ...` | Scorer | `ops` |

### Cómo identificarlas en la base de datos

Las cards legacy se pueden identificar por:

1. **Campo `agent_source`** (si existe en el schema de SB):
   - `architect`, `security`, `qa`, `ops` → legacy.
   - `amon-pipeline` → formato nuevo.

2. **Campo `source`** en metadata:
   - Si fue enviado con el formato antiguo `SBImportPayload`, el campo `agent` es el nombre del agente individual.
   - En el formato nuevo `SBUnifiedImportPayload`, `agent` es siempre `"amon-pipeline"`.

3. **Patrón de título**:
   - Legacy: `[ARCHITECT] ...`, `[SECURITY] ...`, `[QA] ...`, `[OPS] ...`.
   - Nuevo: `[AMON] ...`.

4. **Multiplicidad por task_ref**:
   - Si hay 4 cards con el mismo `externalTaskId` / `task_ref` → son legacy.
   - Si hay 1 card con ese ID → es el formato nuevo.

## Criterios de limpieza

### Cards que se pueden archivar/eliminar

- ✅ Cards con `agent_source` = `security`, `qa`, `ops` (agentes de soporte).
  - Su información ya está consolidada en la card unificada (si se re-ejecutó la tarea).
  - Si la tarea NO se re-ejecutó, la información solo vive en estas cards.

- ✅ Cards con `agent_source` = `architect` **si existe** una card `amon-pipeline` con el mismo `externalTaskId`.
  - La card unificada reemplaza a la card del architect.

### Cards que NO se deben eliminar

- ❌ Cards con `agent_source` = `architect` si **no existe** una card `amon-pipeline` equivalente.
  - Estas son la única representación de la tarea en el board.
  - Opción: re-ejecutar `amon run` para generar la card unificada.

- ❌ Cards creadas manualmente en Sentinel Board (no tienen `source: "amon-agents"`).

## Procedimiento recomendado

### Paso 1: Inventario

Listar todas las cards legacy en el board. Agrupar por `externalTaskId`:

```
TASK-001 → 4 cards (architect, security, qa, ops) → legacy
TASK-002 → 4 cards → legacy
TASK-003 → 1 card (amon-pipeline) → ya migrada
```

### Paso 2: Decisión por grupo

Para cada grupo de cards legacy:

| Situación | Acción |
|-----------|--------|
| Existe card `amon-pipeline` para el mismo task | Archivar las 4 legacy |
| No existe card `amon-pipeline` y la tarea es irrelevante | Archivar las 4 legacy |
| No existe card `amon-pipeline` y la tarea sigue activa | Re-ejecutar `amon run` o conservar la card `architect` |

### Paso 3: Archivar (no eliminar)

Recomendación: **archivar** las cards legacy en vez de eliminarlas. Esto preserva la trazabilidad.

Si Sentinel Board soporta el status `archivado`, mover las cards a ese estado. Si no, eliminar.

### Paso 4: Limpieza de outputs locales

Los archivos legacy en `outputs/sentinel/` siguen el patrón:

```
outputs/sentinel/TASK-001-architect-board.json
outputs/sentinel/TASK-001-security-board.json
outputs/sentinel/TASK-001-qa-board.json
outputs/sentinel/TASK-001-ops-board.json
```

Estos archivos se pueden eliminar de forma segura. Los outputs por agente en `outputs/plans/`, `outputs/reviews/`, `outputs/logs/` se preservan (no son afectados por este cambio).

```bash
# Eliminar archivos legacy de sentinel board local
# (preservar los *-unified-board.json)
find outputs/sentinel/ -name "*-architect-board.json" -delete
find outputs/sentinel/ -name "*-security-board.json" -delete
find outputs/sentinel/ -name "*-qa-board.json" -delete
find outputs/sentinel/ -name "*-ops-board.json" -delete
```

En PowerShell:

```powershell
Get-ChildItem outputs/sentinel/ -Filter "*-architect-board.json" | Remove-Item
Get-ChildItem outputs/sentinel/ -Filter "*-security-board.json" | Remove-Item
Get-ChildItem outputs/sentinel/ -Filter "*-qa-board.json" | Remove-Item
Get-ChildItem outputs/sentinel/ -Filter "*-ops-board.json" | Remove-Item
```

## SQL de referencia (Neon/PostgreSQL)

Si se tiene acceso directo a la base de datos de Sentinel Board:

```sql
-- Inventario de cards legacy
SELECT id, title, external_task_id, agent_source, created_at
FROM tasks
WHERE source = 'amon-agents'
  AND agent_source IN ('architect', 'security', 'qa', 'ops')
ORDER BY external_task_id, agent_source;

-- Archivar cards de soporte (security, qa, ops)
UPDATE tasks
SET status = 'archivado'
WHERE source = 'amon-agents'
  AND agent_source IN ('security', 'qa', 'ops');

-- Archivar cards architect que ya tienen versión unificada
UPDATE tasks t1
SET status = 'archivado'
WHERE t1.source = 'amon-agents'
  AND t1.agent_source = 'architect'
  AND EXISTS (
    SELECT 1 FROM tasks t2
    WHERE t2.external_task_id = t1.external_task_id
      AND t2.agent_source = 'amon-pipeline'
  );
```

> **Nota:** Estos queries son de referencia. Verificar los nombres exactos de columnas contra el schema actual de Sentinel Board antes de ejecutar.

## Prevención

Con la Single-Card Architecture activa, no se crearán más cards legacy. Cada nueva ejecución de `amon run` genera exactamente 1 card con `agent: "amon-pipeline"`.
