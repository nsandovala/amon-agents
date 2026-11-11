# JARVIS-MISSION-001D — Aprobaciones locales e historial persistente

Base: `0965531b01c9670c0410e7a6753a389e81e4f166`. Este sprint incorpora una frontera de aprobación local y un historial privado recuperable. No ejecuta agentes ni acciones de producto. El pipeline existente permanece igual.

## Identidad y autorización

La identidad se obtiene del UID real/efectivo del proceso (`local-uid-N`), no de variables de entorno, argumentos `approvedBy` ni texto de misión. Una aprobación requiere que el identificador esté incluido en la política del plan, que el alias y acción estén habilitados por la política independiente del host y que el rol tenga ejecutor registrado. La confirmación interactiva muestra el plan completo en JSON escapado, la identidad, el hash, la acción y la caducidad. Exige repetir un texto que contiene asignación, acción, hash completo y caducidad. No admite entrada por pipe ni `--yes`.

`approvedAt` e `issuedAt` se fijan tras confirmar, usando el reloj del host. La validez máxima al preparar la solicitud es de 24 horas. Si caduca durante la confirmación, retrocede el reloj o cambia el historial, no se guarda. No se permiten aprobaciones activas superpuestas. Revocar conserva la identidad y todos los campos originales; renovar utiliza un ID nuevo. El motor anterior sigue revalidando plan, permisos, aprobaciones y evidencia.

La API `approveLocal` recibe un adaptador de confirmación **confiable**; el CLI es la frontera interactiva suministrada en este sprint. No exponer esta API, el callback o `ApprovalStore.append` directamente a un LLM o HTTP. Una llamada interna no acredita por sí sola presencia humana.

## Persistencia y límites de confianza

El directorio debe ser privado (0700), y clave e historial deben ser archivos regulares del usuario actual (0600), sin symlinks ni enlaces duros. La política del host y el historial completo están autenticados con HMAC-SHA-256 y una clave aleatoria local. Cada operación comprueba formato, secuencia, fechas e invariantes. El historial conserva los eventos y reconstruye un snapshot por autorización, incluida la revocación.

La escritura usa archivo temporal exclusivo, fsync, reemplazo atómico y fsync del directorio. Un bloqueo exclusivo impide escritores concurrentes; la secuencia esperada rechaza confirmaciones obsoletas. Un bloqueo abandonado se conserva y bloquea nuevas escrituras: inspeccionar el proceso y recuperar manualmente, nunca borrar automáticamente. El tamaño está limitado a 4 MiB y 10.000 eventos; al alcanzar el límite se bloquea, no se trunca.

**Modelo local de confianza:** se confía en la cuenta del sistema operativo y sus procesos. La confirmación acredita una operación explícita en esa sesión, no biometría ni identidad web. No protege frente a código malicioso con el mismo UID, root, robo de la clave o restauración completa de una copia antigua del registro y su clave. No es un ledger remoto, sello temporal externo ni una garantía de presencia física humana. El reloj del host es confiable; el motor impide usar aprobaciones fuera de su ventana. No hay recuperación automática ante pérdida de clave o corrupción. Guardar el registro fuera del repositorio y respaldarlo bajo la misma protección.

## Uso

Desde el checkout del sprint y con Node 22:

```bash
npm run --silent mission:approval -- identity
npm run --silent mission:approval -- init /ruta/privada/registro MISSION-TEST diagnose
npm run --silent mission:approval -- approve /ruta/privada/registro /ruta/mission.json architect diagnose 2026-11-11T15:00:00.000Z
npm run --silent mission:approval -- history /ruta/privada/registro
npm run --silent mission:approval -- revoke /ruta/privada/registro ID-DE-LA-AUTORIZACION
```

Las rutas y fecha son ejemplos: usar una ruta nueva cuyo padre exista y una caducidad futura válida. `init` no concede aprobaciones ni modifica misiones. Los identificadores de aprobación se muestran al guardar. `approvalContext` carga política e historial verificados para el motor; las evidencias se suministran separadamente desde un host confiable.

## QA y revisión

- 47 pruebas nuevas: consistencia del historial, renovación/revocación, claves/archivos privados, integridad, reinicio en otro proceso, fallo de reemplazo atómico, concurrencia, confirmación cancelada/obsoleta, permisos, reloj e invalidación del plan.
- Los callbacks de aceptación en tests son **simulados**; no se presentan como aprobaciones humanas reales.
- QA de Terminal aportado por Nelson (2026-11-11, 02:47 Chile): typecheck, build y **390/390** PASS para 001D sobre la base 001B. La ejecución del agente obtuvo 384/390 con seis bloqueos HTTP `listen EPERM`, resueltos por esa evidencia local. Tras incorporar 001C, Nelson ejecutó la entrega conjunta en Terminal a las 02:55 Chile: **420/420 pruebas (20 archivos), typecheck, build y demo PASS**. El agente obtuvo 414/420 con los mismos seis bloqueos de puertos; la evidencia de Terminal cierra ese pendiente. Los archivos se cotejaron por SHA-256 antes de actualizar este informe. GO técnico para commit/push/PR; merge reservado a Nelson.
- Recuperación del código: dejar de usar el CLI nuevo. El registro existente no se elimina ni se reescribe; no hay migración del pipeline ni de repositorios de producto.
- 001E añadirá una única operación real acotada sobre un repositorio de prueba, reutilizando estas aprobaciones. La selección automática por capacidades (001C) no forma parte de 001D/001E.
