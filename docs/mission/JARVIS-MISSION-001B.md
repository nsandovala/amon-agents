# JARVIS-MISSION-001B — Coordinación explicable y demostración local

**Dictamen actualizado del 2026-11-11: GO técnico; QA local cerrado con 327/327 pruebas aprobadas en 15 archivos.** Typecheck y build pasan. La salida de Terminal aportada por Nelson confirma la ejecución en el worktree de 001B; el cierre y su procedencia constan al final. Los 321/327 y seis fallos `listen EPERM` descritos más abajo son el registro histórico de la ejecución restringida de Codex. Las 116 pruebas del módulo mission pasan, incluidas las 85 heredadas de 001A y 31 nuevas. No se ejecutaron agentes reales, proveedores, acciones en productos, commit, push, PR, merge ni despliegue.

## Repetir en Terminal del Mac

Las dependencias ya están copiadas localmente; no es necesario instalar ni modificar manifiestos.

```sh
cd /Users/mac/Documents/ChatGPT/AMON/worktrees/JARVIS-MISSION-001B
export PATH=/Users/mac/.nvm/versions/node/v22.22.2/bin:$PATH
npm run demo:mission
```

Para recorrer la salida por páginas, utilizar `npm run --silent demo:mission | less` y salir con `q`. La ejecución es determinista y termina sin esperar entradas. El comando sólo imprime; no escribe archivos, no carga `.env` y no abre servidores. Usa un reloj fijo de fixture, explícitamente simulado, para reproducir expiración, aprobación y evidencia.

Traza JSONL sin mensajes de npm:

```sh
npm run --silent demo:mission -- --jsonl > /Users/mac/Documents/ChatGPT/AMON/artifacts/JARVIS-MISSION-001B/trace-local.jsonl
```

QA:

```sh
npm run typecheck
npm run build
npm test -- src/mission --no-cache
npm test -- src/ops/projection.test.ts --no-cache
npm test -- --no-cache
```

Resultado confirmado posteriormente en Terminal del Mac (véase cierre al final): **327/327** en la suite completa y **116/116** en mission. La suite HTTP contiene 49 pruebas, de las que aquí pasan 43. No se deben contar las seis restantes como aprobadas a partir del cierre previo de 001A. Tras compilar también se puede ejecutar `node dist/mission/demo/cli.js` o añadir `--jsonl`; ambas salidas se cotejaron byte a byte con el comando TypeScript.

## Espacio de trabajo y procedencia

- Repositorio objetivo: `/Volumes/AMON-DEV/amon-agents` (AA).
- Worktree nuevo y persistente: `/Users/mac/Documents/ChatGPT/AMON/worktrees/JARVIS-MISSION-001B`.
- Rama: `sprint/jarvis-mission-001b`; base `a1717ff1c93398f7be352ae17d8f12c734d62442`.
- Antes de implementar se inspeccionaron estado Git, worktrees, `CLAUDE.md`, contratos operacionales, registry, routing y reglas de core. No se encontraron `AGENTS.md` en AA, 001A ni los ancestros inspeccionados.
- Se leyó el informe corregido `/private/tmp/JARVIS-MISSION-001A/docs/mission/JARVIS-MISSION-001A.md` y el respaldo persistente de 001A, incluido su manifiesto SHA-256. Sus **siete archivos coincidieron** antes de copiarlos al worktree nuevo; partir sólo de main habría omitido la entrega.
- Los seis archivos heredados distintos de `state.ts` siguen idénticos en 001B. Únicamente se amplió la copia de `state.ts` de 001B para observar sus comprobaciones. La entrega original de 001A permanece intacta.
- Se conserva en `inherited-001A.json` el manifiesto de incorporación. El cierre 296/296 de 001A procede de la evidencia de Terminal de Nelson documentada en su informe; no se presenta como una ejecución nueva.

### Las dos correcciones P1 y la P2 siguen presentes

| Corrección | Evidencia en 001B |
|---|---|
| P1 temporal | Contrato original exige `approvedAt`; el motor selecciona la aprobación vigente y contrasta `observedAt >= approvedAt`. Escenario 09 y regresiones con evidencia entre issuedAt y approvedAt, límite exacto y renovación. |
| P1 global | `canPerform` y `transition` conservan `validateClaims`. Escenario 11: architect posee aprobación local, pero se bloquea porque security no la tiene. La traza identifica security como origen del fallo. |
| P2 renovación | Se conserva exactamente una aprobación efectiva vigente por tupla. Escenario 10 mantiene el ID revocado y selecciona otro nuevo; el 12 bloquea dos aprobaciones activas. Regresión con historial en ambos órdenes y evidencia anterior a la nueva fecha efectiva. |

## Qué hace la coordinación

`coordinate()` llama a `canPerform()` o `transition()` y devuelve el resultado original junto con una explicación. El motor emite `checks` en el lugar donde evalúa cada condición. La presentación traduce esos códigos y hechos, sin tomar una segunda decisión de autorización. Se preservan orden de validación, fallo cerrado, hash canónico, selección de autorizaciones y revalidación global de 001A.

La propuesta de agente obedece al **rol explícito de la asignación del plan**. No se anuncia un ranking inteligente ni se infieren capacidades del lenguaje natural. Para cada asignación se muestra:

1. Su objetivo y rol requerido por el plan.
2. La capacidad concreta `executor:<rol>` y la consulta real `typeof AGENT_REGISTRY[rol] === 'function'`.
3. Los otros cinco roles: si carecen de ejecutor y/o si su rol no coincide con el requerido. No se sustituyen roles automáticamente.
4. Permisos separados de host, misión y asignación; aprobaciones encontradas, su estado efectivo, historial y aprobación seleccionada cuando la validación llega a ella.
5. Dependencias declaradas y controles realizados; una dependencia que sólo dice completed no prueba su evidencia.
6. Requisitos de evidencia por acción, candidatos examinados y criterios fallidos. Se indica expresamente cuándo no se evaluó la finalización.
7. Primer bloqueo real y forma de resolverlo. No se marcan como aprobados los controles posteriores que no llegaron a ejecutarse.

Los campos narrativos nunca crean acciones ni aprobaciones. La disponibilidad del ejecutor tampoco concede permisos. La consulta de elegibilidad no invoca al agente ni acredita trabajo realizado.

La vista humana resume duplicaciones y controles globales exitosos; conserva detalles de la asignación consultada, evidencias de sus dependencias y fallos globales. La traza JSONL conserva **todos** los controles, en orden, incluidos sus sujetos, acción y hechos. El estado `completed` puede ser de una asignación o de la misión: el campo `request` y el encabezado del paso identifican cuál.

## Recorrido observable

Hay 14 escenarios visibles (el 02 se ejecuta por separado para Designer y Dev), con 49 eventos numerados dentro de cada escenario.

| Escenario | Decisión visible |
|---|---|
| 01 | Architect es elegible: rol del plan, ejecutor y aprobación coinciden. |
| 02 Designer / 02 Dev | `EXECUTOR_UNAVAILABLE`; siguen sin ejecutor, aun con permisos de fixture. |
| 03 | `ACTION_OUT_OF_SCOPE`: falta permiso del host aunque existe ejecutor y registro de aprobación. |
| 04 | `AUTHORIZATION_MISSING_OR_AMBIGUOUS`: la narrativa afirma autorización, pero no hay registro. |
| 05 | `AUTHORIZATION_EXPIRED_OR_FUTURE` exactamente al vencer la aprobación. |
| 06 | `NOT_APPROVED` después de revocarla. |
| 07 | `PLAN_OR_SCOPE_CHANGED`: se cambia el objetivo sin cambiar la versión; el hash detecta la modificación. |
| 08 | `DEPENDENCY_INCOMPLETE`: security no puede estar ready mientras architect esté planned. |
| 09 | `COMPLETION_EVIDENCE_MISSING`: evidencia de las 10:30, posterior a issuedAt 10:00 pero anterior a approvedAt 11:00. |
| 10 | La misma tarea se bloquea; el host simulado registra renovación a las 12:00 conservando el ID revocado. Se recupera explícitamente blocked → planned → awaiting_approval → approved, consulta elegibilidad y acepta evidencia nueva a las 12:00. |
| 11 | La aprobación local de architect no evade la aprobación global ausente de security. |
| 12 | Dos aprobaciones activas bloquean; no se elige la última ni la primera. |
| 13 | Misión desde draft, aprobaciones y dependencias verificadas, architect → security → qa → ops, cuatro resultados SIMULADOS y cierre de misión con evidencia válida según los contratos. |

Cada resultado esperado es una aserción contra el retorno real del motor. Si el comportamiento cambia, la demo termina con código 1 en lugar de imprimir éxito inventado. Una opción CLI desconocida termina con código 2.

## Comprobaciones reales, simulaciones y límites

| Real | Simulado | Pendiente o fuera de esta entrega |
|---|---|---|
| Validación de contratos, tabla de estados, hash SHA-256, permisos, reloj suministrado, aprobaciones, dependencias y metadatos de evidencia | Reloj, alias LOCAL-FIXTURE, SHA, rama, aprobador y registros de aprobación | Autenticación de humanos, ledger seguro/transaccional y observación de un repositorio real |
| Consulta del registry y flujo de `core/routing.yaml` | Contenido de salidas de agentes y evidencia de ejecución, marcados `SIMULATED-*` | Disponibilidad de proveedores y evaluación de calidad real de los agentes |
| Validación del contrato StandardOutput de cada resultado de fixture | Ejecución de architect, security, qa y ops | Ejecución de agentes, jobs o herramientas reales; QA de producto |
| Las 31 nuevas regresiones, 85 heredadas de mission, typecheck, build y CLI | LLMs y jobs simulados por las pruebas existentes de la suite | Seis pruebas HTTP pendientes de loopback en Terminal |

`Context` conserva su frontera de confianza: proviene del host, no de un LLM o endpoint. Una función registrada demuestra disponibilidad de esa implementación, no salud del proveedor ni capacidad probada para cualquier acción. No se introduce un catálogo de capacidades dinámicas ni se amplían permisos. QA es revisión de plan y Ops evaluación; no implican correr pruebas de producto o desplegar.

El helper de simulación está en `src/mission/demo/`; sólo el runner de demo lo llama. El coordinador y el motor no importan ese helper ni generan evidencia. Los escenarios negativos pueden introducir deliberadamente metadatos inválidos para demostrar su rechazo. Cada evento JSONL marca `checks: real-engine`, `data: isolated-fixture` y `agentExecution: none | simulated`. Una validación real sobre un fixture no certifica que ocurrió una ejecución real.

La salida estructurada omite objetivos narrativos, expectedOutputs, identidad del aprobador y snapshots completos. No se leen `.env`, credenciales ni salidas de productos. Los fixtures sólo contienen metadatos sintéticos. La API reusable exige metadatos no sensibles del host; no se promete detectar cualquier secreto arbitrario incrustado en un identificador, ni en el objetivo que muestra el renderer humano.

No hay integración nueva con CLI operacional, pipeline de ejecución, Worker, Guardian, Sentinel Board o BracketFlow. `core/routing.yaml`, registry y pipeline permanecen iguales; Designer y Dev siguen undefined.

## QA ejecutado por Codex antes del cierre local

Node 22.22.2 y Vitest 2.1.9, dependencias copiadas desde 001A sin red, cambios de lockfile ni instalación.

| Comprobación final | Resultado |
|---|---|
| `npm run typecheck` | PASS |
| `npm run build` | PASS |
| Suite completa sin caché | **321 PASS / 6 FAIL / 327 total**, 14 archivos pasan y 1 falla |
| Mission dentro de la suite completa | **116/116 PASS**: 81 contracts, 4 pilot-reader, 31 explain |
| CLI TypeScript humano y JSONL | PASS; 49 eventos, 14 escenarios, final completed de fixture |
| CLI compilado | Salidas idénticas byte a byte a las de TypeScript |
| Opción CLI inválida | Código 2, sin salida de éxito |
| Preservación | Comparación exacta de 15 worktrees originales: archivos rastreados/no ignorados, no rastreados, índice binario, HEAD y ramas existentes |
| Índice de 001B | Sin staging; HEAD sigue en la base original |

Los seis fallos pertenecen a `src/ops/projection.test.ts`: servir snapshot, rechazar métodos distintos de GET, ausencia de ruta de mutación, iniciar IPv4 loopback, accesibilidad del endpoint y smoke de esquema del CLI. Todos fallan con `listen EPERM`; no se modificaron ni omitieron. No se intentó eludir el sandbox. El aviso CJS preexistente de Vite continúa.

Regresiones nuevas: explicación de rol/capacidad y alternativas; tres capas de permisos; ausencia, expiración, revocación, modificación y ambigüedad de aprobaciones; narrativa no autoritativa; P1 global; dependencia incompleta o declarada completed sin evidencia; P1 temporal; P2 con historial invertido; evidencia ausente, de otro plan/acción/base, futura o no done; límite exacto approvedAt; inmutabilidad; omisión de narrativa sensible en JSON; contratos malformados; demo determinista; no invocación de ejecutores, fetch, execFile o spawn; conservación del flujo y roles no disponibles.

## Preservación y archivos de revisión

Se verificó BF en `feat/operator-consolidation-v1` con sus cambios preparados y archivos sin seguimiento. Los hashes antes/después de su índice y archivos coinciden, al igual que HEAD y referencias de ramas. Se verificaron asimismo los otros worktrees de BF, Sentinel Board y AA. No se ejecutó stash, reset, clean, checkout, commit ni push en BF. El único cambio esperado en referencias de AA es la nueva rama de 001B.

Cambios propios de 001B:

- `package.json`: comando `demo:mission`.
- `src/mission/state.ts`: observaciones de los controles existentes; sin modificación de los contratos de autorización.
- `src/mission/explain.ts`: coordinación, proyección de hechos y presentación en español.
- `src/mission/demo/{fixtures,run,cli}.ts`: escenarios aislados, aserciones y CLI.
- `src/mission/explain.test.ts`: 31 regresiones.
- Este informe. Los otros archivos de 001A se incorporan sin modificación.

Artefactos persistentes en `/Users/mac/Documents/ChatGPT/AMON/artifacts/JARVIS-MISSION-001B/`:

- `demo.txt`, `trace.jsonl`: salidas ejecutadas, legible y estructurada.
- `typecheck.txt`, `build.txt`, `qa-full.txt`: evidencia de QA, incluidos los seis fallos.
- `inherited-001A.json`: hashes cotejados antes de incorporar 001A.
- `preservation-before.json`, `preservation-after.json`, `preserve.py`: comprobación de integridad de los worktrees originales. Sólo contienen metadatos y hashes, no contenido de archivos.
- `JARVIS-MISSION-001B-review.patch`: entrega completa sobre main, incluida 001A corregida.
- `001B-only.patch`: diferencias de 001B respecto de la entrega corregida de 001A.
- `reviewed-files.zip`, `sha256.json`: respaldo de archivos entregados y manifiesto.

La extensión supera la guía ideal de 300 líneas porque incorpora la base 001A, instrumentación, explicación, demo y regresiones; permanece aislada del flujo operacional. Para abandonar la entrega basta dejar de usar este worktree. No se requiere revertir cambios en productos. No se elimina el worktree ni se realiza commit, push o PR.


## Cierre de QA local y autorización de publicación — 2026-11-11

**GO técnico para revisión de commit/PR; sin autorización de merge.** Nelson aportó la salida de Terminal del worktree `sprint/jarvis-mission-001b`, ejecutada a las 01:26 America/Santiago. Se revisó esa evidencia y se cotejaron los 14 archivos de entrega con su manifiesto SHA-256: coincidencia exacta antes de esta actualización documental.

- `npm run typecheck`: PASS.
- `npm run build`: PASS.
- `npm test -- src/mission --no-cache --passWithNoTests=false`: **116/116 PASS**, 3 archivos.
- `npm test -- --no-cache --passWithNoTests=false`: **327/327 PASS**, 15 archivos.
- `npm run --silent demo:mission | less`: la salida aportada muestra el final esperado; la misión se completa únicamente dentro del fixture simulado.

Es evidencia ejecutada por Nelson y revisada por Codex, no una nueva ejecución del agente. Los seis fallos de loopback de la ejecución restringida quedan resueltos por esta ejecución local. Las 211 pruebas anteriores se ejecutaron en el checkout principal, que aún no contenía mission; no validaban 001B. Los mensajes de errores esperados dentro de pruebas negativas y el aviso CJS de Vite no representan pruebas fallidas.

La copia local del registro está en `artifacts/JARVIS-MISSION-001B/qa-local-2026-11-11.txt` del workspace. No se publica el log bruto de la terminal. Tras validar el cierre, Nelson autorizó commit, push y apertura de PR, expresamente **sin merge**. Se preparan dos commits consecutivos, uno por sprint: 001A corregida y 001B. `main`, BF y SB permanecen intactos. La autorización de publicación no habilita ejecución real de agentes, acciones en productos ni despliegue.

SHA-256 de la evidencia local: `e1bfe7c0e9bbdb8892cf9abb6e1d0596c23d86ce8a6acdb50be59ecd93f7d321`.
