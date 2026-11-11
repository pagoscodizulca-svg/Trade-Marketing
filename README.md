# CODIZULCA C.A. — Sistema Integral de Trade Marketing y Contraloría

Plataforma de gestión de puntos de venta (PDV), cronograma de degustaciones, informes de campo, contraloría y KPIs operativos.

## Ejecutar en local

**Requisitos:** Node.js 20+

1. Instalar dependencias:
   `npm install`
2. Iniciar en modo desarrollo:
   `npm run dev`

## Producción

1. `npm run build` (genera `dist/`)
2. `npm start` (sirve `dist/` con `NODE_ENV=production`)

## Scripts

| Script | Descripción |
| --- | --- |
| `npm run dev` | Servidor Express + Vite (HMR) |
| `npm run build` | Build de producción con Vite |
| `npm start` | Servidor en modo producción (requiere `npm run build`) |
| `npm run lint` | Chequeo de tipos (`tsc --noEmit`, modo `strict`) |
| `npm run clean` | Elimina `dist/` |
