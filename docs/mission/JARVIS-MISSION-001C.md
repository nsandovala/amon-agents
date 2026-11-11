# JARVIS-MISSION-001C — Capacidades y propuesta de asignación

Base: `0965531b01c9670c0410e7a6753a389e81e4f166` (001A/001B y mini fix integrados).

## Comportamiento

El host entrega una asignación existente, una acción y capacidades requeridas explícitas. `proposeAssignment` compara todos los roles del catálogo fijo `core/agent-capabilities.yaml`, consulta su disponibilidad en `AGENT_REGISTRY` y comprueba las tres capas de permisos. No clasifica texto libre con un LLM ni convierte la narrativa de la misión en requisitos o permisos.

Cada candidato explica si tiene ejecutor, si la acción es compatible y qué capacidades le faltan. Debe satisfacer **todos** los requisitos. Con un candidato propone su rol; con ninguno devuelve `NO_CAPABLE_AGENT`; con varios devuelve `AMBIGUOUS_CAPABILITIES`. No desempata por orden del YAML ni inventa una puntuación de calidad. El host debe precisar el requisito cuando exista ambigüedad.

| Rol | Capacidades declaradas | Acciones compatibles en la propuesta |
|---|---|---|
| architect | architecture-plan, plan-review | diagnose |
| security | security-review, plan-review | diagnose, verify |
| qa | plan-qa, plan-review | verify |
| ops | readiness-assessment, plan-review | diagnose, verify |
| designer | ui-design | design; sin ejecutor |
| dev | code-implementation | implement; sin ejecutor |

Son capacidades de planificación/revisión, no certificación de salud del proveedor o calidad de resultados. QA no equivale a ejecutar tests de producto y Ops no tiene capacidad de despliegue. Designer y Dev mantienen su disponibilidad real en false.

La propuesta puede recomendar un rol distinto del que ya figura en el plan, y conserva `originalRole`, `proposedRole`, requisitos y hash del plan origen. No modifica la misión, estados, permisos o aprobaciones. `executionAuthorized` siempre es false y `approvalRequired` siempre true. Aplicar una propuesta exige revisar el plan resultante; cambiar el rol invalida la aprobación anterior mediante el hash existente.

Este catálogo acota **la propuesta**, no sustituye la política de autorización de 001A ni conecta un ejecutor. El motor de estados y el pipeline architect→security→qa→ops no se modifican. No hay scheduler, asignación automática desde lenguaje natural, invocación de agentes, acceso a productos o red.

## Demo observable

```bash
npm run --silent demo:assignment
```

Siete escenarios con planes simulados y comparación real: cuatro roles disponibles, Designer/Dev no disponibles y ambigüedad entre revisores. La demo comprueba cada resultado con aserciones y termina con error ante una regresión. Una opción desconocida termina con código 2. Las decisiones no incluyen objetivos ni salidas narrativas potencialmente sensibles; sólo metadatos y capacidades enumeradas.

## QA

Se prueban selección por capacidades, requisitos conjuntos, acciones incompatibles, ambigüedad, permisos por capa, entradas y catálogos malformados, ausencia de ejecutores, instrucciones narrativas, invalidación del plan, determinismo y ausencia de invocación de agentes/proveedores. El catálogo requiere exactamente los seis roles, versión conocida y listas sin duplicados de capacidades/acciones conocidas. Un archivo ausente o inválido bloquea la propuesta.

QA: 30/30 pruebas nuevas PASS; typecheck/build y siete escenarios de demo PASS. Suite aislada del agente: 367/373, con seis bloqueos HTTP `listen EPERM`. El 2026-11-11 a las 02:55 Chile, Nelson ejecutó la entrega conjunta 001C+001D en Terminal: **420/420 pruebas (20 archivos), typecheck, build y demo PASS**. Se cotejaron los hashes de los archivos probados antes de actualizar este informe. GO técnico para commit/push/PR; merge reservado a Nelson. Rollback: dejar de consumir la API/demo nuevas; no existen cambios de estado ni migraciones que revertir en productos.

001D incorpora aprobación local e historial persistente en un commit separado. 001E (ejecución supervisada) queda fuera de esta entrega.
