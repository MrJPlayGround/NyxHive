FROM oven/bun:1-alpine

WORKDIR /app

# Install dependencies
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

# Copy source
COPY src/ src/
COPY config/template.toml config/template.toml
COPY config/model-costs.json config/model-costs.json
COPY config/model-tiers.json config/model-tiers.json

# Data volume mount point
VOLUME /app/data

EXPOSE 3777

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:3777/health || exit 1

CMD ["bun", "run", "src/index.ts"]
