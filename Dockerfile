# syntax=docker/dockerfile:1

# ---- Build stage ----
FROM node:22-alpine AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build \
 && npm prune --omit=dev

# ---- Runtime stage ----
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# scripts/ensure-schema.js dijalankan sebelum migration:run di pipeline (lihat Jenkinsfile).
COPY --from=build /app/scripts ./scripts

# certs/public.pem tidak ada di image — di-mount ke /app/certs/public.pem saat runtime
# (JWT_PUBLIC_KEY_PATH, default certs/public.pem relatif ke /app).
USER node
EXPOSE 3002

CMD ["node", "dist/main.js"]
