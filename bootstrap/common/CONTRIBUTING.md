# Contributing

Gracias por contribuir a AMON Agents.

## Objetivo

Este repositorio define la base operativa del sistema de agentes del ecosistema AMON.  
Toda contribución debe priorizar:

- claridad
- trazabilidad
- cambios pequeños
- seguridad
- reutilización

## Reglas básicas

1. No subir secretos, tokens ni `.env`.
2. No mezclar lógica de producto dentro del core.
3. No crear agentes nuevos sin antes documentar el motivo.
4. Todo cambio relevante debe ser revisable por humanos.
5. Si afecta arquitectura, debe dejar trazabilidad en ADR o equivalente.
6. Si afecta seguridad, debe revisarse antes de merge.
7. Si afecta UX o UI, debe existir evidencia visual o explicación clara.

## Flujo recomendado

1. Crear rama corta y clara
2. Hacer cambio pequeño
3. Actualizar documentación si aplica
4. Ejecutar validaciones mínimas
5. Abrir PR con contexto suficiente

## Commits

Se recomienda usar mensajes claros, por ejemplo:

- `chore(amon-agents): add routing contract`
- `docs(core): refine agent ownership`
- `ci(python): add python workflow`

## Pull Requests

Toda PR debería incluir:

- objetivo
- alcance
- riesgos
- validación realizada
- capturas o logs si aplica

## Criterio de calidad

Una persona nueva debe poder entender:

- qué cambió
- por qué cambió
- qué valida ese cambio
- qué impacto tiene en el sistema