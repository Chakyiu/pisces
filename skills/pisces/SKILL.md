---
name: pisces-ai
description: >
  Control Docker through Pisces under the agent credential and proposal queue.
  Use when an agent should respect Pisces AI access policies instead of talking
  to the engine directly. Start skills/pisces/server.mjs as an MCP stdio server.
  Do not use the docker MCP or the pisces session cookie for this path.
---

# Pisces AI MCP

Stdio MCP server for the **Pisces agent API**. It sends `Authorization: Bearer pisces_agent_…`, honors per-container AI policies, and turns lifecycle changes into **proposals** the operator confirms in the browser.

This is the control path for “AI access” in Pisces. The sibling `skills/docker` server talks to the Docker Engine API directly and bypasses Pisces login, policies, and the proposal queue.

## Start

From the repo root, with Node.js 20+:

```bash
export PISCES_AGENT_CREDENTIAL='pisces_agent_…'   # from AI Access → issue credential
export PISCES_API_URL='http://127.0.0.1:8787'     # optional; default shown
node skills/pisces/server.mjs
```

The process reads JSON-RPC from stdin and writes responses as one JSON object per line. Errors log to stderr.

Check the wiring without a running daemon:

```bash
node --test skills/pisces/server.test.mjs
```

## Wire

Add the server to the agent MCP config. Keep the credential in the config env block or the host environment — never in the repo.

```json
{
  "mcpServers": {
    "pisces-ai": {
      "command": "node",
      "args": ["skills/pisces/server.mjs"],
      "env": {
        "PISCES_API_URL": "http://127.0.0.1:8787",
        "PISCES_AGENT_CREDENTIAL": "pisces_agent_…"
      }
    }
  }
}
```

When the client cwd is not the pisces repo, use absolute paths in `args`.

## Tools

| Tool | Effect |
| --- | --- |
| `pisces_health` | `GET /api/health` |
| `pisces_endpoints_list` | Registered engines |
| `pisces_endpoint_overview` | Counts for one endpoint |
| `pisces_container_list` | Containers visible to the agent |
| `pisces_container_get` | Inspect with redaction |
| `pisces_container_logs` | Tail logs when allowed |
| `pisces_container_start` / `stop` / `restart` | Queue a proposal (202) |

Mutations never apply Docker changes immediately. The operator reviews them under **AI access → Proposals**.