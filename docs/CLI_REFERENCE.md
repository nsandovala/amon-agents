# AMON CLI Reference

> Referencia completa del CLI `amon`.
> Todas las variables se leen desde `.env.local` en el directorio de trabajo actual.

---

## Comandos activos

### `amon run`

Ejecuta el pipeline completo de agentes y genera una **card unificada** en Sentinel Board.

**Pipeline:** `planner → state-guardian → qa-reviewer → scorer`

**Uso:**

```bash
amon run "descripción de la tarea"
amon run --task TASK-005 --type feature_small "Crear login OAuth"
amon run --task TASK-010 --type bugfix --repo sentinel-board "Fix redirect loop"
amon run --playbook python-radar --type research_task "Evaluar motor de señales"
```

**Flags:**

| Flag | Tipo | Default | Descripción |
|------|------|---------|-------------|
| `--task` | `string` | Auto-generado (`AMON-YYYYMMDDHHmmss`) | ID externo de la tarea |
| `--type` | `TaskType` | `feature_small` | Tipo de tarea (define el flujo de agentes) |
| `--repo` | `string` | — | Repositorio objetivo (contexto para el planner) |
| `--playbook` | `string` | — | Nombre del playbook a aplicar (ej: `python-radar`) |

**Task types disponibles:**

| Tipo | Descripción | Output path |
|------|-------------|-------------|
| `feature_small` | Cambio acotado de producto o interfaz | `outputs/plans` |
| `ui_change` | Cambio visual, layout o UX | `outputs/plans` |
| `bugfix` | Corrección de bug o regresión | `outputs/reviews` |
| `infra_change` | Cambio de entorno, CI/CD, deploy | `outputs/logs` |
| `security_check` | Revisión de secretos y permisos | `outputs/reviews` |
| `research_task` | Análisis o investigación guiada | `outputs/logs` |

**Variables `.env` relacionadas:**

| Variable | Requerida | Descripción |
|----------|-----------|-------------|
| `AMON_AGENTS_PROVIDER` | Sí | Provider LLM: `ollama`, `lmstudio`, `openai`, `gemini`, `openrouter`, `mock` |
| `AMON_AGENTS_MODEL` | No | Modelo fallback si no hay variable específica del provider |
| `AMON_AGENTS_PUSH_TO_SB` | No | `true` para push automático a Sentinel Board al terminar |
| `AMON_AGENTS_ALLOW_MOCK_FALLBACK` | No | `true` para fallback a mock si el provider real falla |
| `AMON_AGENTS_LLM_TIMEOUT_MS` | No | Timeout en ms para llamadas LLM (default: `30000`) |

**Salida esperada:**

```
[amon run] Iniciando flujo para tarea TASK-005 de tipo feature_small
[Planner] Iniciando planificación para tarea TASK-005
[LLM] Provider: ollama, Model: llama3
[LLM] Respuesta recibida
[Planner] Output validado correctamente
[amon run] Guardado: outputs/plans/TASK-005-architect.json
[State-Guardian] Iniciando validación de estado para tarea TASK-005
[amon run] Guardado: outputs/reviews/TASK-005-security.json
[QA-Reviewer] Iniciando revisión QA para tarea TASK-005
[amon run] Guardado: outputs/plans/TASK-005-qa.json
[Scorer] Iniciando evaluación de output para tarea TASK-005
[amon run] Guardado: outputs/plans/TASK-005-ops.json
[amon run] Sentinel Board local (unified): outputs/sentinel/TASK-005-unified-board.json
[SentinelBoard] Enviando card unificada para TASK-005 a https://sentinel-board.vercel.app/api/agents/import
[SentinelBoard] Card unificada TASK-005 importada OK → clxxxxxxxxx
[amon run] Flujo completado. Task: TASK-005. Outputs locales generados.
```

**Archivos generados:**

| Archivo | Contenido |
|---------|-----------|
| `outputs/plans/TASK-005-architect.json` | Resultado raw del planner |
| `outputs/reviews/TASK-005-security.json` | Resultado raw del state-guardian |
| `outputs/plans/TASK-005-qa.json` | Resultado raw del QA reviewer |
| `outputs/plans/TASK-005-ops.json` | Resultado raw del scorer |
| `outputs/sentinel/TASK-005-unified-board.json` | Card unificada para Sentinel Board |

**Cuándo usarlo:**
- Al iniciar cualquier tarea de desarrollo que quieras planificar con AMON.
- Cada ejecución produce exactamente **1 card** en Sentinel Board.

---

### `amon push`

Re-envía una card previamente generada a Sentinel Board. Siempre fuerza el push (`force=true`), ignorando `AMON_AGENTS_PUSH_TO_SB`.

**Uso:**

```bash
amon push --task TASK-005
```

**Flags:**

| Flag | Tipo | Requerido | Descripción |
|------|------|-----------|-------------|
| `--task` | `string` | Sí | ID de la tarea a enviar |

**Variables `.env` relacionadas:**

| Variable | Requerida | Descripción |
|----------|-----------|-------------|
| `SENTINEL_BOARD_API_URL` | Sí | Base URL de la API de Sentinel Board |
| `SENTINEL_BOARD_AGENT_TOKEN` | Recomendada | Bearer token de autenticación |

**Comportamiento:**

1. Busca `outputs/sentinel/{taskId}-unified-board.json` (formato unificado).
2. Si existe → envía la card unificada.
3. Si no existe → busca archivos legacy `{taskId}-*-board.json` (retrocompatibilidad).
4. Si no encuentra nada → warning y exit 1.

**Salida esperada:**

```
[amon push] Cargado (unified): outputs/sentinel/TASK-005-unified-board.json
[amon push] Enviando card unificada a Sentinel Board (force=true).
[SentinelBoard] Card unificada TASK-005 importada OK → clxxxxxxxxx
[amon push] Push completado.
```

**Cuándo usarlo:**
- Cuando `amon run` se ejecutó con `AMON_AGENTS_PUSH_TO_SB=false` y ahora quieres enviar el resultado.
- Cuando SB estaba caído y quieres reintentar el push.

---

### `amon status`

Muestra la configuración activa del sistema: provider, modelo, estado de push, y health-check de Ollama.

**Uso:**

```bash
amon status
```

**Variables `.env` relacionadas:**

| Variable | Descripción |
|----------|-------------|
| `AMON_AGENTS_PROVIDER` | Provider activo |
| `AMON_AGENTS_PUSH_TO_SB` | Estado del push automático |
| `SENTINEL_BOARD_API_URL` | URL configurada para SB |
| `OLLAMA_BASE_URL` | URL configurada para Ollama |

**Salida esperada:**

```
AMON status
─────────────────────────────
Provider:     ollama
Model:        llama3
Push to SB:   enabled
SB API URL:   https://sentinel-board.vercel.app
Ollama URL:   http://localhost:11434
Ollama:       reachable  (HTTP 200 desde http://localhost:11434/api/tags)
```

**Cuándo usarlo:**
- Para verificar que la configuración del entorno es correcta antes de un `amon run`.
- Para diagnosticar problemas de conexión con Ollama o el provider activo.

---

### `amon doctor`

Ejecuta un diagnóstico completo del entorno y muestra una tabla con el estado de cada verificación.

**Uso:**

```bash
amon doctor
```

**Variables `.env` relacionadas:**

| Variable | Descripción |
|----------|-------------|
| `AMON_AGENTS_PROVIDER` | Provider activo |
| `AMON_AGENTS_MODEL` | Modelo fallback |
| `OLLAMA_BASE_URL` | URL configurada para Ollama |
| `SENTINEL_BOARD_API_URL` | URL configurada para SB |
| `SENTINEL_BOARD_AGENT_TOKEN` | Bearer token (se muestra enmascarado) |
| `AMON_AGENTS_PUSH_TO_SB` | Estado del push automático |

**Chequeos realizados:**

| Check | Descripción |
|-------|-------------|
| CLI path | Ruta del ejecutable (`process.argv[1]`) |
| Working directory | `cwd` actual |
| `.env.local` | Existencia en el directorio de trabajo |
| Node version | Versión de Node.js en uso |
| npm version | Versión de npm disponible |
| Provider activo | Valor de `AMON_AGENTS_PROVIDER` |
| Modelo activo | Modelo resuelto según provider |
| LLM config | Validación de configuración del provider |
| Ollama reachable | Health-check HTTP a `/api/tags` (si provider=ollama) |
| Ollama model installed | Verificación de que el modelo esté descargado (si provider=ollama) |
| SB API URL | URL configurada para Sentinel Board |
| SB Agent Token | Token configurado (enmascarado) o advertencia |
| Push to SB | `AMON_AGENTS_PUSH_TO_SB=true` / `false` |
| `outputs/` directory | Existencia del directorio de salida |
| PATH / ejecutable | Detección de conflictos vía `where.exe amon` o `which -a amon` |

**Salida esperada:**

```
  ╔══════════════════════════════════════════╗
  ║         AMON CLI  ·  doctor              ║
  ║  Orquestador de agentes para desarrollo  ║
  ╚══════════════════════════════════════════╝

  ✔  CLI path                      C:\Dev\amon-agents\src\cli\amon.ts
  ✔  Working directory             C:\Dev\amon-agents
  ✔  .env.local                    cargado desde C:\Dev\amon-agents\.env.local
  ✔  Node version                  v20.14.0
  ✔  npm version                   10.7.0
  ✔  Provider activo               ollama
  ✔  Modelo activo                 llama3
  ✔  LLM config                    válida
  ✔  Ollama reachable              HTTP 200 desde http://localhost:11434
  ✔  Ollama model installed        llama3 encontrado
  ✔  SB API URL                    https://sentinel-board.vercel.app
  ⚠  SB Agent Token                no definido
  ⚠  Push to SB                    disabled
  ✔  outputs/ directory            C:\Dev\amon-agents\outputs
  ✔  PATH / ejecutable             C:\Dev\amon-agents\dist\cli\amon.js

  Resultado: OK con 2 advertencia(s).
```

**Códigos de salida:**

| Código | Condición |
|--------|-----------|
| `0` | Todo OK o solo advertencias (⚠) |
| `1` | Uno o más fallos críticos (✖): provider no configurado, Ollama no accesible, o modelo no instalado |

**Cuándo usarlo:**
- Antes de la primera ejecución de `amon run` en un nuevo entorno.
- Cuando se sospecha de un conflicto de PATH con otro CLI llamado `amon` (por ejemplo, `amon.exe` de Python).
- Como paso de troubleshooting cuando `amon run` o `amon push` fallan.

---

### `amon help`

Muestra la ayuda del CLI con los comandos disponibles.

**Uso:**

```bash
amon help
amon --help
amon -h
```

**Salida esperada:**

```
amon — CLI de AMON Agents

Uso:
  amon run [--task TASK-ID] [--type feature_small] "descripción"
  amon push --task TASK-ID
  amon status
  amon help

Notas:
  - Si AMON_AGENTS_PUSH_TO_SB=true, "amon run" envía a Sentinel Board al terminar.
  - "amon push" siempre envía (force), independientemente del flag de entorno.
  - Las variables se leen desde .env.local en el cwd actual.
```

---

## Comandos planeados

### `amon ingest` *(Fase 2)*

Ingesta archivos Markdown como tasks en Sentinel Board sin pasar por el pipeline de agentes.

**Uso previsto:**

```bash
amon ingest ./docs/ideas/nueva-feature.md
amon ingest ./backlog/*.md --type idea --priority low
```

**Qué hará:**
- Leer archivos `.md` con frontmatter YAML (title, type, priority, tags).
- Transformar cada archivo en un `SBImportPayload`.
- Enviar a `POST /api/agents/import`.

**Cuándo usarlo:**
- Para alimentar el backlog de Sentinel Board desde archivos de documentación.
- Para importar ideas, decisiones o notas técnicas sin pasar por LLM.

**Variables `.env` relacionadas:**

| Variable | Descripción |
|----------|-------------|
| `SENTINEL_BOARD_API_URL` | Base URL de SB |
| `SENTINEL_BOARD_AGENT_TOKEN` | Bearer token |

---

### `amon scan` *(Fase 3)*

Escanea un repositorio y genera tareas automáticas basadas en patrones detectados.

**Uso previsto:**

```bash
amon scan --repo sentinel-board
amon scan --repo . --type security_check
```

**Qué hará:**
- Analizar estructura del repositorio, dependencias, y configuración.
- Detectar TODOs, FIXMEs, dependencias desactualizadas, archivos sin tests.
- Generar una o más cards en Sentinel Board con las observaciones.

**Cuándo usarlo:**
- Como paso de discovery al iniciar trabajo en un repositorio.
- Como check periódico de salud del codebase.

**Variables `.env` relacionadas:**

| Variable | Descripción |
|----------|-------------|
| `AMON_AGENTS_PROVIDER` | Provider LLM para análisis |
| `SENTINEL_BOARD_API_URL` | Base URL de SB |
| `SENTINEL_BOARD_AGENT_TOKEN` | Bearer token |

---

### `amon audit` *(Fase 4)*

Auditoría profunda de un repositorio con análisis de seguridad, calidad y arquitectura.

**Uso previsto:**

```bash
amon audit --repo sentinel-board
amon audit --repo . --focus security
amon audit --repo . --focus architecture --playbook python-radar
```

**Qué hará:**
- Ejecutar análisis multi-agente enfocado (security, architecture, quality).
- Generar un reporte consolidado en Sentinel Board.
- Producir checklist actionable con findings priorizados.

**Cuándo usarlo:**
- Antes de un release o deploy a producción.
- Como auditoría periódica de seguridad o calidad.

**Variables `.env` relacionadas:**

| Variable | Descripción |
|----------|-------------|
| `AMON_AGENTS_PROVIDER` | Provider LLM |
| `SENTINEL_BOARD_API_URL` | Base URL de SB |
| `SENTINEL_BOARD_AGENT_TOKEN` | Bearer token |

---

## Variables de entorno completas

```bash
# ── Provider LLM ──
AMON_AGENTS_PROVIDER=ollama          # ollama | lmstudio | openai | gemini | openrouter | mock
AMON_AGENTS_MODEL=llama3             # Modelo fallback
AMON_AGENTS_ALLOW_MOCK_FALLBACK=false
AMON_AGENTS_LLM_TIMEOUT_MS=30000

# ── Ollama (local) ──
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=llama3

# ── LM Studio (local) ──
LMSTUDIO_BASE_URL=http://localhost:1234
LMSTUDIO_MODEL=local-model

# ── OpenAI ──
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o-mini

# ── Gemini ──
GEMINI_API_KEY=
GEMINI_MODEL=gemini-1.5-flash

# ── OpenRouter ──
OPENROUTER_API_KEY=
OPENROUTER_MODEL=meta-llama/llama-3-8b-instruct

# ── Sentinel Board ──
SENTINEL_BOARD_API_URL=http://localhost:3000
SENTINEL_BOARD_AGENT_TOKEN=
AMON_AGENTS_PUSH_TO_SB=false
```

---

## Ejecución directa (sin CLI)

Además del CLI, el pipeline se puede ejecutar directamente:

```bash
npx ts-node src/core/run-agent.ts <task-id> <task-type> <description> [repo] [playbook]
```

Ejemplo:

```bash
npx ts-node src/core/run-agent.ts TASK-005 feature_small "Crear login OAuth"
```

Este modo lee `.env.local` y ejecuta el mismo pipeline que `amon run`.
