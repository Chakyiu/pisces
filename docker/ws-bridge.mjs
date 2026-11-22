import net from "node:net";

const listenPort = Number(process.env.PORT ?? 3000);
const nextPort = 3001;
const backendPort = 8787;
const headerLimit = 64 * 1024;

const server = net.createServer((client) => {
  let pending = Buffer.alloc(0);
  let decided = false;

  const reject = (status) => {
    if (client.destroyed) return;
    client.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };

  const onData = (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    if (pending.length > headerLimit) {
      client.off("data", onData);
      reject("431 Request Header Fields Too Large");
      return;
    }
    const end = pending.indexOf("\r\n\r\n");
    if (end < 0 || decided) return;
    decided = true;
    client.off("data", onData);

    const header = pending.subarray(0, end).toString("latin1");
    const [requestLine, ...headers] = header.split("\r\n");
    const [, target] = requestLine.split(" ");
    const isUpgrade = headers.some((line) => /^upgrade:\s*websocket\s*$/i.test(line));
    let path = "";
    try {
      path = new URL(target, "http://localhost").pathname;
    } catch {
      reject("400 Bad Request");
      return;
    }
    const isPrototypeExec = /^\/api\/prototype\/exec\/[A-Za-z0-9_.-]+$/.test(path);
    const upstream = net.connect(isUpgrade && isPrototypeExec ? backendPort : nextPort, "127.0.0.1");
    client.pause();
    upstream.once("connect", () => {
      upstream.write(pending);
      client.pipe(upstream);
      upstream.pipe(client);
      client.resume();
    });
    upstream.once("error", () => reject("502 Bad Gateway"));
    client.once("error", () => upstream.destroy());
  };

  client.on("data", onData);
  client.once("error", () => {});
});

server.listen(listenPort, "0.0.0.0", () => {
  console.log(`Pisces HTTP/WebSocket bridge listening on :${listenPort}`);
});
