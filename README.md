# Sync App

Esta aplicación permite sincronizar productos desde un archivo XML externo hacia una tienda Shopify, gestionando variantes, opciones como color y capacidad, y actualizando el inventario de forma automatizada.

## Características principales
- Importación masiva de productos desde XML
- Mapeo de campos SKU, GTIN, color, capacidad y condición
- Creación y actualización de productos y variantes en Shopify
- Gestión de opciones de producto (color, capacidad, condición)
- Manejo de errores y reintentos automáticos ante throttling de la API
- Progreso en tiempo real de la sincronización

## Estructura del proyecto
- `/app/services/xml-sync.server.js`: Lógica principal de sincronización y parseo
- `/app/routes/`: Rutas de la aplicación y API
- `/prisma/`: Esquema y migraciones de base de datos
- `/public/`: Archivos estáticos
- `CHANGELOG.md`: Registro de cambios

## Instalación y uso
1. Instala dependencias: `npm install`
2. Configura las variables de entorno y credenciales Shopify
3. Ejecuta la app: `npm run dev`

## Despliegue

El despliegue va atado al `git push`. Al hacer push a `main`, el hook
`pre-push` lanza `scripts/deploy.mjs`, que:

1. Comprueba que los scopes de `shopify.app.toml` y de `fly.toml` coinciden.
2. Sube el backend con `fly deploy`.
3. Crea una versión nueva en Shopify con `shopify app deploy` y **la publica**,
   así que la tienda recibe los cambios de configuración, scopes y webhooks sin
   desinstalar y reinstalar la app. Si hay scopes nuevos, la tienda pedirá
   aceptar los permisos al abrir la app.

Si el deploy falla, el push se aborta, para que en remoto no quede un commit que
no está en producción.

**Alta en una máquina nueva** (una sola vez, el hook no viaja en el clon):

```
npm run hooks:install
```

**Atajos**

| Qué quieres | Comando |
| --- | --- |
| Desplegar sin pushear | `npm run deploy` |
| Pushear sin desplegar | `SKIP_DEPLOY=1 git push` (o `git push --no-verify`) |
| Solo la versión de Shopify | `SKIP_FLY=1 npm run deploy` |
| Solo el backend de Fly | `SKIP_SHOPIFY=1 npm run deploy` |

Los scopes se declaran en `shopify.app.toml` (fuente de verdad) y se replican en
la variable `SCOPES` de `fly.toml`, que es la que lee `app/shopify.server.js`
para detectar que una tienda tiene permisos antiguos. El deploy falla si se
desincronizan.

## Requisitos
- Node.js
- Acceso a una tienda Shopify
- Archivo XML de productos

## Autor
Ruben Juan Molina
