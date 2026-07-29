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
2. Aborta si hay cambios sin commitear. `fly deploy` empaqueta el directorio de
   trabajo, no el commit, así que con el árbol sucio acabaría en producción
   código que no está en el repositorio. Escape: `ALLOW_DIRTY=1`.
3. Sube el backend con `fly deploy`. **Esto es lo que hace que un cambio de
   código llegue a la tienda**: la tienda apunta a Fly y carga el despliegue
   nuevo en la siguiente visita, sin actualizar ni reinstalar nada.
4. Solo si el push toca la configuración de la app, crea una versión nueva en
   Shopify con `shopify app deploy` y **la publica**.

Ese último paso es condicional a propósito. En la versión de Shopify solo vive la
configuración —scopes, webhooks, `application_url`, extensiones—, así que un push
que solo toca código generaría una versión idéntica a la anterior y llenaría de
ruido el listado del Partner Dashboard. Se considera configuración un cambio en
`shopify.app.toml`, `shopify.web.toml` o `extensions/`; ante la duda (rama nueva,
o un sha que no está en local) se publica igualmente.

Si añades un scope, la tienda pedirá aceptar los permisos nuevos al abrir la app.
No hace falta desinstalarla.

Si el deploy falla, el push se aborta, para que en remoto no quede un commit que
no está en producción.

### Lo que este despliegue *no* hace

Conviene tenerlo claro, porque es CD sin CI:

- **No ejecuta los tests.** Hoy la suite está roja: 3 de los 4 ficheros de
  `test/` quedaron atrás en la refactorización a `app/services/xml-sync/` (uno
  importa `app/services/attributes-utils.js`, que ya no existe). Poner la puerta
  antes de arreglarlos bloquearía todos los pushes. Cuando la suite vuelva a
  verde, añadir `npm test` al principio de `scripts/deploy.mjs` es una línea.
- **No ejecuta `typecheck` como puerta.** `tsconfig.json` no incluye `**/*.js` y
  no activa `checkJs`, así que `tsc --noEmit` no revisa los servicios: pasaría
  siempre sin comprobar lo que importa.
- **Depende de esta máquina**: la sesión del CLI de Shopify, el token de fly y el
  `node` locales. Si la sesión del CLI ha caducado, el push se queda esperando a
  que se abra el navegador. Eso solo se arregla moviendo el deploy a un runner.
- **No es atómico.** Si `fly deploy` va bien y `shopify app deploy` falla, quedas
  a medias y con el push abortado.

**Alta en una máquina nueva** (una sola vez, el hook no viaja en el clon):

```
npm run hooks:install
```

**Atajos**

| Qué quieres | Comando |
| --- | --- |
| Desplegar sin pushear (publica versión siempre) | `npm run deploy` |
| Pushear sin desplegar | `SKIP_DEPLOY=1 git push` (o `git push --no-verify`) |
| Solo la versión de Shopify | `SKIP_FLY=1 npm run deploy` |
| Solo el backend de Fly | `SKIP_SHOPIFY=1 npm run deploy` |
| Desplegar con el árbol sucio | `ALLOW_DIRTY=1 npm run deploy` |

Lanzado a mano, `npm run deploy` publica versión siempre: no hay rango de push
del que deducir si la configuración ha cambiado, y si lo pides explícitamente se
entiende que quieres el ciclo completo.

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
