# AMON Agents

**Motor local de agentes, contratos y evidencia operacional del ecosistema AMON.**

AMON Agents (AA) proporciona un CLI, un pipeline de agentes, operaciones controladas de Worker, contratos de misión, validación Guardian y consultas de observabilidad. **No es una interfaz web ni un orquestador autónomo completo.** Sentinel Board (SB) es la interfaz de supervisión; sus capacidades actuales de integración tienen límites explícitos.

> **Estado de esta documentación:** 14 de noviembre de 2026, después de los PR #7–#11. Las funcionalidades enumeradas como implementadas existen en `main`; una compilación o una prueba unitaria no implica por sí sola aceptación funcional de un producto completo.

## Estado operativo

| Capacidad | Estado y límite actual |
| --- | --- |
| CLI `amon` / `amon-agents` | Implementado para planificación, diagnóstico, inspección y operaciones definidas. El paquete declara ejecutables npm; **no se afirma que exista un instalador publicado**. |
| Pipeline LLM | Secuencial: planner → state-guardian → qa-reviewer → scorer. Genera resultados y evidencia; **no equivale a una tarea de programación autónoma completada**. |
| Worker / jobs | Inspección Git, preparación de worktrees y ejecución controlada. `run_coding_tool` sigue restringido al caso *smoke* de OpenCode; no es un ejecutor general de rediseños. |
| Contratos de misión y Guardian | Contratos, estados, aprobaciones locales explícitas y validaciones de evidencia implementados. La aprobación humana sigue siendo obligatoria. |
| Skills de ingeniería | Seis skills canónicas, políticas y gates de preflight/QA/handoff. Los validadores no sustituyen un sandbox ni conceden permisos. |
| Snapshot Ops | Proyección local de Workers, jobs y revisiones. Un snapshot no prueba que un Worker siga conectado en tiempo real. |
| Exportación `sb-mission/1` | Lectura verificada del **inspector aislado MISSION-TEST**, no inventario general de misiones de producto. No transfiere autorización ejecutable. |
| Guardian MCP v0.1 | Servidor local `stdio` de **solo lectura** con cuatro herramientas. Aceptación local con cliente MCP oficial y evidencia histórica documentada; sin HTTP ni ejecución. |

### Aún no implementado o no aceptado como producto integral

- Jarvis Core en Python, coordinación autónoma de varios ejecutores y fallback automático fiable entre cuotas de Codex/Claude/OpenCode.
- Sincronización general y continua de misiones AA ↔ SB, ejecución remota desde SB y transporte de autorización.
- Gobernanza automática del roadmap, métricas verificadas de costo/cuota por proveedor y operación multi-host certificada.
- Servidor MCP público, herramientas MCP de escritura o permisos de release. **No se incluyen en Guardian MCP v0.1.**

## Inicio local

Trabajar desde una copia local completa del repositorio, con dependencias propias y fuera de directorios sincronizados con archivos sin materializar (por ejemplo, iCloud). Se requiere Node.js compatible con las dependencias y un `npm` funcional.

```sh
npm ci
npm run build
npm run amon -- help
npm run amon -- status
```

La configuración local del CLI se carga desde `.env.local` en el directorio de trabajo. Usar `.env.example` **solo como referencia de variables**; nunca versionar claves ni pegar valores privados en informes. Algunos comandos pueden acceder a proveedores de IA o a SB, según la configuración. Revisar los permisos y el costo antes de ejecutarlos.

`package.json` declara tres ejecutables: `amon`, `amon-agents` y `amon-guardian-mcp`. El comando `npm run amon -- ...` evita colisiones con otros binarios globales llamados `amon`.

## CLI: comandos principales

| Comando | Para qué sirve |
| --- | --- |
| `npm run amon -- help` | Ayuda y comandos reconocidos en la versión instalada. |
| `npm run amon -- status` | Configuración y estado disponible del runtime; no implica que SB esté conectado. |
| `npm run amon -- doctor` | Diagnóstico del entorno y conflictos de ejecutable. |
| `npm run amon -- history` | Historial local de ejecuciones. |
| `npm run amon -- run "descripción"` | Pipeline de agentes y generación de outputs; **no significa que se haya editado código**. |
| `npm run amon -- worker` | Worker Host MVP y heartbeat local. |
| `npm run amon -- worker-job ...` | Operaciones tipadas de inspección, worktree y caso smoke; requiere todos los argumentos documentados. Los puntos suspensivos aquí son notación, **no un comando ejecutable**. |
| `npm run amon -- guardian-review ...` | Revisión de evidencia de un job compatible; requiere parámetros explícitos. |
| `npm run amon -- ops-server` | Snapshot HTTP **solo loopback**, de uso local. No equivale a autenticación de clientes. |
| `npm run amon -- scan --repo .` | Inventario estático del repositorio. |
| `npm run amon -- audit --repo .` | Auditoría estática del repositorio. |
| `npm run amon -- watch` | Reservado; todavía no implementado. |

Las variantes completas y sus argumentos están en [CLI_REFERENCE.md](docs/CLI_REFERENCE.md). Ante discrepancias históricas en ese documento, prevalecen `npm run amon -- help` y el código de la versión instalada. `amon push` transmite resultados existentes a SB cuando el operador autoriza y configura esa integración; no es una sincronización automática de misiones.

## Guardian MCP v0.1 — consulta de solo lectura

Después de `npm run build`, un **cliente MCP** puede iniciar un proceso con transporte JSON-RPC `stdio`:

```text
command: node
args:    ["/ruta/absoluta/amon-agents/dist/guardian/mcp-stdio.js"]
cwd:     /ruta/absoluta/amon-agents
```

El `cwd` lo establece el host de confianza, no el modelo mediante un argumento de herramienta. Otra entrada equivalente desde la raíz del proyecto es `npm run --silent mcp:guardian`. **No lanzar este servidor esperando una página web:** se comunica por stdin/stdout con el cliente. No usar el CLI general como wrapper de `stdio`, porque sus banners romperían el protocolo.

| Herramienta MCP | Observación |
| --- | --- |
| `get_runtime_status` | Estado del Worker, antigüedad del heartbeat y disponibilidad de fuentes. |
| `list_recent_jobs` | Jobs históricos, filtros y límites explícitos. |
| `get_guardian_summary` | Veredictos Guardian, conteos y referencias opacas. |
| `get_mission_snapshot` | Observación sanitizada de una exportación `sb-mission/1` previamente creada. |

Fuentes fijas relativas al `cwd` autorizado:

```text
outputs/worker/worker-status.json
outputs/worker/jobs/*.json
outputs/guardian/reviews/*.json
outputs/mission/board-snapshot.json
```

El MCP **no genera** el archivo de misión, no lee el almacén privado de aprobaciones, no acepta rutas o URLs elegidas por el modelo y no ejecuta jobs. Si falta la fuente, devuelve un error seguro como `SOURCE_UNAVAILABLE`. Las respuestas se sanitizan y mantienen `executionAuthorized: false`, incluso ante una aprobación histórica. Los datos antiguos se marcan como antiguos; no se convierten en estado actual.

La aceptación funcional local de MCP-001B comprobó las cuatro consultas con el cliente oficial y evidencia histórica autorizada. Esto **no garantiza** que el Worker esté online ahora, ni acredita producción o coordinación autónoma. El límite de confianza es el usuario/proceso del host; no existe autenticación de red porque este servidor usa únicamente `stdio`.

**Detalles técnicos y QA:** [Guardian MCP stdio](docs/guardian-mcp-stdio.md) y [contratos de lectura](docs/guardian-read-adapter.md).

## Misiones y relación con Sentinel Board

AA conserva contratos de misión, asignaciones, aprobaciones y evidencias locales. El exportador existente permite preparar una observación pública `sb-mission/1` de un inspector aislado ya ejecutado:

```text
npm run mission:export-board -- PRIVATE_STORE FIXTURE_UUID PUBLIC_JSON
```

`PRIVATE_STORE`, `FIXTURE_UUID` y `PUBLIC_JSON` son **marcadores documentales**, no valores para ejecutar literalmente. El host debe usar un almacén de prueba autorizado, identificadores verificados y una ruta pública segura con permisos restrictivos. Este comando no inicia una nueva misión ni concede aprobaciones.

Sentinel Board puede consumir el snapshot de solo lectura cuando el operador configura una entrega local segura. La exportación **no es** una autorización para ejecutar y actualmente no representa todas las misiones del portafolio. Ver [SB-MISSION-001](docs/mission/SB-MISSION-001-export.md).

## Estándares y skills

Las reglas canónicas están en [Execution Standards v1](.agents/standards/policy.md); los contratos de observación y aceptación en [.agents/standards/contracts.md](.agents/standards/contracts.md). Las seis skills viven bajo `.agents/skills/`:

| Skill | Propósito |
| --- | --- |
| `amon-preflight` | Verificar repo, SHA, almacenamiento, dependencias y procesos antes de actuar. |
| `amon-runtime-qa` | Distinguir build/tests de HTTP, autenticación y navegador real. |
| `amon-roadmap-guard` | Proteger el alcance y detectar cambios de roadmap sin aprobación. |
| `amon-handoff` | Evidencia reproducible, limitaciones y decisión humana. |
| `amon-provider-policy` | Restringir cambios de proveedor, endpoint y costo no autorizados. |
| `amon-emulator-verification` | Protocolo Firebase/Next importado desde AMON Shop, versión **1.1.1**; no ejecuta emuladores automáticamente. |

Codex, Claude Code y OpenCode comparten la fuente canónica mediante adaptadores de directorio. La compatibilidad entre sistemas operativos debe verificarse en cada host; la presencia de `SKILL.md` por sí sola no obliga técnicamente a un modelo a cumplirla.

## Estructura del repositorio

```text
core/                 Roles, routing y contrato de salida
src/cli/              Entrada y comandos del CLI
src/mission/          Contratos, estados, aprobaciones y exportación
src/worker/           Worker Host, jobs y worktrees
src/guardian/         Revisiones, lectura sanitizada y Guardian MCP
src/ops/              Snapshot operacional local
src/events/           Eventos y stream NDJSON
src/standards/        Gates deterministas y sus pruebas
.agents/skills/       Skills canónicas
.agents/standards/    Políticas y contratos de ejecución
docs/                 Referencias, decisiones y roadmap histórico
outputs/              Evidencia local (no publicar datos privados)
```

## Criterio de entrega y roadmap

**`DONE` no significa solo TypeScript, build o pruebas verdes.** Para aceptar una funcionalidad se exige evidencia funcional del flujo realmente solicitado (por ejemplo HTTP, cliente MCP, navegador, autenticación o emulador oficial), más el alcance y autorización humana pertinentes. Nunca presentar mocks, datos antiguos o un Worker desconectado como funcionamiento operacional actual.

El [roadmap existente](docs/ROADMAP.md) incluye fases históricas y puede no reflejar todas las entregas posteriores; **no se modifica automáticamente a partir de un sprint**. Los cambios de alcance requieren decisión expresa del propietario.

**Evoluciones propuestas, aún no incorporadas:** Jarvis Core Python, sincronización integral con SB, Roadmap Governance como capacidad de producto, telemetría de modelos/costos y ejecución multi-provider gobernada. La prioridad de esas iniciativas se determina por evidencia y aprobación humana, no por una nueva conversación de agentes.

---

**Principio operativo:** Humanos dirigen; los agentes actúan dentro del alcance aprobado y deben dejar evidencia verificable.
