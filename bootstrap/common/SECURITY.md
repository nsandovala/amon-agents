# Security Policy

## Alcance

AMON Agents es el núcleo operativo del sistema de agentes del ecosistema AMON.  
La seguridad aquí se enfoca en:

- no exponer secretos
- evitar malas prácticas de configuración
- reducir superficie de error humano
- mantener trazabilidad operativa

## Reglas mínimas

- No subir `.env`, tokens, llaves privadas ni credenciales reales
- No hardcodear secretos en scripts o workflows
- No exponer configuraciones sensibles en documentación pública
- No aceptar cambios críticos sin revisión humana

## Recomendaciones operativas

- Usar llaves SSH `ed25519`
- Activar 2FA en GitHub
- Mantener Dependabot y CodeQL activos
- Proteger la rama principal
- Revisar permisos de colaboradores antes de otorgar acceso

## Reporte de vulnerabilidades

Si detectas una vulnerabilidad o exposición sensible:

1. No la publiques en un issue abierto
2. Repórtala de forma privada al mantenedor del repositorio
3. Describe:
   - problema detectado
   - impacto estimado
   - archivos afectados
   - pasos de reproducción si aplica

## Objetivo

La prioridad no es “paranoia ornamental”.  
La prioridad es seguridad útil, sobria y aplicable.