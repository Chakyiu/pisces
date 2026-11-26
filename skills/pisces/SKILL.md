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
node --test skills/pisces/server.test.mjs skills/mcp-audit.test.mjs
```

## Audit log

Every `tools/call` appends one JSON object to a JSONL file. `initialize`, `ping`, and `tools/list` are not action runs and are not logged. The line has `id`, `server` (`pisces`), `tool`, `startedAt`, `finishedAt`, `durationMs`, `outcome` (`ok` or `error`), `error`, `args`, and `client` (`name` and `version` from the latest `initialize`). Tool results are not stored.

Argument values are redacted when the key looks like a secret (`token`, `password`, `secret`, `credential`, `authorization`, `apiKey`, and similar), when a string contains `pisces_agent_…`, or when it contains the `PISCES_AGENT_CREDENTIAL` value. An `env` entry whose name matches that pattern is stored as `KEY=[REDACTED]`.

| Variable | Meaning |
| --- | --- |
| `PISCES_MCP_AUDIT_RETENTION_DAYS` | Days to keep. Default `30`. Integer `0`–`3650`. |
| `PISCES_MCP_AUDIT_LOG` | JSONL path. Default `~/.pisces/mcp-audit/pisces.jsonl` (the home directory of the process). |
| `PISCES_MCP_AUDIT_CONFIG` | JSON file. Default `~/.pisces/mcp-audit.json`. |

The file is a JSON object. `retentionDays` and `logPath` are optional. Environment variables win. A missing file uses the defaults. Each tool call drops lines whose `finishedAt` is older than the retention window, then appends the new line. `0` drops every line older than that write. One process should own a given log file.

See a purge without waiting 30 days: call a tool, edit that line's `finishedAt` to 31 days ago, call any tool again. The old line is gone. Setting `PISCES_MCP_AUDIT_RETENTION_DAYS=0` and calling a tool leaves only the latest line.

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