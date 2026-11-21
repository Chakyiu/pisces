# Pisces

A Portainer-like web app for managing Docker and Kubernetes: a **Next.js** frontend and a
**Rust** backend that provides authenticated API control over the Docker daemon and the
Kubernetes API.

This repository is the scaffold only. Layout, views and the API surface are decided by the
UI/UX spec first (TELE-71); the first working Docker slice follows in TELE-73.

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

Backend, from `backend/` — listens on `http://127.0.0.1:8787`:

```powershell
cargo run
```

Frontend, from `frontend/` — listens on `http://localhost:3000`:

```powershell
npm install
npm run dev
```

The home page calls the backend's `/api/health` and shows whether it is reachable. The
frontend server reads the backend base URL from `PISCES_API_URL` (default
`http://127.0.0.1:8787`).

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

**Auth (decided, not implemented).** Local password hash with `argon2` 0.6.0, and a
short-lived bearer JWT with `jsonwebtoken` 12.0.0 carried in an httpOnly cookie. No auth
code, no secrets and no `.env` file are committed; configuration is read from the
environment and real values live outside the repository.

`argon2` and `jsonwebtoken` are pinned but unused until auth lands, so `cargo check`
reports two `unused dependency` warnings — expected at this stage.

## Secrets

Nothing in this repo needs a credential to build. Do not commit tokens, passwords, or `.env`
files; `.gitignore` already excludes `.env` and `.env.*`.
