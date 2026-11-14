# AMON-GUARDIAN-MCP-001A — Contratos de lectura

Base: `a55dd87467f8c11e6b5eed4aa0f026e2fe21f3f4`.

`createGuardianReadAdapter()` expone cuatro operaciones de observación y un
despachador `call`. No registra un servidor MCP, endpoint, CLI, agente, proceso
Worker ni acción de misión. `READ_TOOL_CONTRACTS` describe los argumentos cerrados
y `ReadData` / `ReadResult` tipan las respuestas sin depender de un transporte.

| Herramienta | Argumentos opcionales | Resultado |
| --- | --- | --- |
| `get_runtime_status` | ninguno | Worker, heartbeat, antigüedad y disponibilidad de las fuentes |
| `list_recent_jobs` | `status`, `action`, `since`, `limit` | Jobs recientes, total coincidente y truncamiento |
| `get_guardian_summary` | `verdict`, `jobRef`, `since`, `limit` | Observaciones Guardian y conteos por veredicto |
| `get_mission_snapshot` | ninguno | Resumen sanitizado de la exportación `sb-mission/1` existente |

Ejemplo de uso interno desde la raíz autorizada de AA:

```ts
import { createGuardianReadAdapter } from '../src/guardian/read-adapter';

const reads = createGuardianReadAdapter();
const recent = await reads.list_recent_jobs({status: 'done', limit: 10});
if (recent.ok && recent.data.items.length) {
  const summary = await reads.get_guardian_summary({jobRef: recent.data.items[0].jobRef});
  // Mostrar observaciones; nunca interpretar summary como autorización.
}
```

## Fuentes y reutilización

La fábrica local captura una vez el directorio del host (`process.cwd()`). No
acepta un argumento de ruta, URL, variable de entorno ni selección de repositorio.
La integración de host debe arrancar desde la raíz AA autorizada. Los argumentos
de las herramientas nunca se usan para formar nombres de archivos.

- `outputs/worker/worker-status.json`
- `outputs/worker/jobs/*.json`
- `outputs/guardian/reviews/*.json`
- `outputs/mission/board-snapshot.json`

Las tres primeras fuentes pasan por `buildOperationalSnapshot` de
`src/ops/projection.ts`; se conserva su asociación job/último veredicto Guardian.
Las dependencias de lectura acotadas permiten detectar los errores que esa
proyección tolera para su consumidor original. No se modifica ese comportamiento
original ni se construye otra proyección operativa.

La cuarta fuente debe ser un archivo producido previamente por el exportador
existente `exportBoardSnapshot` / `mission:export-board`, con su entrega local y
sus controles de propietario. Esta implementación no genera la exportación,
no abre el almacén privado y no vuelve a calcular aprobaciones, revocaciones o
vigencias. Los tipos de la observación derivan de `ReturnType<typeof boardSnapshot>`;
no se introduce un segundo modelo de misión. Sigue limitado al inspector aislado
`MISSION-TEST`, no a misiones arbitrarias de producto.

El resultado sanitizado indica `sourceSchema: "sb-mission/1"`; no se anuncia como
una exportación íntegra de ese esquema. Conserva `generatedAt`, la frescura y los
estados observados de autorizaciones/recibos. Un estado `approved` o un permiso
`true` observado no autoriza ejecución: tanto el envoltorio `guardian-read/1`
como la observación de misión llevan siempre `executionAuthorized: false`.

`GuardianReadSources` permite inyectar capacidades de lectura ya ligadas por el
host para pruebas o integración interna. Estas funciones son código de confianza,
no configuración JSON aceptada del usuario ni un mecanismo de autorización.

## Estados, filtros y límites

- Worker explícitamente `offline` conserva ese estado, aunque su heartbeat sea
  antiguo. `online` con heartbeat de más de 30 segundos se muestra `stale`.
  La frontera exacta de 30 segundos todavía es `fresh`.
- Heartbeat ausente, inválido o futuro es `unknown`; no permite declarar online.
  Sin Worker o con estado no reconocido se informa `unknown`, nunca offline por
  inferencia. El heartbeat tiene estado separado y `ageMs` / fecha o `null`.
- Fuentes Ops ausentes producen disponibilidad `false` y sistema `unknown`.
  Una colección ausente es `SOURCE_UNAVAILABLE`; una colección existente vacía
  tiene éxito con cero elementos. JSON corrupto no se presenta como vacío válido.
- `since` es ISO UTC canónico con milisegundos, inclusivo. Jobs se ordenan por
  `finishedAt`, con fallback a `startedAt`; sin ambas fechas van al final y no
  cumplen un filtro `since`. Guardian usa `reviewedAt`. Empates usan la referencia
  opaca para un orden estable dentro de la instancia.
- Se filtra antes de limitar. `limit`: entero entre 1 y 100, por defecto 20.
  `total` y conteos corresponden al conjunto filtrado completo; `truncated` indica
  que no todos sus elementos se devolvieron. No hay cursor ni paginación implícita.
- Máximo 1000 entradas por directorio, 1000 registros por colección proyectada,
  un Worker y 100 autorizaciones/observaciones de misión. Archivos: 256 KiB cada
  uno; lectura acumulada: 4 MiB por operación, con un byte de detección de exceso.
  Al detectar un fallo no se leen más registros. No se devuelven éxitos parciales.

## Privacidad y errores

Las respuestas se construyen con campos permitidos: enums, fechas canónicas,
booleanos y contadores validados. Se omiten rutas, hostname, repo/worktree, nombres
y versiones de herramientas, narrativas, findings, logs, diffs, variables,
payloads firmados, SHA y referencias privadas de evidencia. Los IDs se reemplazan
por HMAC con clave aleatoria privada por instancia. Una referencia de job permite
filtrar Guardian en esa misma instancia; cambia al crear otro adaptador y no es
un ID durable ni una credencial.

Se rechazan links simbólicos en el árbol fuente, archivos con enlaces duros y
objetos no regulares. No hay red, escritura, creación de fuentes ni ejecución de
comandos en el adaptador. El propietario del host sigue siendo el límite de
confianza: esto no autentica clientes ni defiende contra un propietario malicioso
que cambie concurrentemente directorios. La exportación observada no tiene una
firma independiente, conforme al contrato `sb-mission/1` existente.

Errores fijos: `INVALID_TOOL`, `INVALID_ARGUMENTS`, `SOURCE_UNAVAILABLE`,
`SOURCE_INVALID`, `SOURCE_LIMIT_EXCEEDED`. Nunca incluyen la entrada recibida,
mensajes de excepciones, rutas o stack traces. Las fuentes operativas se validan
como conjunto; una fuente corrupta bloquea la respuesta aunque el filtro hubiera
excluido ese registro. La misión se lee por separado.

## Validación dirigida

```sh
node node_modules/vitest/vitest.mjs run src/guardian/read-adapter.test.ts src/guardian/read-sources.test.ts
node node_modules/vitest/vitest.mjs run src/ops/projection.test.ts -t 'operational projection'
node node_modules/vitest/vitest.mjs run src/standards/compatibility.test.ts
node node_modules/typescript/bin/tsc --noEmit
```

Las pruebas cubren contratos cerrados, filtros/límites, IDs opacos, redacción,
estados de heartbeat, errores seguros, archivos ausentes/corruptos/no legibles,
symlinks/hardlinks y lectura de una exportación real de un fixture aislado. La
integración compara los archivos antes/después y comprueba ausencia de red y
ejecución de comandos durante las lecturas. No certifica un servidor MCP ni
clientes externos, que quedan fuera de esta fase.
