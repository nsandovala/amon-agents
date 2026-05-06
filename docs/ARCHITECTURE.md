# AMON Agents — Architecture

> Visión de arquitectura del sistema AMON Agents y su integración con Sentinel Board.

## Flujo end-to-end

```
Developer (VS Code / Cursor)
        │
        ▼
   amon CLI (.env.local)
        │
        ▼
 ┌─────────────────────────┐
 │     AMON Agents Engine   │
 │  planner → state-guard  │
 │  → qa-reviewer → scorer │
 └───────────┬─────────────┘
             │
             ▼
  POST /api/agents/import
             │
             ▼
 ┌─────────────────────────┐
 │     Sentinel Board       │
 │   (Next.js + Drizzle)   │
 └───────────┬─────────────┘
             │
             ▼
 ┌─────────────────────────┐
 │     Neon (PostgreSQL)    │
 │   Fuente de verdad      │
 └─────────────────────────┘
```

## Componentes

### 1. Developer → amon CLI

El desarrollador ejecuta `amon run` desde la terminal. El CLI lee `.env.local`, parsea flags y dispatcha al comando correspondiente.

- `src/cli/amon.ts` — Entry point.
- `src/cli/parse-args.ts` — Parser de argumentos.

### 2. AMON Agents Engine

Motor de orquestación secuencial de 4 agentes. Cada agente lee YAMLs de configuración, construye un prompt, llama a un LLM, y valida el output contra el contrato.

- `src/core/run-agent.ts` — Motor de ejecución directo.
- `src/commands/run.ts` — Comando `amon run`.
- `src/agents/*.ts` — Agentes del pipeline.
- `src/llm/call-llm.ts` — Capa multi-provider.
- `src/core/types.ts` — Tipos del sistema.
- `src/core/validate-json.ts` — Validación de contratos.

### 3. Configuración viva (YAML)

| Archivo | Propósito |
|---------|-----------|
| `core/core-agents.yaml` | Agentes, misiones, deliverables, constraints |
| `core/routing.yaml` | Task types y flujos de agentes |
| `core/global-rules.yaml` | Reglas globales y anti-patrones |
| `core/output-contract.yaml` | Contrato de salida (campos requeridos + tipos) |
| `core/agent-ownership.yaml` | Scopes y permisos por agente |

### 4. LLM Providers

| Provider | Tipo | API |
|----------|------|-----|
| `ollama` | Local | `POST /api/generate` |
| `lmstudio` | Local | `POST /v1/chat/completions` |
| `openai` | Cloud | `POST /v1/chat/completions` |
| `gemini` | Cloud | `POST /v1beta/models/{model}:generateContent` |
| `openrouter` | Cloud | `POST /v1/chat/completions` |
| `mock` | Dev | Respuestas hardcodeadas para testing |

### 5. Sentinel Board Adapter

Transforma 4 `AgentResult` en 1 `SBUnifiedImportPayload` y lo envía a SB.

```
4 AgentResults → buildUnifiedPayload() → 1 card → POST /api/agents/import
```

- `src/adapters/sentinel-board.ts`

### 6. Sentinel Board (externo)

Aplicación Next.js — dashboard de gestión. Recibe cards desde AMON y las persiste vía Drizzle ORM.

### 7. Neon (PostgreSQL)

Base de datos serverless donde SB almacena cards, usuarios y metadata. **Fuente única de verdad.**

## Estructura del proyecto

```
amon-agents/
├── core/                    # Configuración viva (YAML)
├── src/
│   ├── cli/                 # Entry point del CLI
│   ├── commands/            # Implementación de comandos
│   ├── agents/              # Agentes del pipeline
│   ├── adapters/            # Adaptadores externos (SB)
│   ├── core/                # Motor, tipos, validación
│   ├── llm/                 # Capa LLM multi-provider
│   ├── prompts/             # Templates de prompts
│   └── utils/               # Logger, clean-json
├── playbooks/               # Playbooks por proyecto
├── outputs/                 # Outputs locales (gitignored)
├── docs/                    # Documentación
├── .env.local               # Variables de entorno
├── package.json
└── tsconfig.json
```

## Principios de diseño

1. **Sin DB propia.** AMON Agents es stateless. SB es la fuente de verdad.
2. **Configuración declarativa.** Los YAMLs definen el comportamiento.
3. **Pipeline secuencial.** Cada agente depende del anterior.
4. **Fail-safe.** Errores de push a SB nunca bloquean el pipeline local.
5. **Single-card.** Cada ejecución produce exactamente 1 card en SB.
6. **Multi-provider.** No depende de un LLM específico.
7. **Output-first.** El contrato de salida define lo que es válido, no el prompt.

## Relación con mini-agentes-cli

`mini-agentes-cli` fue un prototipo/laboratorio inicial para probar interacción por terminal, selección de providers y flujo conversacional.

AMON Agents reemplaza esa lógica como runtime oficial en TypeScript, alineado con Sentinel Board y el stack Next.js/Drizzle/Neon.

Elementos reutilizables de mini-agentes-cli:
- UX de comandos interactivos
- selector de provider/modelo
- patrón futuro de event emitter
- experiencia de terminal conversacional

Elementos que NO se migran:
- lógica Python como core del runtime
- persistencia propia
- CLI paralela principal
- contratos de output no compatibles con SB

## Relación con cortex-heo-lab

`cortex-heo-lab` es un laboratorio Python orientado a experimentación con agentes, visualización de pipelines y extensiones de editor. Contiene prototipos de:

- Event emitter para streams de agentes
- Provider selector dinámico
- Visualización tipo Pixel de ejecución de agentes
- Integración con VSCode via sidecar

AMON Agents **no absorbe** cortex-heo-lab. En cambio, lo trata como **fuente de ideas y patrones** para fases futuras:

| Concepto en cortex-heo-lab | Destino en AMON |
|----------------------------|-----------------|
| Event emitter / stream | Fase 6: Event Stream nativo en TypeScript |
| Provider selector UX | Ya implementado en `call-llm.ts` |
| Visualizador Pixel-like | Fase 7: VSCode Extension |
| Pipeline orchestrator | Ya resuelto por `run-agent.ts` |

**cortex-heo-lab sigue vivo** como sandbox de R&D. Sus ideas se gradúan a AMON Agents cuando están validadas y son compatibles con el stack TypeScript/SB.

## AMON Agents como runtime oficial

AMON Agents es el **único runtime oficial** del ecosistema. Esta decisión es intencional:

```
mini-agentes-cli (Python)     →  legacy / laboratorio histórico
cortex-heo-lab (Python)       →  sandbox de R&D / ideas futuras
amon-agents (TypeScript)      →  RUNTIME OFICIAL
```

### Reglas de convivencia

1. **No migrar Python como core.** AMON es TypeScript. Los prototipos Python sirven para validar ideas, no para producción.
2. **No crear doble CLI.** Solo existe `amon` como CLI. No hay `mini-agentes` ni `cortex` compitiendo.
3. **No crear doble runtime.** La orquestación de agentes solo ocurre en `amon-agents`. No hay un segundo pipeline en Python corriendo en paralelo.
4. **Reutilizar ideas, no código.** De los repos Python se toman patrones (UX, event emitter, provider selector), no implementaciones.
5. **Un solo contrato de salida.** `StandardOutput` + `SBUnifiedImportPayload` son el contrato. No hay formato alternativo.

### Justificación del stack

| Criterio | Decisión |
|----------|----------|
| Alineación con SB | SB es Next.js/TypeScript → AMON es TypeScript |
| Tipo de sistema | CLI + adapter HTTP → TypeScript es ideal |
| Contratos tipados | TypeScript ofrece validación estática |
| Ecosystem | npm, ts-node, tsc — mismo toolchain que SB |
| Extensibilidad | VSCode extensions se escriben en TypeScript |