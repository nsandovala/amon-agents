# outputs

Artefactos generados por el sistema de agentes.

## Propósito

Esta carpeta contiene salidas estructuradas que luego pueden ser leídas por humanos, tooling interno o Sentinel Board.

## Subcarpetas

- `plans/` → planes generados por architect o planner
- `reviews/` → validaciones, QA y revisiones
- `logs/` → eventos operativos o trazas resumidas
- `adr/` → decisiones de arquitectura y cambios relevantes

## Regla

No subir archivos temporales, dumps arbitrarios ni resultados experimentales sin contexto.
Todo output debe ser trazable y entendible.