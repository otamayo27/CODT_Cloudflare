# Despliegue en Cloudflare sin suscripción R2

## 1. Crear el proyecto

En Cloudflare abre **Workers & Pages → Create application → Import a repository** y selecciona `otamayo27/CODT_Cloudflare`.

Configura:

- Production branch: `main`
- Build command: `npm run build`
- Deploy command: `npx wrangler deploy`
- Root directory: vacío

## 2. Almacenamiento gratuito

La aplicación usa **Workers KV**, no R2. El archivo `wrangler.jsonc` declara el binding `DATA`.

Durante el primer despliegue, Cloudflare/Wrangler debe ofrecer crear o aprovisionar el namespace automáticamente. Acepta esa creación. No es necesario activar una suscripción R2.

## 3. Crear secretos

En **Settings → Variables and Secrets**, agrega como secretos:

- `VIEWER_PASSWORD`: contraseña compartida de consulta.
- `ADMIN_PASSWORD`: contraseña distinta para cargar la base.
- `SESSION_SECRET`: cadena aleatoria de al menos 32 caracteres.

No copies los valores de ejemplo ni guardes contraseñas reales en GitHub.

## 4. Desplegar

Ejecuta un nuevo despliegue. La aplicación debe abrir primero la pantalla de acceso.

Después de ingresar, la base aparecerá vacía. Selecciona **Administrar base**, ingresa la clave administrativa y carga el Excel operativo.

## 5. Verificación

Confirma:

1. La contraseña incorrecta es rechazada.
2. La contraseña de consulta permite entrar.
3. El administrador puede cargar un Excel válido.
4. La página muestra fecha, responsable y número de órdenes.
5. Al recargar, los registros permanecen disponibles.
6. El namespace KV contiene `current`; luego de la segunda carga también contiene `previous`.

La información se comprime antes de guardarse. El Excel original se procesa en memoria y no se conserva.
