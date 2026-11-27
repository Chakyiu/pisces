import net from "node:net";

const listenPort = Number(process.env.PORT ?? 3000);
const nextPort = 3001;
const backendPort = 8787;
const headerLimit = 64 * 1024;
const dockerSocketPath = /^\/api\/endpoints\/[A-Za-z0-9_.-]+\/containers\/[A-Za-z0-9_.:-]+\/(console|attach)$/;

const server = net.createServer((client) => {
  let pending = Buffer.alloc(0);
  let decided = false;

  const reject = (status) => {
    if (client.destroyed) return;
    client.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };

  const onData = (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    const end = pending.indexOf("\r\n\r\n");
    if (end < 0) {
      if (pending.length > headerLimit) {
        client.off("data", onData);
        reject("431 Request Header Fields Too Large");
      }
      return;
    }
    if (end > headerLimit) {
      client.off("data", onData);
      reject("431 Request Header Fields Too Large");
      return;
    }
    if (decided) return;
    decided = true;
    client.off("data", onData);

    const header = pending.subarray(0, end).toString("latin1");
    const [requestLine, ...headers] = header.split("\r\n");
    const [, target] = requestLine.split(" ");
    if (!target) {
      reject("400 Bad Request");
      return;
    }
    let pathname = "";
    try {
      pathname = new URL(target, "http://localhost").pathname;
    } catch {
      reject("400 Bad Request");
      return;
    }
    const isWebSocket = headers.some((line) => /^upgrade:\s*websocket\s*$/i.test(line));
    const upstreamPort = isWebSocket && dockerSocketPath.test(pathname) ? backendPort : nextPort;
    const upstream = net.connect(upstreamPort, "127.0.0.1");
    let connected = false;
    client.pause();
    upstream.once("connect", () => {
      connected = true;
      upstream.write(pending);
      client.pipe(upstream);
      upstream.pipe(client);
      client.resume();
    });
    upstream.once("error", () => {
      if (connected) client.destroy();
      else reject("502 Bad Gateway");
    });
    client.once("error", () => upstream.destroy());
    client.once("close", () => upstream.destroy());
  };

  client.on("data", onData);
  client.once("error", () => {});
});

server.listen(listenPort, "0.0.0.0", () => {
  console.log(`Pisces HTTP/WebSocket bridge listening on :${listenPort}`);
});
