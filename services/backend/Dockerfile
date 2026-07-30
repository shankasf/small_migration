# Production image: builds TypeScript, then ships only runtime dependencies.
# Source is baked in — nothing is mounted from the host at runtime.

# ---- build stage -----------------------------------------------------------
FROM node:22-slim AS builder

WORKDIR /app

# apt-get upgrade picks up security fixes published after the base image was
# built (e.g. the GnuTLS auth-bypass fix); without it the image ships whatever
# the base tag froze.
RUN apt-get update \
 && apt-get upgrade -y \
 && apt-get install -y --no-install-recommends openssl libssl3 ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 # The base image bundles an npm whose vendored tar carries a critical
 # advisory. Upgrading npm replaces that vendored copy.
 && npm install -g npm@latest && npm cache clean --force

COPY package*.json ./
# xlsx comes from SheetJS's official distribution rather than the npm
# registry: the registry copy is abandoned at 0.18.5 and carries an unfixed
# prototype-pollution advisory. npm 12 blocks remote tarballs by default, so
# this is enabled deliberately — the lockfile still pins the exact URL and an
# integrity hash, so the artefact is verified.
RUN npm ci --allow-remote=root

COPY prisma ./prisma/
RUN npx prisma generate

COPY . .
RUN npm run build

# ---- runtime stage ---------------------------------------------------------
FROM node:22-slim AS runtime

WORKDIR /app

# apt-get upgrade picks up security fixes published after the base image was
# built (e.g. the GnuTLS auth-bypass fix); without it the image ships whatever
# the base tag froze.
RUN apt-get update \
 && apt-get upgrade -y \
 && apt-get install -y --no-install-recommends openssl libssl3 ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 # The base image bundles an npm whose vendored tar carries a critical
 # advisory. Upgrading npm replaces that vendored copy.
 && npm install -g npm@latest && npm cache clean --force

ENV NODE_ENV=production

# Runtime dependencies only — no tsx, typescript or @types in the shipped image.
COPY package*.json ./
# xlsx comes from SheetJS's official distribution rather than the npm
# registry: the registry copy is abandoned at 0.18.5 and carries an unfixed
# prototype-pollution advisory. npm 12 blocks remote tarballs by default, so
# this is enabled deliberately — the lockfile still pins the exact URL and an
# integrity hash, so the artefact is verified.
RUN npm ci --omit=dev --allow-remote=root && npm cache clean --force

# The Prisma client is generated at build time into node_modules/.prisma;
# carry it over rather than regenerating at runtime.
# Prisma's native engines are fetched by a postinstall that does not run for
# the pruned runtime install, so carry them over from the builder explicitly.
# Without these the schema-engine cannot resolve and `prisma db push` fails.
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma

# Uploads are held in memory and nothing is written to disk, so the backend
# can drop to an unprivileged user.
RUN useradd --system --uid 10001 --create-home appuser \
 && chown -R appuser:appuser /app
USER appuser

EXPOSE 3001

# Schema sync runs as an initContainer, not here — see deploy/kubernetes.
CMD ["node", "dist/index.js"]
