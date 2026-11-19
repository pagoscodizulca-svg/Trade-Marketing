# syntax=docker/dockerfile:1.7
# Despliegue único (B-09): Torre de Control `/`, portal `/portal`, cliente `/cliente` y logística `/logistica`
# desde un mismo Express compilado a JavaScript (sin tsx en producción).

# ---------- Etapa 1: dependencias completas + compilación ----------
FROM node:24-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY ruta-degustacion/package.json ruta-degustacion/package-lock.json ./ruta-degustacion/
RUN npm --prefix ruta-degustacion ci

COPY . .

# Solo valores PÚBLICOS (URL y llave `sb_publishable_`). NUNCA pases `sb_secret_` ni `service_role` aquí.
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_PUBLISHABLE_KEY
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL \
    VITE_SUPABASE_PUBLISHABLE_KEY=$VITE_SUPABASE_PUBLISHABLE_KEY

RUN npm run build:all

# ---------- Etapa 2: dependencias de producción ----------
FROM node:24-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---------- Etapa 3: imagen final mínima ----------
FROM node:24-alpine AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    SKIP_CHOFER_SERVER=true \
    TRUST_PROXY_HOPS=1
WORKDIR /app

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist
COPY --from=build /app/ruta-degustacion/dist ./ruta-degustacion/dist
COPY --from=build /app/dist-server ./dist-server

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Las variables secretas (SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET, OPENAI_API_KEY...) se inyectan
# en tiempo de ejecución desde el orquestador; jamás se incluyen en la imagen.
CMD ["node", "dist-server/server.js"]
