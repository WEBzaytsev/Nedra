FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS builder

ARG VITE_API_URL=__NEDRA_API_URL__
ARG VITE_GITHUB_REPO=WEBzaytsev/Nedra
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_GITHUB_REPO=$VITE_GITHUB_REPO

WORKDIR /app

COPY frontend/package*.json ./

RUN npm ci

COPY frontend/ .

RUN npm run build


FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS runtime

ARG VITE_GITHUB_REPO=WEBzaytsev/Nedra
ENV NEDRA_GITHUB_REPO=$VITE_GITHUB_REPO

RUN addgroup -S nedra && adduser -S nedra -G nedra

WORKDIR /app

COPY docker/frontend/serve/package.json docker/frontend/serve/package-lock.json ./server/
RUN npm ci --prefix /app/server --omit=dev && npm cache clean --force
ENV PATH="/app/server/node_modules/.bin:$PATH"

COPY --from=builder --chown=nedra:nedra /app/dist ./dist
COPY --from=builder /app/serve.json ./serve.json
COPY docker/frontend/runtime-config.mjs /app/runtime-config.mjs
COPY docker/frontend/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

USER nedra

EXPOSE 3000

CMD ["/app/entrypoint.sh"]
