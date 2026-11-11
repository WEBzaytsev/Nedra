FROM node:22-alpine AS builder

ARG VITE_API_URL=__CIPHERMOTH_API_URL__
ARG VITE_GITHUB_REPO=krolbot/ciphermoth
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_GITHUB_REPO=$VITE_GITHUB_REPO

WORKDIR /app

COPY frontend/package*.json ./

RUN npm ci

COPY frontend/ .

RUN npm run build


FROM node:22-alpine AS runtime

LABEL io.ciphermoth.min-updater-protocol="3"

ARG VITE_GITHUB_REPO=krolbot/ciphermoth
ENV CIPHERMOTH_GITHUB_REPO=$VITE_GITHUB_REPO

RUN addgroup -S ciphermoth && adduser -S ciphermoth -G ciphermoth

WORKDIR /app

COPY docker/frontend/serve/package.json docker/frontend/serve/package-lock.json ./server/
RUN npm ci --prefix /app/server --omit=dev && npm cache clean --force
ENV PATH="/app/server/node_modules/.bin:$PATH"

COPY --from=builder --chown=ciphermoth:ciphermoth /app/dist ./dist
COPY --from=builder /app/serve.json ./serve.json
COPY docker/frontend/runtime-config.mjs /app/runtime-config.mjs
COPY docker/frontend/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

USER ciphermoth

EXPOSE 3000

CMD ["/app/entrypoint.sh"]
