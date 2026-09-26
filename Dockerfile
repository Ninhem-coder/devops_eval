# ---------- Stage 1 : installation des dépendances ----------
# Image de base précise (jamais latest) et alpine pour une image légère
FROM node:22.20.0-alpine AS deps
WORKDIR /app
# On copie d'abord uniquement package*.json : tant qu'ils ne changent pas,
# Docker réutilise cette couche en cache et ne refait pas npm ci
COPY package.json package-lock.json ./
# --omit=dev : pas de jest, supertest... dans l'image de prod
RUN npm ci --omit=dev && npm cache clean --force

# ---------- Stage 2 : image finale ----------
FROM node:22.20.0-alpine AS runtime
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app

# On récupère seulement node_modules depuis le stage 1, puis le code.
# Les fichiers restent la propriété de root : l'appli peut les lire mais pas les modifier.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

# SHA du commit, donné par la CD au moment du build (--build-arg GIT_SHA=...)
# et exposé par la jauge app_info de /metrics
ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA

# L'utilisateur "node" (uid 1000) existe déjà dans l'image officielle : on ne tourne pas en root.
# On met l'uid numérique pour que Docker/Kubernetes puissent vérifier que ce n'est pas root.
USER 1000:1000

EXPOSE 3000

# Appelle /health, qui interroge la base. Si l'appli ou la base ne répond pas -> unhealthy.
# On utilise node (fetch intégré) pour ne pas avoir besoin d'installer curl.
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "src/server.js"]
