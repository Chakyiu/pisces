---
name: docker
description: >
  Control the local Docker daemon through the Engine HTTP API: list, inspect,
  start, stop, restart, remove, and run containers; list, inspect, pull, and
  remove images. Use when work in the pisces repo needs container or image
  changes. Start skills/docker/server.mjs as an MCP stdio server. Do not shell
  out to the docker CLI, and do not call the pisces Rust API for this.
---

# Docker MCP

Standalone MCP server for the local Docker engine. It speaks JSON-RPC on stdin/stdout and calls the Engine HTTP API on `DOCKER_HOST` (or the default socket). It does not use the `docker` CLI, and it does not go through the pisces login or the Rust backend.

The process can do whatever that daemon allows, including deleting containers. Point it at a socket you mean to manage.

## Start

From the repo root, with Node.js 20+:

```bash
node skills/docker/server.mjs
```

The process is silent until a client writes a JSON-RPC message to stdin. Logs and errors go to stderr. One JSON object per line, no `Content-Length` framing.

Check the wiring without a full client:

```bash
node --test skills/docker/server.test.mjs
```

That test uses a fake engine. It does not need a running daemon.

## Wire

Add the server to the agent's MCP config. The working directory should be the pisces repo so the relative path resolves. Example `.cursor/mcp.json` (do not commit secrets beside it):

```json
{
  "mcpServers": {
    "pisces-docker": {
      "command": "node",
      "args": ["skills/docker/server.mjs"]
    }
  }
}
```

If the client does not start with the repo as its cwd, pass the absolute path to `server.mjs` in `args`.

Override the engine only when the default socket is wrong:

| Variable | Meaning |
| --- | --- |
| `DOCKER_HOST` | `unix:///var/run/docker.sock`, `npipe:////./pipe/docker_engine`, or `tcp://127.0.0.1:2375` |
| `DOCKER_API_VERSION` | Engine API version. Default `1.41` |
| `DOCKER_TLS_VERIFY` | If `1` or `true`, the server exits. It does not speak TLS |

When `DOCKER_HOST` is unset, Windows uses the named pipe `//./pipe/docker_engine`. Every other OS uses `/var/run/docker.sock`.

```json
{
  "mcpServers": {
    "pisces-docker": {
      "command": "node",
      "args": ["skills/docker/server.mjs"],
      "env": {
        "DOCKER_HOST": "tcp://127.0.0.1:2375"
      }
    }
  }
}
```

After the client connects, call `docker_version`. A version payload means the engine answered. A connection error names the socket or URL it tried.

## Tools

- `docker_version` — daemon version, API version, OS, arch
- `docker_container_list` — `{ all?: boolean }` (default all)
- `docker_container_inspect` — `{ id }` (includes env)
- `docker_container_logs` — `{ id, tail?: number, timestamps?: boolean }`
- `docker_container_start` — `{ id }`
- `docker_container_stop` — `{ id, timeout?: number }`
- `docker_container_restart` — `{ id, timeout?: number }`
- `docker_container_remove` — `{ id, force?: boolean, volumes?: boolean }`
- `docker_container_run` — `{ image, name?, cmd?, env?, publish? }`
- `docker_image_list`
- `docker_image_inspect` — `{ name }`
- `docker_image_pull` — `{ image }` (public registries only)
- `docker_image_remove` — `{ name, force?: boolean }`

`id` is a container name or id, not a filesystem path. `cmd` is argv: a string is one argument, an array is the argument list. It is not passed to a shell. `publish` is `8080:80`, `8080:80/udp`, or `127.0.0.1:8080:80`. `env` entries are `KEY=VALUE`.

## Not here

No networks, volumes, exec, build, stats, or registry login. No `docker` CLI. No pisces session cookie. TLS-protected daemons (`DOCKER_TLS_VERIFY`) are refused.
