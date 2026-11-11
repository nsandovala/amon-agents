# JARVIS-MISSION-001E — Inspección supervisada de un repositorio aislado

Base: merge de 001C/001D, `d95574663132eb7037810bc5dea64bd7c7d53c06`.

## Única acción habilitada

`diagnose` ejecuta un inspector determinista de Git sobre un repositorio de prueba nuevo. Observa HEAD, rama, limpieza, archivo rastreado y SHA-256/tamaño de README.md. No invoca al LLM del rol architect ni acredita capacidad de modificar un producto. La selección del rol y permisos se comprueba con 001C; los estados y evidencias se validan con 001A; las aprobaciones se cargan del registro privado de 001D.

`setup` crea el repositorio bajo `REGISTRO/fixtures/UUID`, con un único README fijo y un commit local de preparación. Nunca acepta una ruta de repositorio existente. Registra su plan, SHA, rama e identidad de los directorios mediante un registro HMAC; sólo devuelve el identificador y el archivo de misión. Crear este fixture no concede autorización para inspeccionarlo.

La configuración del host debe permitir `MISSION-TEST` y `diagnose`. Una aprobación humana explícita se obtiene mediante el CLI de 001D, ligada al hash exacto, identidad local, asignación, acción y caducidad. No se extrae autoridad del texto de la misión ni de estados serializados. Los estados se reconstruyen mediante transiciones del motor y nunca se acepta evidencia aportada por el archivo de misión.

## Ejecución y evidencia

El host toma el mismo bloqueo del registro que usan las revocaciones, verifica el fixture, permisos, capacidades y aprobación, y reserva un intento exclusivo por ID de aprobación **antes de cualquier comando de inspección**. Los comandos usan `/usr/bin/git`, argumentos fijos, Git dir/worktree explícitos, sin shell, configuración global/sistema ni variables Git heredadas. Hooks y fsmonitor están deshabilitados; cada comando tiene timeout de 3 segundos y salida máxima de 64 KiB.

Se comparan tres observaciones del repositorio y se vuelve a comprobar el fixture, aprobación y reloj antes de certificar la finalización. Cambios del plan, SHA, rama, archivos, directorios, permisos o validez de aprobación bloquean el resultado. Un fallo posterior al inicio deja un recibo `blocked` sin evidencia done. Un error anterior a la reserva termina sin crear un intento.

El resultado completo y su evidencia se guardan antes de devolver éxito. Los registros `fixture-`, `attempt-` y `result-` están autenticados con HMAC ligado también al nombre, son privados y de escritura exclusiva. Una sustitución entre nombres, corrupción o archivo incompleto se rechaza. La recuperación tras reinicio lee el mismo recibo verificado, sin volver a ejecutar.

Un intento fallido o interrumpido consume la aprobación para esta operación. No se sobrescribe ni se reintenta automáticamente: revisar el fallo, revocar la aprobación anterior y emitir una nueva. Si sólo existe `attempt` y no hay resultado válido, la ejecución queda indeterminada; no se presenta como completada. No hay garantía de exactamente una ejecución frente a fallos arbitrarios del sistema. Se conserva la restricción de 001D: cuenta del SO y procesos del mismo UID confiables; no hay defensa frente a root/robo de clave/restauración completa de registros antiguos.

El bloqueo serializa los escritores de aprobaciones de este host, no todos los procesos del sistema de archivos. Las comprobaciones Git no son una transacción global ni impiden cambios que ocurran después de observar. La acción está acotada a lectura, compara antes/después y no ejecuta comandos narrativos o cambios de producto. Cambiar el plan del fixture requiere preparar otro fixture y aprobarlo nuevamente.

## Uso en Terminal

```bash
npm run --silent mission:supervised -- setup /ruta/nueva/registro
```

El padre debe existir. Si el registro ya existe, se valida su política sin ampliarla. La salida indica `fixtureId` y `missionFile`. Después:

```bash
npm run --silent mission:approval -- approve REGISTRO MISSION_FILE inspect-fixture diagnose CADUCIDAD_ISO_FUTURA
npm run --silent mission:supervised -- run REGISTRO FIXTURE_ID MISSION_FILE
npm run --silent mission:supervised -- result REGISTRO AUTHORIZATION_ID
npm run --silent mission:approval -- revoke REGISTRO AUTHORIZATION_ID
```

Las palabras en mayúsculas representan los valores del fixture y la aprobación. El flujo de aprobación/revocación requiere Terminal interactiva y repetir el texto mostrado. No hay `--yes`. `result` sólo recupera evidencia histórica; una revocación posterior no borra que una inspección autorizada ya ocurrió.

## QA y aislamiento

24 pruebas nuevas usan repositorios Git reales y aprobaciones explícitamente **simuladas** en el host de tests. Cubren éxito con conservación del índice, ausencia de proveedores, falta de aprobación, revocación/caducidad, cambios de plan/permisos/base/rama, suciedad y cambio durante ejecución, symlinks y traversal, reloj, concurrencia, intento interrumpido, fallo de persistencia, manipulación de recibos y recuperación mediante CLI en otros procesos.

Cierre local del 2026-11-11: Nelson ejecutó **444/444 pruebas (21 archivos), typecheck y build PASS**. Posteriormente confirmó la aprobación y revocación en Terminal: inspección real completed, recibo idéntico recuperado desde otro proceso y nuevo intento bloqueado con `NOT_APPROVED`. Se verificaron el recibo local y los SHA-256 de las seis fuentes probadas antes de actualizar sólo este informe. La ejecución del agente obtuvo 438/444 con seis bloqueos HTTP `listen EPERM`; la ejecución local completa cierra ese pendiente. La verificación humana se registra por separado de las aprobaciones simuladas de los tests. GO técnico para commit/push/PR; merge reservado a Nelson. BF y SB, sus worktrees y cambios locales, quedan fuera. No se cambia el pipeline general ni se añaden acciones de escritura, commit/push/merge de productos o despliegue.

Rollback: dejar de utilizar el CLI nuevo; conservar los registros para auditoría. No borrar automáticamente fixtures, claves o intentos incompletos. El merge de este sprint queda reservado a Nelson.
