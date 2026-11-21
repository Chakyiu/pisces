# One image: Next.js UI on :3000 and the Rust API on 127.0.0.1:8787.
# The API reaches the engine through the mounted /var/run/docker.sock.

FROM rust:1-bookworm AS backend
WORKDIR /src
COPY backend/Cargo.toml backend/Cargo.lock ./
COPY backend/src ./src
RUN cargo build --release --locked

FROM node:22-bookworm-slim AS frontend
WORKDIR /src
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend ./
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    PISCES_BIND=127.0.0.1:8787 \
    PISCES_DATA_DIR=/data \
    PISCES_API_URL=http://127.0.0.1:8787
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=backend /src/target/release/pisces-backend /usr/local/bin/pisces
COPY --from=frontend /src/.next/standalone /app
COPY --from=frontend /src/.next/static /app/.next/static
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
WORKDIR /app
VOLUME /data
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
