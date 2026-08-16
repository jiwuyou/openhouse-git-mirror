FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git git-lfs \
  && rm -rf /var/lib/apt/lists/* \
  && git lfs install --system
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist/src ./dist
COPY config ./config
ENV MIRROR_HOST=0.0.0.0 \
  MIRROR_PORT=20879 \
  MIRROR_DB_PATH=/data/mirror.sqlite \
  MIRROR_WORK_ROOT=/work \
  MIRROR_SEED_FILE=/app/config/repositories.json
EXPOSE 20879
CMD ["node", "dist/index.js"]
