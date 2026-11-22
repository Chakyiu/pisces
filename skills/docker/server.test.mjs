import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  apiVersion,
  assertContainerRef,
  demuxDockerLogs,
  dispatch,
  handleRpc,
  parseImageRef,
  parsePublish,
  resolveEndpoint,
  summarizePull,
} from "./server.mjs";

const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "server.mjs");

test("resolveEndpoint uses the platform socket and DOCKER_HOST", () => {
  assert.deepEqual(resolveEndpoint({}, "win32"), {
    kind: "npipe",
    path: "//./pipe/docker_engine",
  });
  assert.deepEqual(resolveEndpoint({}, "linux"), {
    kind: "unix",
    path: "/var/run/docker.sock",
  });
  assert.deepEqual(resolveEndpoint({ DOCKER_HOST: "unix:///var/run/docker.sock" }, "win32"), {
    kind: "unix",
    path: "/var/run/docker.sock",
  });
  assert.deepEqual(
    resolveEndpoint({ DOCKER_HOST: "npipe:////./pipe/docker_engine" }, "linux"),
    { kind: "npipe", path: "//./pipe/docker_engine" },
  );
  assert.deepEqual(resolveEndpoint({ DOCKER_HOST: "tcp://127.0.0.1:2375" }), {
    kind: "tcp",
    hostname: "127.0.0.1",
    port: 2375,
  });
  assert.equal(apiVersion({}), "1.41");
  assert.throws(() => resolveEndpoint({ DOCKER_TLS_VERIFY: "1" }), /plaintext/);
  assert.throws(() => resolveEndpoint({ DOCKER_HOST: "ssh://example" }), /Unsupported/);
  assert.throws(() => apiVersion({ DOCKER_API_VERSION: "latest" }), /1\.41/);
});

test("image refs and publish specs", () => {
  assert.deepEqual(parseImageRef("nginx"), { fromImage: "nginx", tag: "latest" });
  assert.deepEqual(parseImageRef("nginx:1.25"), { fromImage: "nginx", tag: "1.25" });
  assert.deepEqual(parseImageRef("localhost:5000/app"), {
    fromImage: "localhost:5000/app",
    tag: "latest",
  });
  assert.deepEqual(parseImageRef("localhost:5000/app:v1"), {
    fromImage: "localhost:5000/app",
    tag: "v1",
  });
  assert.deepEqual(parseImageRef("nginx@sha256:abc"), {
    fromImage: "nginx@sha256:abc",
    tag: null,
  });
  assert.throws(() => parseImageRef("../nginx"), /not valid/);
  assert.throws(() => assertContainerRef("a/b"), /not valid/);
  assert.deepEqual(parsePublish("8080:80"), {
    ip: "",
    host: "8080",
    container: "80",
    proto: "tcp",
  });
  assert.deepEqual(parsePublish("127.0.0.1:8080:80/udp"), {
    ip: "127.0.0.1",
    host: "8080",
    container: "80",
    proto: "udp",
  });
});

test("docker log frames and pull progress", () => {
  const frame = Buffer.alloc(8 + 6);
  frame[0] = 1;
  frame.writeUInt32BE(6, 4);
  frame.write("hello\n", 8);
  assert.equal(demuxDockerLogs(frame), "hello\n");
  assert.equal(demuxDockerLogs(Buffer.from("plain tty")), "plain tty");
  const summary = summarizePull(
    [
      JSON.stringify({ status: "Downloading", id: "layer" }),
      JSON.stringify({ status: "Pull complete", id: "layer" }),
      JSON.stringify({ status: "Status: Downloaded newer image for alpine:latest" }),
    ].join("\n"),
  );
  assert.equal(summary.includes("Downloading"), false);
  assert.match(summary, /Pull complete/);
  assert.throws(() => summarizePull(JSON.stringify({ error: "denied" })), /denied/);
});

test("bad container ids never reach the engine", async () => {
  let called = false;
  await assert.rejects(
    () =>
      dispatch(
        async () => {
          called = true;
        },
        "docker_container_start",
        { id: "../x" },
      ),
    /not valid/,
  );
  assert.equal(called, false);
});

test("run sends argv and does not split a command string", async () => {
  const calls = [];
  const request = async (spec) => {
    calls.push(spec);
    if (spec.path === "/containers/create") return { Id: "created123", Warnings: [] };
    return null;
  };
  const result = await dispatch(request, "docker_container_run", {
    image: "alpine:3.20",
    name: "job",
    cmd: "echo hi",
    env: ["FOO=bar"],
    publish: "8080:80",
  });
  assert.equal(result.id, "created123");
  assert.deepEqual(calls[0].json.Cmd, ["echo hi"]);
  assert.deepEqual(calls[0].json.Env, ["FOO=bar"]);
  assert.deepEqual(calls[0].json.HostConfig.PortBindings["80/tcp"], [
    { HostIp: "", HostPort: "8080" },
  ]);
  assert.equal(calls[0].query.name, "job");
  assert.equal(calls[1].path, "/containers/created123/start");
});

test("stdio server talks to the engine API", async () => {
  const seen = [];
  const engine = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString("utf8") });
    const url = req.url ?? "";
    if (url === "/version") {
      json(res, 200, { Version: "27.0.0", ApiVersion: "1.45", Os: "linux", Arch: "amd64" });
      return;
    }
    if (url.startsWith("/v1.41/containers/json")) {
      json(res, 200, [
        {
          Id: "abc123abc123deadbeef",
          Names: ["/web"],
          Image: "nginx:latest",
          State: "running",
          Status: "Up 1 second",
          Ports: [{ IP: "0.0.0.0", PrivatePort: 80, PublicPort: 8080, Type: "tcp" }],
        },
      ]);
      return;
    }
    if (url.startsWith("/v1.41/containers/abc/logs")) {
      const frame = Buffer.alloc(8 + 6);
      frame[0] = 1;
      frame.writeUInt32BE(6, 4);
      frame.write("hello\n", 8);
      res.end(frame);
      return;
    }
    if (req.method === "POST" && url === "/v1.41/containers/abc/start") {
      res.statusCode = 204;
      res.end();
      return;
    }
    if (req.method === "POST" && url === "/v1.41/containers/missing/start") {
      json(res, 404, { message: "No such container: missing" });
      return;
    }
    if (req.method === "POST" && url.startsWith("/v1.41/images/create")) {
      res.end(
        [
          JSON.stringify({ status: "Downloading", id: "layer" }),
          JSON.stringify({ status: "Pull complete", id: "layer" }),
          JSON.stringify({ status: "Status: Downloaded newer image for alpine:latest" }),
          "",
        ].join("\n"),
      );
      return;
    }
    json(res, 500, { message: `unexpected ${req.method} ${url}` });
  });
  await new Promise((resolve) => engine.listen(0, "127.0.0.1", resolve));
  const port = engine.address().port;
  const client = mcpClient(port);
  try {
    const init = await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    assert.equal(init.result.serverInfo.name, "pisces-docker");
    client.notify("notifications/initialized");
    const listed = await client.request("tools/list");
    const names = listed.result.tools.map((tool) => tool.name);
    assert.ok(names.includes("docker_container_list"));
    assert.ok(names.includes("docker_image_pull"));

    const containers = JSON.parse(await tool(client, "docker_container_list", {}));
    assert.equal(containers[0].name, "web");
    assert.equal(containers[0].ports[0].public, 8080);

    assert.equal(await tool(client, "docker_container_logs", { id: "abc" }), "hello\n");
    assert.deepEqual(JSON.parse(await tool(client, "docker_container_start", { id: "abc" })), {
      id: "abc",
      started: true,
    });

    const missing = await client.request("tools/call", {
      name: "docker_container_start",
      arguments: { id: "missing" },
    });
    assert.equal(missing.result.isError, true);
    assert.match(missing.result.content[0].text, /No such container/);

    const pull = await tool(client, "docker_image_pull", { image: "alpine:3.20" });
    assert.equal(pull.includes("Downloading"), false);
    assert.match(pull, /Downloaded newer image/);

    const version = JSON.parse(await tool(client, "docker_version", {}));
    assert.equal(version.apiVersion, "1.45");

    const unknown = await handleRpc({ jsonrpc: "2.0", id: 9, method: "nope" }, async () => {
      throw new Error("should not call");
    });
    assert.equal(unknown.error.code, -32601);
  } finally {
    await client.stop();
    engine.close();
  }
  assert.ok(seen.some((call) => call.url.startsWith("/v1.41/containers/json")));
});

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(payload);
}

async function tool(client, name, args) {
  const response = await client.request("tools/call", { name, arguments: args });
  assert.notEqual(response.result.isError, true, response.result?.content?.[0]?.text);
  return response.result.content[0].text;
}

function mcpClient(port) {
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      DOCKER_HOST: `tcp://127.0.0.1:${port}`,
      DOCKER_API_VERSION: "1.41",
      DOCKER_TLS_VERIFY: "",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  const waiters = new Map();
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    out += chunk;
    let nl;
    while ((nl = out.indexOf("\n")) >= 0) {
      const line = out.slice(0, nl).trim();
      out = out.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const waiter = waiters.get(msg.id);
      if (!waiter) continue;
      waiters.delete(msg.id);
      waiter(msg);
    }
  });
  child.stderr.on("data", (chunk) => {
    err += chunk;
  });
  let next = 1;
  return {
    request(method, params) {
      const id = next++;
      const response = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(id);
          reject(new Error(`timed out on ${method}\nstderr: ${err}`));
        }, 5000);
        waiters.set(id, (msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return response;
    },
    notify(method) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
    },
    async stop() {
      child.kill();
      await Promise.race([
        once(child, "exit").catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
    },
  };
}
