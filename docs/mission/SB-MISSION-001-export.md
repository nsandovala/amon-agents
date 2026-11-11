# SB-MISSION-001 — Puente de lectura para Sentinel Board

Base: 38a03d1c74f154c1eefd6c204fbe300bde6b4257.

`npm run mission:export-board -- PRIVATE_STORE FIXTURE_UUID PUBLIC_JSON`

Exporta una observación `sb-mission/1` de un fixture existente de 001E. No ejecuta
Git, agentes ni aprobaciones; no modifica el almacén privado. No acepta el camino
de un repositorio de producto ni texto como autorización. El destino debe estar
fuera del almacén, en un directorio canónico del propietario sin escritura para
otros; el reemplazo del JSON es atómico y 0600.

Se verifican firmas del historial/fixture/intentos/resultados, el hash del plan,
la base y rama, el vínculo de cada aprobación y la coherencia temporal de los
recibos. Se comprueba que el historial no cambió durante la lectura. Un fallo no
publica un resumen nuevo. El consumidor debe mostrar siempre la hora de la última
exportación y avisar si queda antigua, incluso si conserva un archivo anterior.

El contrato público contiene IDs, SHA, candidatos/capacidades, permisos,
aprobaciones resumidas y observaciones de Git. No contiene clave HMAC, ruta
privada, UID/actor, narrativa de misión ni payloads firmados completos. El resumen
no tiene firma independiente: se confía en el propietario del host y la entrega
local del archivo. No es una autorización transportable y declara siempre
`executionAuthorized: false`.

Solo cubre el inspector aislado MISSION-TEST, una misión por archivo, máximo 100
aprobaciones. No generaliza ejecuciones arbitrarias. Un recibo completado conserva
su valor histórico después de revocación o vencimiento; un intento sin resultado
no se declara completado. No se consulta el estado actual del repositorio: HEAD
mostrado es evidencia histórica, no un nuevo diagnóstico.

Validación: typecheck/build, suite completa y 14 pruebas nuevas en
`board-export.test.ts`, con aprobaciones simuladas. El QA local de integración
reutiliza en modo lectura el recibo humano de 001E; no pide una nueva aprobación.
No se tocan BF, SB original ni otras ramas. Publicación y merge siguen separados.
