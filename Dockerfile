# syntax=docker/dockerfile:1

# TODO: pin the base image to a digest (node:22-slim@sha256:...) for reproducible builds.
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Pin pnpm to match packageManager in package.json. The fetch stage runs before
# package.json is copied, so corepack can't infer the version and would otherwise pull
# pnpm-latest, whose newer supply-chain defaults can reject an otherwise-valid lockfile.
RUN corepack enable && corepack prepare pnpm@10.34.1 --activate
WORKDIR /app

FROM base AS fetch
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm fetch --frozen-lockfile

FROM fetch AS build
COPY package.json ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --offline
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN pnpm build

FROM fetch AS prod-deps
COPY package.json ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --prod --frozen-lockfile --offline

FROM node:22-slim AS runtime
LABEL org.opencontainers.image.title="ownllm" \
      org.opencontainers.image.description="Self-hostable, subscription-auth, OpenAI-compatible API gateway with real per-request model routing." \
      org.opencontainers.image.source="https://github.com/lukaisailovic/ownllm" \
      org.opencontainers.image.licenses="Apache-2.0"
ENV NODE_ENV=production
ENV OWNLLM_HOME=/home/ownllm/.ownllm
WORKDIR /app
RUN useradd --system --uid 10001 --create-home ownllm
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json config.example.yaml ./
USER ownllm
VOLUME ["/home/ownllm/.ownllm"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js", "serve"]
