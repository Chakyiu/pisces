# Pisces

A Portainer-like web app for managing Docker and Kubernetes: a **Next.js** frontend and a
**Rust** backend that provides authenticated API control over the Docker daemon and the
Kubernetes API.

The Docker slice (TELE-73) is the working console: sign in, add this machine's engine, and
start, stop, inspect, and remove containers, plus images, volumes, and networks.
Kubernetes views are present in the shell and wait on TELE-74.

## Layout

```
backend/    Rust API server (axum), Docker client (bollard), Kubernetes client (kube)
frontend/   Next.js App Router app (TypeScript)
```

## Prerequisites

- Rust 1.85+ (`cargo check` was verified on 1.100.0)
- Node.js 20+ and npm
- Docker Desktop, running, for anything that talks to Docker
- A kubeconfig only if you actually want Kubernetes; no cluster is required to build

## Dev loop (Windows, two terminals)

Backend, from `backend/` — listens on `http://127.0.0.1:8787`. Set the three variables
in the shell before `cargo run`. Do not commit them.

- `PISCES_USERNAME` — the single operator name
- `PISCES_PASSWORD_HASH` — argon2 PHC string from `cargo run -- hash-password` (password on stdin)
- `PISCES_JWT_SECRET` — 32 or more characters, used only to sign the session cookie

```powershell
cargo run -- hash-password
cargo run
```

Frontend, from `frontend/` — listens on `http://localhost:3000`. The browser talks to
`/api/*` on that origin; Next proxies to `PISCES_API_URL` (default `http://127.0.0.1:8787`)
so the session cookie stays on port 3000.

```powershell
npm install
npm run dev
```

Open `http://localhost:3000`, sign in, and add a Docker endpoint named `local`. The engine
is always this machine. Endpoint names are stored in `PISCES_DATA_DIR` (default `data/`).

Checks:

```powershell
cd backend;  cargo check
cd frontend; npm run build
```

## Decisions

**Docker client — `bollard` 0.21.1.** Talks the daemon HTTP API directly; on Windows it
reaches Docker Desktop over the named pipe `//./pipe/docker_engine`
(`Docker::connect_with_named_pipe_defaults()`), on Linux/macOS over the local socket.
Client construction is lazy, so a stopped daemon breaks requests, not startup.

**Kubernetes — `kube` 5.1.0 + `k8s-openapi` 0.29.0 (feature `v1_34`).** Dependencies only:
no cluster is assumed. The API snapshot is pinned via the `k8s-openapi` feature so types do
not drift under us.

**Auth.** Local password hash with `argon2` 0.6.0, and an 8-hour bearer JWT with
`jsonwebtoken` 12.0.0 in the httpOnly cookie `pisces_session` (`SameSite=Lax`, not
`Secure`, because the dev console is plain HTTP on localhost). `POST /api/session` signs
in, `DELETE /api/session` signs out, and every other `/api` route except `GET /api/health`
rejects a missing or bad cookie with 401. No secret file is committed.

## Secrets

Nothing in this repo needs a credential to build. Do not commit tokens, passwords, or `.env`
files; `.gitignore` already excludes `.env` and `.env.*`.
