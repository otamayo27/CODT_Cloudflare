# GeoOperación — Cloudflare

Versión independiente de CODT adaptada a Cloudflare Workers y Workers KV.

Este repositorio no contiene la base operativa ni credenciales. La primera base se carga desde el panel administrativo después del despliegue.

## Arquitectura

- React + Vite para la interfaz.
- Cloudflare Worker para `/api/session`, `/api/orders` y `/api/upload`.
- Workers KV mediante el binding `DATA`.
- Sesiones firmadas en cookies HttpOnly.
- El Excel se procesa en memoria y no se conserva.

## Configuración en Cloudflare

1. Conecta este repositorio desde **Workers & Pages**.
2. Build command: `npm run build`.
3. Deploy command: `npm run deploy`.
4. Permite que Wrangler aprovisione automáticamente el namespace KV `DATA`.
5. Crea estos secretos:
   - `VIEWER_PASSWORD`
   - `ADMIN_PASSWORD`
   - `SESSION_SECRET`
6. Ejecuta un nuevo despliegue.

Consulta `DEPLOY_CLOUDFLARE.md` para el procedimiento completo.
