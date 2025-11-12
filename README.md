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

## Requisitos
- Node.js
- Acceso a una tienda Shopify
- Archivo XML de productos

## Autor
Ruben Juan Molina
