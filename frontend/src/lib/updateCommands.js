export const MANUAL_UPDATE_COMMAND =
  "docker compose -f docker-compose.prod.yml exec backend nedra-admin snapshot && \\\n" +
  "docker compose -f docker-compose.prod.yml pull && \\\n" +
  "docker compose -f docker-compose.prod.yml up -d";
