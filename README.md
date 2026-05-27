# AMON Agents

Núcleo operativo del sistema de agentes del ecosistema AMON.

## Propósito

AMON Agents define la base común para operar agentes de IA con límites claros, trazabilidad y flujo de trabajo consistente entre repositorios.

Este repositorio **no es un producto final** ni una UI.
Es la capa de orquestación y gobernanza que permite que otros repos del ecosistema trabajen con agentes de manera ordenada.

## Qué resuelve

- Unifica roles de agentes
- Define reglas globales
- Estandariza routing por tipo de tarea
- Obliga contratos de salida
- Prepara outputs que luego puede consumir Sentinel Board
- Reduce caos entre repositorios y evita duplicar agentes o prompts sin control

## Qué NO es

- No es un chatbot
- No es una interfaz visual
- No es un producto clínico
- No reemplaza criterio humano
- No debe mezclar lógica de negocio con prompts enterrados en frontend

## Rol dentro del ecosistema AMON

### Repos consumidores

- `amon-delivery`
  - Primer campo de prueba operativo
  - Multi-tenant + TBB + HEO Copilot comercial

- `jarvis_sentinel`
  - Sistema clínico especializado
  - Triage, SOS, derivación, flujos sensibles

- `sentinel-board`
  - Consola visual de mando
  - Debe leer reglas, routing y outputs generados por este repo

- `thebestburger-bot`
  - Canal de entrada operativo
  - Puede emitir eventos o tareas que luego entren al sistema

## Principio rector

> Humanos dirigen. La IA ejecuta dentro de límites explícitos.

## Estructura mínima

```text
core/
  core-agents.yaml
  routing.yaml
  output-contract.yaml
  global-rules.yaml

outputs/
  plans/
  reviews/
  logs/
  adr/
  audits/                       Reportes JSON de `amon audit`
  scans/                        Reportes JSON + Markdown de `amon scan`
  events.jsonl                  Event stream NDJSON (contrato con SB Runtime)

playbooks/
templates/
bootstrap/
```

## CLI

Ver [`docs/CLI_REFERENCE.md`](docs/CLI_REFERENCE.md) para el detalle completo de
comandos. Comandos disponibles hoy:

```
amon run     [--task TASK-ID] [--type feature_small] "descripción"
amon push    --task TASK-ID
amon status
amon doctor
amon audit   --repo <ruta>
amon scan    --repo <ruta>
amon watch                              (stub, no implementado)
```

## Binario / alias

El paquete instala dos bins apuntando al mismo entry: `amon` y `amon-agents`.
Si otro CLI llamado `amon` existe en tu PATH global (p. ej. `mini-agentes-cli`),
puede tomar prioridad. `amon doctor` lo detecta. Para forzar este runtime:

- `amon-agents <comando>` — alias seguro instalado por este paquete.
- `npm run amon -- <comando>` — siempre invoca este repo.

## Event stream

Todos los comandos empujan eventos NDJSON a `outputs/events.jsonl`
(override: `AMON_EVENTS_PATH`, opt-out: `AMON_EVENTS_ENABLED=false`).
Sentinel Board Runtime consume este archivo. Ver `docs/CLI_REFERENCE.md` →
"Event stream NDJSON" para el schema y la lista canónica de tipos.
