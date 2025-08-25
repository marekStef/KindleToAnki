# ---- build stage ----
FROM node:20-alpine AS build
WORKDIR /app

# better-sqlite3 needs native build; install build deps
RUN apk add --no-cache python3 make g++ sqlite-dev zstd
# If you no longer ship node-zstd, zstd is only needed at runtime; up to you.

# copy manifests (lockfile is REQUIRED for npm ci)
COPY package*.json ./

# install prod deps
RUN npm ci --omit=dev  

# copy sources
COPY src ./src
COPY public ./public

# ---- runtime stage ----
FROM node:20-alpine AS runtime
WORKDIR /app

RUN apk add --no-cache sqlite-libs zstd

# copy app with node_modules from build
COPY --from=build /app /app

ENV NODE_ENV=production
CMD ["node", "src/server.js"]
