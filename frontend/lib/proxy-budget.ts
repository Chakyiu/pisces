// How long the Next proxy waits on the Rust API. `null` means do not abort:
// log and stats streams stay open until the browser disconnects.
export function proxyTimeoutMs(method: string, pathname: string): number | null {
  if (/\/(logs|stats)\/stream$/.test(pathname)) return null;
  // Compose up is allowed five minutes on the API. Creating a stack from the
  // stacks page and confirming a stack proposal are the same work; the confirm
  // route has to share that budget or the proxy reports "no response" at 10s
  // and drops the Compose process.
  const stackApply =
    (method === "POST" && /\/stacks$/.test(pathname)) ||
    ((method === "PUT" || method === "DELETE") && /\/stacks\/[^/]+$/.test(pathname)) ||
    (method === "POST" && /\/stacks\/[^/]+\/(start|stop|restart)$/.test(pathname)) ||
    (method === "POST" && /\/proposals\/[^/]+\/confirm$/.test(pathname));
  if (stackApply) return 310_000;
  // Duplicate and recreate stop a container inside the engine call, so they
  // outlive the 10s default, with a bound because they are supposed to finish.
  if (/\/(duplicate|recreate)$/.test(pathname)) return 120_000;
  return 10_000;
}
