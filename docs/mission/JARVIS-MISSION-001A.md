# JARVIS-MISSION-001A — Mission Contract Foundation v0.1

Reauditoría del 2026-11-11: los dos P1 están corregidos y el P2 resuelto, con 31 pruebas de regresión añadidas. GO técnico: QA local cerrado mediante la salida de terminal aportada por Nelson, con 6/6 pendientes y 296/296 en la suite completa. El detalle y la procedencia de esa evidencia constan al final. NO-GO para ejecutar BF-HOME-001. No se realizó commit, push, PR, merge ni deploy. Los resultados vigentes y la recuperación del worktree se detallan al final; las cifras del 6 de noviembre se conservan como registro histórico.

## Entorno y preservación

- Base: `main`, `a1717ff1c93398f7be352ae17d8f12c734d62442`, checkout original limpio.
- Rama nueva: `sprint/jarvis-mission-001a`.
- Worktree exclusivo: `/private/tmp/JARVIS-MISSION-001A`.
- JARVIS-004C-SMOKE-001 permanece limpio. Los tres JARVIS-004D-SMOKE-001/002/003 conservan únicamente el archivo no rastreado `sandbox/JARVIS-004D-SMOKE.md`.
- Los tres archivos coinciden byte a byte con `EXPECTED_CODING_TOOL_CONTENT` de `src/worker/jobs.ts`. SHA-256: `6ca0bdab22d03155e243d6e56c8d1f57d399edfcf477e30570e3b99e2a1a8ed2`.
- No se encontró AGENTS.md en el repositorio ni en sus ancestros inspeccionados. Se revisaron CLAUDE.md y los contratos operacionales de core, pipeline, registry, worker y Guardian.
- Dependencias copiadas localmente desde la instalación existente, sin instalar ni cambiar package.json/package-lock.json. `node_modules/` y `dist/` son artefactos ignorados. La copia local sustituye el enlace temporal usado inicialmente.

## Arquitectura y contratos

La nueva carpeta `src/mission` no está conectada al CLI, pipeline, motor de jobs, Guardian, Sentinel Board ni un servidor. No ejecuta agentes. `canPerform` es una consulta de elegibilidad; `transition` devuelve una copia validada del estado.

| Contrato | Campos | Validación y reutilización |
|---|---|---|
| MissionContract | schemaVersion, missionId, taskType, objective, repositoryAlias, baseSha, branch, status, planVersion, assignments, authorizationPolicy, evidenceRefs | Versión 0.1; SHA completo; alias seguro; TaskType existente; IDs únicos; grafo acíclico y referencias existentes. Política explícita intersectada con política del host. |
| AssignmentContract | assignmentId, missionId, role, goal, scope, dependencies, expectedOutputs, allowedActions, status, evidenceRefs | AgentName existente; scope es identificador lógico, no ruta; expectedOutputs reutiliza StandardOutput y validateOutput/output-contract.yaml. Roles declarativos válidos aunque aún no tengan ejecutor. |
| AuthorizationContract | authorizationId, missionId, assignmentId, action, approvedBy, planVersion, planHash, scope, issuedAt, expiresAt, approvedAt, decision | Fecha efectiva de aprobación obligatoria (null en pending/denied; timestamp en approved/revoked); fechas ISO UTC estrictas; ventana válida; misión/asignación/acción/scope exactos; aprobador reconocido por host; versión y hash SHA-256 del plan. |
| EvidenceContract | source, jobId, action, status, observedAt, verifiedBaseSha, verifiedBranch, evidenceReference, missionId, assignmentId, planHash | Reutiliza WorkerJobAction/WorkerJobStatus. Referencia lógica segura; fuente worker o assignment; evidencia de asignación ligada al plan, asignación y acción. Preparación no completa asignaciones. |

Se rechazan propiedades desconocidas en los cuatro contratos y en las salidas esperadas. Las funciones públicas que toman decisiones validan runtime; no basta con un cast TypeScript. `parseMission` comprueba estructura/grafo; por sí solo no certifica una aprobación o una ejecución. La certificación operacional necesita el Context confiable.

El hash canónico cubre objetivo, repositorio, SHA, rama, versión, política, orden y contenido de asignaciones, dependencias, permisos y salidas esperadas. Excluye únicamente estados y referencias de evidencia. Cambiar contenido sin aumentar planVersion igualmente invalida la autorización.

## Estados y transiciones

Misión y asignaciones guardan estados por separado. Comparten la tabla de transiciones, con controles distintos según entidad.

| Desde | Destinos permitidos |
|---|---|
| draft | planned, blocked, failed |
| planned | awaiting_approval, blocked, failed |
| awaiting_approval | approved, blocked, failed |
| approved | ready, blocked, failed |
| ready | completed, blocked, failed |
| blocked | planned, blocked, failed |
| failed | planned, blocked |
| completed | Ninguno |

- `approved`: requiere al menos una acción, ejecutor registrado y autorización vigente para cada acción seleccionada. Aprobar la misión exige autorización de todas sus asignaciones; es deliberadamente conservador en v0.1.
- `ready`: además exige dependencias completed, verificadas recursivamente con evidencia vinculada. Una misión approved puede habilitar progresión individual; no necesita estar ready para cada transición individual.
- `completed`: requiere evidencia done por acción, misión, asignación y hash; SHA/rama correctos y observación igual o posterior a approvedAt, la fecha efectiva de aprobación de la autorización vigente seleccionada. Completar la misión exige todas sus asignaciones completed.
- `canPerform`: exige misión approved/ready, asignación ready, permiso simultáneo de host/misión/asignación, aprobación vigente y dependencias satisfechas. Revalida también las autorizaciones de todas las asignaciones y las afirmaciones de estado de misión/asignaciones, igual que `transition`. No invoca al ejecutor.
- Un error devuelve `ok:false`, `status:blocked` y, cuando la estructura pudo validarse, una copia bloqueada. No modifica el objeto original. Un contrato malformado no produce una falsa misión válida.
- `blocked -> planned` permite replantear explícitamente; nunca concede permiso. Datos insuficientes no habilitan `ready` ni `completed`. Reconstruir por JSON no elimina blocked.
- Los estados previos approved/ready/completed de misión y asignaciones se vuelven a comprobar durante las transiciones y la consulta de elegibilidad; el estado serializado no constituye autoridad.

Autorización usa un dominio distinto: `pending -> approved | denied`, `approved -> revoked`; denied/revoked son terminales. `expired` e `invalid` son estados efectivos calculados por reloj/validación, sin transiciones de recuperación. Una autorización nueva requiere otro registro explícito del host. `transitionAuthorization` fija approvedAt al aprobar y lo conserva al revocar, sin modificar issuedAt ni el registro de entrada. Sólo modela esta contabilidad; no autentica a Nelson ni recibe solicitudes remotas.

## Piloto BF-HOME-001

La lectura real del archivo existente `outputs/worker/jobs/BF-HOME-001-PREPARE-02.json` comprobó acción prepare_worktree, estado done, exitCode 0, historial queued/running/done consistente, rutas de configuración fija, SHA fuente/worktree y rama. No se creó ni ejecutó otro job.

Observación de Git de sólo lectura: **2026-11-06T03:29:12.993Z**.

| Comprobación | Resultado |
|---|---|
| Rama actual | worker/BF-HOME-001 |
| SHA actual y base autorizada | e80aae09009f64d228a613ab7ac079882cfbd0b4 |
| Estado Git con archivos no rastreados | Limpio |
| Preparación | Verificada en el instante observado |
| Rediseño | No ejecutado |
| Misión | awaiting_approval |
| Architect | planned, diagnóstico propuesto sin escritura |
| Designer | blocked, sin ejecutor |
| Dev | blocked, sin ejecutor ni aprobación |
| QA | blocked, depende de Dev y evidencia posterior |
| Permisos | Vacíos en misión y todas las asignaciones |

`BF-HOME-001-reconciliation.json` contiene el snapshot reconstruido completo y la evidencia normalizada. No contiene una autorización formal. La observación es histórica, no una garantía indefinida: una nueva reconciliación exige observación de máximo 60 segundos de antigüedad. Drift, suciedad, fallo de lectura o evidencia insuficiente bloquean sin reparación automática.

El lector tiene configuración fija del piloto; no toma rutas desde una misión. Comprueba realpath, rechaza redirección por symlink, abre evidencia con O_NOFOLLOW, limita tamaño a 1 MiB y cierra el descriptor incluso ante error. Sólo usa execFile para comandos Git de lectura con argumentos fijos, sin shell ni interpolación de misión. HEAD se verifica antes y después de la observación.

## Pruebas y resultados reportados el 2026-11-06 (históricos)

Node usado: **22.22.2**, ya instalado en `/Users/mac/.nvm/versions/node/v22.22.2/bin`. El Node 25 de Homebrew no arrancó por ausencia de libsimdjson.31.dylib; no se reparó ni modificó.

| Comprobación final | Resultado |
|---|---|
| npm run typecheck | PASS |
| npm run build | PASS |
| npm test -- src/mission --no-cache | 54/54 PASS, 2 archivos |
| npm test -- --no-cache --exclude src/ops/projection.test.ts | 216/216 PASS, 13 archivos; incluye las 54 nuevas |
| npm test -- src/ops/projection.test.ts --no-cache | 49/49 PASS, repetición autorizada fuera del sandbox para loopback |
| Total de pruebas distintas | **265/265 PASS** entre las ejecuciones indicadas |
| inspectPilot real compilado | environmentVerified=true; errors=[] |

La primera ejecución de 51 casos pasó las aserciones pero terminó con error de escritura de caché sobre el enlace temporal de dependencias. Se desactivó caché y posteriormente se reemplazó el enlace por copia local. La regresión completa inicial pasó 256/262 y falló 6 pruebas preexistentes por listen EPERM del sandbox; el archivo ops completo pasó al repetirse con permiso. Dos errores de tipos literales en fixtures nuevos se corrigieron antes del typecheck/build final. No quedan fallos conocidos. Vite emite un aviso preexistente de deprecación CJS.

Los tests de llamadas LLM usan fetch simulado; el pipeline de las pruebas de comandos está simulado. Los tests de jobs/Guardian se ejecutan con fixtures y dependencias de prueba, no sobre BracketFlow. No se consumieron proveedores reales ni herramientas de programación.

Cobertura de los 15 requisitos: misión válida/malformada; roles desconocidos y sin ejecutor; ciclo; dependencia incompleta; sin autorización; aprobación expirada; otra misión; plan modificado; evidencia ausente; SHA incorrecto; reutilización idempotente del job; reconstrucción BF; acciones fuera de alcance; blocked conservado al serializar/reintentar. Se añaden duplicación de autorizaciones/evidencia/job, cambios anidados del plan, decisiones denegadas/revocadas, ausencia de aprobador confiable, saltos inválidos de estado, éxito con evidencia vinculada, drift/observación caducada, symlinks, JSON inválido y evidencia sobredimensionada.

## Límites, riesgos y recuperación

- Los ejecutores reales disponibles son architect/planner, security/state-guardian, qa/qa-reviewer y ops/scorer. Designer y Dev siguen undefined en AGENT_REGISTRY. No se ha delegado trabajo a ninguno durante este sprint.
- QA registrado es un revisor de plan; no equivale a ejecutar pruebas de producto. Guardian determinista existente sólo revisa run_coding_tool; no se amplía ni se utiliza para certificar preparación. La última asignación representa la futura verificación QA/Guardian, no una integración ya implementada.
- Context es una frontera confiable proporcionada por código del host. La validación no autentica humanos, firma evidencias ni crea un almacén seguro de aprobaciones. No debe exponerse directamente a entrada LLM/HTTP. Un contrato y su approvedBy escritos por un LLM nunca bastan para permiso.
- Campos narrativos no se interpretan como comandos, rutas ni permisos. Los contratos no tienen campos de credenciales y el lector no registra contenido bruto. No se pretende detectar cualquier secreto escrito por un humano en texto libre; los llamadores deben proporcionar metadatos no sensibles.
- IDs duplicados se rechazan en el snapshot; una misma identidad de job con otra referencia también se rechaza. No existe almacenamiento transaccional ni deduplicación global entre procesos/misiones; eso pertenece a una futura integración. El motor de jobs existente conserva su protección contra evidencia preexistente y no se modifica.
- Reconciliación es pura y determinista con iguales entradas, no reintenta jobs. Para recuperar: corregir evidencia/configuración en un proceso separado autorizado, observar nuevamente y reconstruir. Si el plan cambia, registrar nuevas autorizaciones; no reciclar las anteriores.
- Se conserva un criterio conservador: las dependencias completed se revalidan con autorizaciones vigentes. Si expiran, la progresión se bloquea. Una semántica futura de aprobación válida al momento de ejecución necesitará un ledger confiable.
- La observación Git no es una transacción con el sistema de archivos; no elimina completamente carreras con modificaciones externas concurrentes. No hay ejecutor conectado que pueda aprovechar una ventana de carrera. Un futuro ejecutor deberá revalidar inmediatamente antes de actuar.
- La persistencia implementada es serialización/reconstrucción de snapshots y estados en memoria; no hay journal, base de datos, scheduler, endpoint ni garantía de exactly-once.
- El piloto específico usa rutas fijas del host. Una futura generalización requiere registro confiable de alias; nunca aceptar rutas libres del usuario.
- No se altera routing.yaml: el orden Architect -> Designer -> Dev -> QA es un plan declarativo aislado, no un cambio del flujo global Architect -> Security -> QA -> Ops.

## Archivos y revisión

Sólo se añaden archivos:

- `src/mission/contracts.ts`: tipos, validación runtime estricta, grafo y hash canónico.
- `src/mission/state.ts`: transiciones, elegibilidad, aprobación y evidencias.
- `src/mission/pilot.ts`: instancia del plan, lectura fija y reconciliación.
- `src/mission/contracts.test.ts`: 81 casos de contratos/estados/piloto (50 originales y 31 de regresión).
- `src/mission/pilot-reader.test.ts`: 4 casos de lectura segura.
- `docs/mission/BF-HOME-001-reconciliation.json`: evidencia normalizada e instancia reconstruida.
- `docs/mission/JARVIS-MISSION-001A.md`: este informe.

No se modifica ningún archivo existente del motor. El alcance supera la guía ideal de 300 líneas porque incluye cuatro contratos, validación, dos dominios de estados, lector del piloto y pruebas de seguridad; permanece en un módulo nuevo sin conexión operacional.

El diff completo se entrega fuera del repositorio en `/private/tmp/JARVIS-MISSION-001A-review.patch`, sin staging ni commits. Para rollback local basta abandonar este nuevo worktree; no hay cambios a revertir en consumidores. La eliminación del worktree no forma parte de esta entrega.

**Decisión pendiente de Nelson:** revisar contratos, política conservadora de aprobación/expiración y límites de confianza. GO para considerar un commit/PR posterior sólo con su autorización; NO-GO para ejecutar el rediseño, habilitar Dev/Designer o ampliar permisos.


## Corrección y reauditoría — 2026-11-11

### Recuperación y preservación

Antes de editar se detectó que faltaban `.git`, 106 archivos rastreados y los siete archivos nuevos del worktree temporal; también faltaba el parche. No se determinó la causa. El registro de Git y la rama seguían en la base original. Se restauraron únicamente los archivos base ausentes desde los blobs de `a1717ff1c93398f7be352ae17d8f12c734d62442`, y se recuperaron los siete archivos nuevos a partir de las salidas de la auditoría anterior. Los siete SHA-256 coincidieron exactamente con los verificados entonces. Ningún archivo existente fue sobrescrito durante la recuperación.

Las dependencias faltantes se copiaron desde la instalación local existente, sin red ni cambios de manifiestos. La copia original recuperada está fuera de `/tmp`, en `/Users/mac/Documents/ChatGPT/AMON/artifacts/JARVIS-MISSION-001A/recovered-original.zip`. Ese directorio también contiene el parche actualizado, el respaldo final de los siete archivos y la comparación de preservación de los otros worktrees. No se modifica el índice ni se hace staging.

### Hallazgos resueltos

- **P1 temporal:** AuthorizationContract exige `approvedAt`. Pending/denied requieren null; approved/revoked requieren fecha ISO UTC dentro de `[issuedAt, expiresAt)`. Aprobar registra el reloj confiable del host. La elegibilidad rechaza fechas futuras; completar exige evidencia desde la aprobación efectiva, sin retroactividad. Los registros antiguos sin este campo se rechazan: el host debe emitir registros explícitos válidos, nunca inferir approvedAt de issuedAt.
- **P1 global:** `validateClaims` revalida la aprobación de todas las asignaciones y sus estados en `canPerform` y `transition`. Un JSON que diga approved/ready no sustituye las autorizaciones globales. Para una misión approved, las dependencias siguen habilitando el avance individual en orden; no se exige que todas las asignaciones estén ready simultáneamente. Las afirmaciones de misión ready/completed también se verifican.
- **P2 renovación:** Context conserva un snapshot por authorizationId y puede contener historial de IDs distintos. Pending, denied, revoked, expiradas y futuras no son autorizaciones activas. Se exige exactamente una aprobación efectiva vigente para la tupla misión/asignación/acción; después se comprueban hash, versión, scope, aprobador y permisos. Dos activas se bloquean incluso si una tiene otro plan: no se elige por orden ni por la fecha más reciente. El host revoca el registro previo antes de renovar; la revocación reemplaza la decisión de ese mismo ID, sin duplicarlo. La validación estructural y de IDs incluye todo el historial. Tanto elegibilidad como finalización usan el mismo registro seleccionado.

No se añade autenticación, ledger transaccional, endpoint, ejecutor ni almacenamiento persistente de autorizaciones. Context sigue siendo una frontera de confianza del host. Ningún texto de misión concede permisos ni se transforma en comandos.

### Verificación ejecutada por Codex antes del QA local

Node 22.22.2; Vitest 2.1.9; código fuente restaurado y corregido, sin ejecutar agentes ni proveedores reales.

| Comprobación | Resultado verificado el 2026-11-11 |
|---|---|
| Typecheck (`tsc --noEmit`) | PASS |
| `npm run build` | PASS |
| `npm test -- src/mission --no-cache` | **85/85 PASS**: 81 contratos/estados y 4 lector |
| Casos añadidos para esta corrección | **31**, incluidos límites temporales, aprobación global, renovación/historial y secuencia positiva architect→security→qa→ops |
| `npm test -- --no-cache` | **290 PASS / 6 FAIL / 296 total**, 13 archivos de pruebas pasan y 1 falla |
| Causa de los seis fallos | `listen EPERM: operation not permitted 127.0.0.1`, todos en `src/ops/projection.test.ts`; no se declaran PASS |
| Reconstrucción del snapshot histórico | Coincidencia exacta con el JSON conservado |
| `inspectPilot()` desde el build actual | environmentVerified=true, errors=[], observedAt=2026-11-11T03:11:35.140Z |
| Estado de BracketFlow | awaiting_approval, permisos vacíos en misión y asignaciones, rama worker/BF-HOME-001, SHA e80aae09009f64d228a613ab7ac079882cfbd0b4 |
| Pruebas adicionales sobre el build | Los dos P1 se bloquean, el P2 admite renovación con historial; hash estable ante orden de claves/serialización/estados y cambia en 22 mutaciones del plan |
| Hash determinista del plan piloto | 7b559922386b5a1d70944296949df54a2d3f22c67849b324765d0881cedd2de4; idéntico al auditado antes |

Las 265 pruebas originales son una cifra histórica. En esta ejecución de Codex aún no se acreditaba un PASS completo; la ejecución local posterior que lo cierra consta al final. Las 31 nuevas aumentan el total a 296. Las seis pruebas HTTP no pudieron completarse por la restricción de puertos del entorno de ejecución. No se alteraron, omitieron ni simularon para obtener un resultado verde. El aviso CJS de Vite permanece.

El pipeline, routing, registry, jobs y Guardian no tienen cambios. La secuencia positiva probada es de contratos y estados; no representa una integración ni ejecución real del pipeline. Designer/Dev continúan sin ejecutor y el piloto conserva cero permisos.

### Dictamen previo al QA local (superado por el cierre siguiente)

**GO técnico condicionado:** los dos P1 y el P2 están resueltos en el módulo aislado. **Pendiente para un GO definitivo de commit/PR:** verificar en la terminal local las pruebas HTTP que aquí requieren abrir loopback. No existe autorización para commit, push, PR, merge, despliegue o ejecución del rediseño.

Desde el worktree, usando el Node 22 ya instalado:

```sh
cd /private/tmp/JARVIS-MISSION-001A
export PATH=/Users/mac/.nvm/versions/node/v22.22.2/bin:$PATH
npm run typecheck
npm run build
npm test -- src/ops/projection.test.ts --no-cache
npm test -- --no-cache
```

El resultado esperado para la suite completa corregida es 296/296; sólo debe declararse verificado cuando se haya obtenido esa ejecución. No se recibieron comandos adjuntos adicionales en el chat al preparar este informe.

## Cierre de QA local — 2026-11-11, 00:25 America/Santiago

**GO técnico para JARVIS-MISSION-001A.** Los dos P1 y el P2 están resueltos y la condición pendiente de QA local queda satisfecha. Este dictamen no autoriza commit, push, PR, merge, despliegue ni ejecución de BF-HOME-001.

Evidencia: salida de Terminal del Mac adjuntada por Nelson en el chat, leída y revisada por Codex. No se presenta como una nueva ejecución realizada por Codex. El registro muestra el worktree `/private/tmp/JARVIS-MISSION-001A`, Node 22.22.2 y Vitest 2.1.9:

| Ejecución local | Resultado en la evidencia adjunta |
|---|---|
| Filtro de las seis pruebas HTTP pendientes | **6 passed, 43 skipped**; las 43 omisiones corresponden al filtro |
| `npm test -- --no-cache` | **296 passed (296), 14 passed (14)**; sin pruebas fallidas ni omisiones reportadas |
| Pruebas del módulo incluidas en la suite completa | **81 + 4 = 85**, incluidas las 31 regresiones añadidas |

Los mensajes `[ERROR]` sobre direcciones no permitidas y configuración inválida forman parte de pruebas negativas que pasan. El aviso de deprecación CJS de Vite no impide el resultado verde. La ejecución local resuelve los seis fallos `listen EPERM` del entorno anterior, que permanecen documentados como historial.

Antes de registrar este cierre se cotejaron los siete archivos del worktree con el manifiesto SHA-256 de la entrega corregida: coincidencia exacta. Después sólo se actualizan este informe y sus artefactos de revisión; no se cambian fuentes ni pruebas y no es necesario repetirlas por esta actualización documental.

Copia conservada de la evidencia: `/Users/mac/Documents/ChatGPT/AMON/artifacts/JARVIS-MISSION-001A/qa-local-2026-11-11.txt`.

SHA-256 de la evidencia adjunta: `b7d4453efbd9e5faf136f987b7360bbba65566bf68c0d546acdcea83a58bc58d`.
