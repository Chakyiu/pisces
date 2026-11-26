#!/usr/bin/env node
// Stdio MCP server for the Docker Engine HTTP API. No docker CLI, no npm packages.
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { noteClient, openAudit, writeToolAudit } from "../mcp-audit.mjs";

const DEFAULT_API = "1.41";
const MAX_TEXT = 48 * 1024;
const SUPPORTED_PROTOCOLS = ["2024-11-05", "2025-03-26", "2025-06-18"];
const DROP_PULL_STATUS = new Set([
  "Downloading",
  "Extracting",
  "Waiting",
  "Verifying Checksum",
  "Pulling fs layer",
]);

const idProp = {
  type: "string",
  description: "Container name or id. Not a path.",
};

export const TOOLS = [
  {
    name: "docker_version",
    description: "Read the local Docker daemon version. Use this to confirm the engine is reachable.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "docker_container_list",
    description: "List containers on the local engine.",
    inputSchema: {
      type: "object",
      properties: {
        all: {
          type: "boolean",
          description: "Include stopped containers. Defaults to true.",
        },
      },
    },
  },
  {
    name: "docker_container_inspect",
    description: "Inspect one container. The result includes env, which can hold secrets.",
    inputSchema: {
      type: "object",
      properties: { id: idProp },
      required: ["id"],
    },
  },
  {
    name: "docker_container_logs",
    description: "Read stdout and stderr from a container. Does not follow.",
    inputSchema: {
      type: "object",
      properties: {
        id: idProp,
        tail: {
          type: "integer",
          description: "Last N lines, 1 to 2000. Defaults to 200.",
        },
        timestamps: { type: "boolean", description: "Prefix each line with a timestamp." },
      },
      required: ["id"],
    },
  },
  {
    name: "docker_container_start",
    description: "Start a container.",
    inputSchema: {
      type: "object",
      properties: { id: idProp },
      required: ["id"],
    },
  },
  {
    name: "docker_container_stop",
    description: "Stop a container.",
    inputSchema: {
      type: "object",
      properties: {
        id: idProp,
        timeout: {
          type: "integer",
          description: "Seconds to wait before killing. Defaults to 10.",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "docker_container_restart",
    description: "Restart a container.",
    inputSchema: {
      type: "object",
      properties: {
        id: idProp,
        timeout: {
          type: "integer",
          description: "Seconds to wait before killing. Defaults to 10.",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "docker_container_remove",
    description: "Remove a container.",
    inputSchema: {
      type: "object",
      properties: {
        id: idProp,
        force: { type: "boolean", description: "Kill the container if it is running." },
        volumes: { type: "boolean", description: "Also remove anonymous volumes." },
      },
      required: ["id"],
    },
  },
  {
    name: "docker_container_run",
    description:
      "Create and start a container. cmd is argv, not a shell command. publish entries look like 8080:80 or 127.0.0.1:8080:80/tcp.",
    inputSchema: {
      type: "object",
      properties: {
        image: { type: "string", description: "Image name, with an optional tag." },
        name: { type: "string", description: "Container name." },
        cmd: {
          description: "One string (a single argument) or an array of arguments. Not parsed by a shell.",
        },
        env: {
          type: "array",
          items: { type: "string" },
          description: "KEY=VALUE entries.",
        },
        publish: {
          description: "Port publish string or list, for example 8080:80.",
        },
      },
      required: ["image"],
    },
  },
  {
    name: "docker_image_list",
    description: "List images on the local engine.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "docker_image_inspect",
    description: "Inspect one image by name or id.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Image name, tag, or id." },
      },
      required: ["name"],
    },
  },
  {
    name: "docker_image_pull",
    description:
      "Pull an image from a registry. Public images only: no registry auth header is sent.",
    inputSchema: {
      type: "object",
      properties: {
        image: { type: "string", description: "Image reference, for example nginx:1.27 or alpine." },
      },
      required: ["image"],
    },
  },
  {
    name: "docker_image_remove",
    description: "Remove an image.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Image name, tag, or id." },
        force: { type: "boolean", description: "Remove even if a container still references it." },
      },
      required: ["name"],
    },
  },
];

export function resolveEndpoint(env, platform = process.platform) {
  const tls = String(env.DOCKER_TLS_VERIFY ?? "").trim().toLowerCase();
  // shortcut: mTLS via DOCKER_CERT_PATH is not implemented; refuse rather than speak plaintext to a TLS daemon.
  if (tls === "1" || tls === "true") {
    throw new Error("DOCKER_TLS_VERIFY is set. This server talks to the Docker API in plaintext only.");
  }
  const host = String(env.DOCKER_HOST ?? "").trim();
  if (!host) {
    if (platform === "win32") return { kind: "npipe", path: "//./pipe/docker_engine" };
    return { kind: "unix", path: "/var/run/docker.sock" };
  }
  if (host.startsWith("unix://")) {
    const socketPath = host.slice("unix://".length);
    if (!socketPath.startsWith("/")) {
      throw new Error(`DOCKER_HOST unix socket path is missing: ${host}`);
    }
    return { kind: "unix", path: socketPath };
  }
  if (host.startsWith("npipe://")) {
    const pipe = host.slice("npipe://".length).replace(/^\/+/, "");
    if (!pipe) throw new Error(`DOCKER_HOST named pipe is missing: ${host}`);
    return { kind: "npipe", path: pipe.startsWith("./") ? `//${pipe}` : `//./${pipe}` };
  }
  if (host.startsWith("tcp://")) {
    let url;
    try {
      url = new URL(host);
    } catch {
      throw new Error(`DOCKER_HOST is not a valid TCP URL: ${host}`);
    }
    const port = url.port ? Number(url.port) : 2375;
    if (!url.hostname || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`DOCKER_HOST is not a valid TCP URL: ${host}`);
    }
    return { kind: "tcp", hostname: url.hostname, port };
  }
  throw new Error(`Unsupported DOCKER_HOST (${host}). Use unix://, npipe://, or tcp://.`);
}

export function apiVersion(env) {
  const version = String(env.DOCKER_API_VERSION ?? "").trim() || DEFAULT_API;
  if (!/^\d+\.\d+$/.test(version)) {
    throw new Error(`DOCKER_API_VERSION must look like 1.41, got ${version}`);
  }
  return version;
}

export function assertContainerRef(raw) {
  const name = String(raw ?? "").trim();
  if (
    name.length < 1 ||
    name.length > 128 ||
    name.includes("..") ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)
  ) {
    throw new Error("Container id or name is not valid.");
  }
  return name;
}

export function assertImageRef(raw) {
  const name = String(raw ?? "").trim();
  if (
    name.length < 1 ||
    name.length > 255 ||
    name.includes("..") ||
    name.includes("://") ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:@/-]*$/.test(name)
  ) {
    throw new Error("Image name is not valid.");
  }
  return name;
}

export function parseImageRef(raw) {
  const name = assertImageRef(raw);
  if (name.includes("@")) return { fromImage: name, tag: null };
  const slash = name.lastIndexOf("/");
  const colon = name.indexOf(":", slash + 1);
  if (colon >= 0) {
    const tag = name.slice(colon + 1);
    if (!tag) throw new Error("Image name is not valid.");
    return { fromImage: name.slice(0, colon), tag };
  }
  return { fromImage: name, tag: "latest" };
}

export function parsePublish(raw) {
  if (typeof raw !== "string") throw new Error("publish entry must be a string");
  let spec = raw.trim();
  let proto = "tcp";
  const slash = spec.lastIndexOf("/");
  if (slash >= 0) {
    proto = spec.slice(slash + 1);
    spec = spec.slice(0, slash);
    if (proto !== "tcp" && proto !== "udp") throw new Error(`Bad protocol in publish ${raw}`);
  }
  const parts = spec.split(":");
  let ip = "";
  let host;
  let container;
  if (parts.length === 2) {
    [host, container] = parts;
  } else if (parts.length === 3) {
    [ip, host, container] = parts;
  } else {
    throw new Error(`Publish must look like 8080:80 or 127.0.0.1:8080:80, got ${raw}`);
  }
  if (ip && !ipv4(ip)) throw new Error(`Bad bind address in publish ${raw}`);
  return {
    ip,
    host: portNumber(host, "host port", raw),
    container: portNumber(container, "container port", raw),
    proto,
  };
}

export function demuxDockerLogs(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input ?? ""), "utf8");
  if (buf.length === 0) return "";
  const parts = [];
  let offset = 0;
  while (offset + 8 <= buf.length) {
    const stream = buf[offset];
    const framed =
      (stream === 1 || stream === 2) &&
      buf[offset + 1] === 0 &&
      buf[offset + 2] === 0 &&
      buf[offset + 3] === 0;
    const size = framed ? buf.readUInt32BE(offset + 4) : -1;
    if (!framed || offset + 8 + size > buf.length) return buf.toString("utf8");
    parts.push(buf.subarray(offset + 8, offset + 8 + size).toString("utf8"));
    offset += 8 + size;
  }
  if (offset !== buf.length) return buf.toString("utf8");
  return parts.join("");
}

export function summarizePull(text) {
  const kept = [];
  const errors = [];
  for (const line of String(text ?? "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row;
    try {
      row = JSON.parse(trimmed);
    } catch {
      kept.push(trimmed);
      continue;
    }
    if (row.error) errors.push(String(row.error));
    else if (row.status && !DROP_PULL_STATUS.has(row.status)) {
      kept.push(row.id ? `${row.id}: ${row.status}` : row.status);
    }
  }
  if (errors.length) throw new Error(errors.join("; "));
  return kept.slice(-40).join("\n") || "(no status)";
}

export function dockerRequest(endpoint, version, spec) {
  const timeoutMs = spec.timeoutMs ?? 20_000;
  const query = spec.query
    ? `?${new URLSearchParams(
        Object.entries(spec.query).filter(([, value]) => value != null),
      ).toString()}`
    : "";
  const apiPath = `${spec.absolute ? "" : `/v${version}`}${spec.path}${query}`;
  const payload = spec.json === undefined ? null : Buffer.from(JSON.stringify(spec.json));
  const headers = {
    Host: "localhost",
    Accept: spec.raw ? "*/*" : "application/json",
    Connection: "close",
  };
  if (payload) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = String(payload.length);
  }
  // The default agent reuses a named-pipe socket, and the next call hangs on Windows.
  const options = { method: spec.method, path: apiPath, headers, agent: false };
  if (endpoint.kind === "tcp") {
    options.hostname = endpoint.hostname;
    options.port = endpoint.port;
  } else {
    options.socketPath = endpoint.path;
  }

  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks);
        if (res.statusCode >= 400) {
          reject(new Error(dockerErrorMessage(res.statusCode, body)));
          return;
        }
        if (spec.raw) {
          resolve(body);
          return;
        }
        if (body.length === 0) {
          resolve(null);
          return;
        }
        const text = body.toString("utf8");
        try {
          resolve(JSON.parse(text));
        } catch {
          resolve(text);
        }
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Docker engine timed out after ${timeoutMs}ms`));
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export async function dispatch(request, name, args = {}) {
  switch (name) {
    case "docker_version": {
      const version = await request({ method: "GET", path: "/version", absolute: true });
      return {
        version: version?.Version ?? "",
        apiVersion: version?.ApiVersion ?? "",
        os: version?.Os ?? "",
        arch: version?.Arch ?? "",
      };
    }
    case "docker_container_list": {
      const all = flag(args.all, true, "all");
      const rows = await request({
        method: "GET",
        path: "/containers/json",
        query: { all: all ? "1" : "0" },
      });
      return (Array.isArray(rows) ? rows : []).map(compactContainer);
    }
    case "docker_container_inspect": {
      const id = assertContainerRef(args.id);
      return compactInspect(
        await request({ method: "GET", path: `/containers/${encodeURIComponent(id)}/json` }),
      );
    }
    case "docker_container_logs": {
      const id = assertContainerRef(args.id);
      const body = await request({
        method: "GET",
        path: `/containers/${encodeURIComponent(id)}/logs`,
        query: {
          stdout: "1",
          stderr: "1",
          follow: "0",
          tail: tailCount(args.tail),
          timestamps: flag(args.timestamps, false, "timestamps") ? "1" : "0",
        },
        raw: true,
      });
      return demuxDockerLogs(body);
    }
    case "docker_container_start": {
      const id = assertContainerRef(args.id);
      await request({ method: "POST", path: `/containers/${encodeURIComponent(id)}/start` });
      return { id, started: true };
    }
    case "docker_container_stop": {
      const id = assertContainerRef(args.id);
      await request({
        method: "POST",
        path: `/containers/${encodeURIComponent(id)}/stop`,
        query: { t: timeoutSeconds(args.timeout) },
      });
      return { id, stopped: true };
    }
    case "docker_container_restart": {
      const id = assertContainerRef(args.id);
      await request({
        method: "POST",
        path: `/containers/${encodeURIComponent(id)}/restart`,
        query: { t: timeoutSeconds(args.timeout) },
      });
      return { id, restarted: true };
    }
    case "docker_container_remove": {
      const id = assertContainerRef(args.id);
      await request({
        method: "DELETE",
        path: `/containers/${encodeURIComponent(id)}`,
        query: {
          force: flag(args.force, false, "force") ? "1" : "0",
          v: flag(args.volumes, false, "volumes") ? "1" : "0",
        },
      });
      return { id, removed: true };
    }
    case "docker_container_run": {
      const image = assertImageRef(args.image);
      const containerName =
        args.name == null || args.name === "" ? undefined : assertContainerRef(args.name);
      const json = { Image: image };
      if (args.cmd != null) json.Cmd = argv(args.cmd, "cmd");
      if (args.env != null) json.Env = envList(args.env);
      const published = publishList(args.publish);
      if (published) {
        json.ExposedPorts = published.exposed;
        json.HostConfig = { PortBindings: published.bindings };
      }
      const created = await request({
        method: "POST",
        path: "/containers/create",
        query: containerName ? { name: containerName } : undefined,
        json,
      });
      const id = created?.Id;
      if (typeof id !== "string" || !/^[A-Za-z0-9]+$/.test(id)) {
        throw new Error("Docker created a container without a usable id");
      }
      try {
        await request({ method: "POST", path: `/containers/${encodeURIComponent(id)}/start` });
      } catch (err) {
        throw new Error(`Created ${id} but start failed: ${err.message}`);
      }
      return { id, warnings: created.Warnings ?? [] };
    }
    case "docker_image_list": {
      const rows = await request({ method: "GET", path: "/images/json" });
      return (Array.isArray(rows) ? rows : []).map((row) => ({
        id: typeof row.Id === "string" ? row.Id.slice(0, 19) : "",
        tags: Array.isArray(row.RepoTags) ? row.RepoTags : [],
        size: row.Size ?? 0,
        created: row.Created ?? 0,
      }));
    }
    case "docker_image_inspect": {
      const image = assertImageRef(args.name);
      const row = await request({
        method: "GET",
        path: `/images/${encodeURIComponent(image)}/json`,
      });
      return {
        id: row?.Id ?? "",
        tags: row?.RepoTags ?? [],
        size: row?.Size ?? 0,
        created: row?.Created ?? "",
        architecture: row?.Architecture ?? "",
        os: row?.Os ?? "",
        cmd: row?.Config?.Cmd ?? [],
        entrypoint: row?.Config?.Entrypoint ?? [],
        exposed: Object.keys(row?.Config?.ExposedPorts ?? {}),
      };
    }
    case "docker_image_pull": {
      // shortcut: the pull body is buffered until the daemon closes it; cap or stream if large pulls are common.
      const { fromImage, tag } = parseImageRef(args.image);
      const body = await request({
        method: "POST",
        path: "/images/create",
        query: tag ? { fromImage, tag } : { fromImage },
        raw: true,
        timeoutMs: 120_000,
      });
      return summarizePull(Buffer.isBuffer(body) ? body.toString("utf8") : String(body ?? ""));
    }
    case "docker_image_remove": {
      const image = assertImageRef(args.name);
      await request({
        method: "DELETE",
        path: `/images/${encodeURIComponent(image)}`,
        query: { force: flag(args.force, false, "force") ? "1" : "0" },
      });
      return { name: image, removed: true };
    }
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}

export async function handleRpc(message, request, audit = null) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } };
  }
  const { id, method, params } = message;
  if (typeof method !== "string") {
    if (id == null) return null;
    return { jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid request" } };
  }
  if (method.startsWith("notifications/")) return null;
  if (method === "initialize") {
    noteClient(audit, params?.clientInfo);
    const requested = params?.protocolVersion;
    const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : "2024-11-05";
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "pisces-docker", version: "0.1.0" },
        instructions:
          "Local Docker Engine API for container and image lifecycle. Inspect includes container env.",
      },
    };
  }
  if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
  if (method === "tools/call") {
    const name = params?.name;
    const toolArgs =
      params?.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
        ? params.arguments
        : {};
    const startedAtMs = Date.now();
    if (typeof name !== "string" || !name) {
      const message = "tools/call needs a tool name";
      writeToolAudit(audit, { tool: "", args: toolArgs, startedAtMs, outcome: "error", error: message });
      return toolError(id, message);
    }
    try {
      const value = await dispatch(request, name, toolArgs);
      const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      writeToolAudit(audit, { tool: name, args: toolArgs, startedAtMs, outcome: "ok", error: null });
      return {
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: clip(text) }] },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      writeToolAudit(audit, { tool: name, args: toolArgs, startedAtMs, outcome: "error", error: message });
      return toolError(id, message);
    }
  }
  if (id == null) return null;
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
}

function toolError(id, text) {
  return {
    jsonrpc: "2.0",
    id,
    result: { content: [{ type: "text", text }], isError: true },
  };
}

function clip(text) {
  if (text.length <= MAX_TEXT) return text;
  return `${text.slice(0, MAX_TEXT)}\n… truncated ${text.length - MAX_TEXT} bytes`;
}

function flag(value, fallback, label) {
  if (value == null) return fallback;
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "1" || value === 1) return true;
  if (value === "false" || value === "0" || value === 0) return false;
  throw new Error(`${label} must be a boolean`);
}

function timeoutSeconds(value) {
  if (value == null) return "10";
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 300) {
    throw new Error("timeout must be an integer from 0 to 300");
  }
  return String(number);
}

function tailCount(value) {
  if (value == null) return "200";
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 2000) {
    throw new Error("tail must be an integer from 1 to 2000");
  }
  return String(number);
}

function argv(value, label) {
  if (typeof value === "string") {
    if (!value.trim()) throw new Error(`${label} is empty`);
    return [value];
  }
  if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string")) {
    return value;
  }
  throw new Error(`${label} must be a string or an array of strings`);
}

function envList(value) {
  if (!Array.isArray(value)) throw new Error("env must be an array of KEY=VALUE strings");
  for (const item of value) {
    if (typeof item !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*=/.test(item)) {
      throw new Error("env entries must look like KEY=VALUE");
    }
  }
  return value;
}

function publishList(value) {
  if (value == null) return null;
  const items = Array.isArray(value) ? value : [value];
  if (items.length === 0) return null;
  const exposed = {};
  const bindings = {};
  for (const item of items) {
    const pub = parsePublish(item);
    const key = `${pub.container}/${pub.proto}`;
    exposed[key] = {};
    bindings[key] = bindings[key] ?? [];
    bindings[key].push({ HostIp: pub.ip, HostPort: pub.host });
  }
  return { exposed, bindings };
}

function compactContainer(row) {
  const names = Array.isArray(row.Names) ? row.Names.map((name) => String(name).replace(/^\//, "")) : [];
  return {
    id: typeof row.Id === "string" ? row.Id.slice(0, 12) : "",
    name: names[0] ?? "",
    image: row.Image ?? "",
    state: row.State ?? "",
    status: row.Status ?? "",
    ports: Array.isArray(row.Ports)
      ? row.Ports.map((port) => ({
          ip: port.IP || "",
          public: port.PublicPort ?? null,
          private: port.PrivatePort ?? null,
          protocol: port.Type ?? "tcp",
        }))
      : [],
  };
}

function compactInspect(row) {
  const networks = row?.NetworkSettings?.Networks ?? {};
  return {
    id: row?.Id ?? "",
    name: String(row?.Name ?? "").replace(/^\//, ""),
    image: row?.Config?.Image ?? "",
    state: row?.State?.Status ?? "",
    running: Boolean(row?.State?.Running),
    created: row?.Created ?? "",
    cmd: row?.Config?.Cmd ?? [],
    env: row?.Config?.Env ?? [],
    restart: row?.HostConfig?.RestartPolicy?.Name ?? "",
    ports: row?.HostConfig?.PortBindings ?? {},
    mounts: Array.isArray(row?.Mounts)
      ? row.Mounts.map((mount) => ({
          source: mount.Source ?? "",
          destination: mount.Destination ?? "",
          mode: mount.Mode ?? "",
        }))
      : [],
    networks: Object.entries(networks).map(([name, network]) => ({
      name,
      ip: network?.IPAddress ?? "",
    })),
  };
}

function dockerErrorMessage(status, body) {
  const text = body.toString("utf8").trim();
  if (!text) return `Docker API ${status}`;
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed.message === "string" && parsed.message.trim()) {
      return `Docker API ${status}: ${parsed.message.trim()}`;
    }
  } catch {
    // Daemon sent a plain-text body.
  }
  return `Docker API ${status}: ${text.slice(0, 500)}`;
}

function ipv4(ip) {
  const parts = ip.split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function portNumber(value, label, raw) {
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error(`Bad ${label} in publish ${raw}`);
  }
  return String(Number(value));
}

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function onLine(line, request, audit) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    writeMessage({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  const response = await handleRpc(message, request, audit);
  if (response) writeMessage(response);
}

function main() {
  const endpoint = resolveEndpoint(process.env);
  const version = apiVersion(process.env);
  const request = (spec) => dockerRequest(endpoint, version, spec);
  const audit = openAudit(process.env, "docker");
  let buffer = "";
  // shortcut: stdin lines are not size-capped; only a local MCP client should be attached.
  let chain = Promise.resolve();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    while (true) {
      const nl = buffer.indexOf("\n");
      if (nl < 0) break;
      const line = buffer.slice(0, nl).replace(/\r$/, "").trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      chain = chain.then(() => onLine(line, request, audit)).catch((err) => {
        process.stderr.write(`docker-mcp: ${err.message}\n`);
      });
    }
  });
  process.stdin.on("end", () => {
    chain.finally(() => process.exit(0));
  });
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  const left = path.resolve(entry);
  const right = path.resolve(fileURLToPath(import.meta.url));
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

if (isDirectRun()) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`docker-mcp: ${err.message}\n`);
    process.exit(1);
  }
}
