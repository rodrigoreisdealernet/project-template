# Mock NFS-e source API (POC) — tiny Node/Hono service.
FROM node:22-slim AS runtime

RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY src ./src

# Sample invoices are mounted at runtime (see docker-compose.yml):
#   ./docs/examples -> /app/invoices (read-only)
ENV PORT=8090
ENV INVOICES_DIR=/app/invoices
EXPOSE 8090

USER node
CMD ["node", "src/server.js"]
