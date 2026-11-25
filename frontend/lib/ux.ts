/** Same-origin return path for the login `next` query. Rejects off-site and login loops. */
export function safeNextPath(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return null;
  if (value.includes("\\") || value.includes("\n") || value.includes("\r") || value.includes("\0")) return null;
  let url: URL;
  try {
    url = new URL(value, "http://pisces.local");
  } catch {
    return null;
  }
  if (url.origin !== "http://pisces.local" || url.username || url.password) return null;
  let path = url.pathname;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || path.includes("://")) return null;
  if (path === "/login" || path.startsWith("/login/")) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

const DOCKER_SECTIONS = ["/containers", "/stacks", "/images", "/networks", "/volumes"] as const;

/** Keep the Docker section when switching environments. Resource ids do not carry over. */
export function dockerSectionHref(
  pathname: string,
  fromId: string | undefined,
  toId: string,
  toKind: string,
  fromKind: string | undefined,
): string {
  const base = `/e/${toId}`;
  if (toKind !== "docker" || !fromId || fromKind !== "docker") return base;
  const prefix = `/e/${fromId}`;
  if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) return base;
  const rest = pathname.slice(prefix.length);
  const section = DOCKER_SECTIONS.find((item) => rest === item || rest.startsWith(`${item}/`));
  return section ? `${base}${section}` : base;
}

/** Names on a bulk confirm: five, then "and N more". */
export function listedNames(names: string[], limit = 5): string {
  if (names.length <= limit) return names.join(", ");
  return `${names.slice(0, limit).join(", ")} and ${names.length - limit} more`;
}

export function changedEnvKeys(
  before: { key: string; value: string }[],
  after: { key: string; value: string }[],
): string[] {
  const prev = new Map<string, string>();
  for (const row of before) {
    const key = row.key.trim();
    if (key) prev.set(key, row.value);
  }
  const next = new Map<string, string>();
  for (const row of after) {
    const key = row.key.trim();
    if (key) next.set(key, row.value);
  }
  const keys = new Set([...prev.keys(), ...next.keys()]);
  return [...keys].filter((key) => prev.get(key) !== next.get(key)).sort();
}

export function parsePort(raw: string): { host: number; container: number; protocol: string } | "empty" | null {
  const value = raw.trim();
  if (!value) return "empty";
  const single = /^(\d{1,5})$/.exec(value);
  if (single) {
    const port = Number(single[1]);
    if (port < 1 || port > 65535) return null;
    return { host: port, container: port, protocol: "tcp" };
  }
  const pair = /^(\d{1,5}):(\d{1,5})(?:\/(tcp|udp|sctp))?$/i.exec(value);
  if (!pair) return null;
  const host = Number(pair[1]);
  const container = Number(pair[2]);
  if (host < 1 || host > 65535 || container < 1 || container > 65535) return null;
  return { host, container, protocol: (pair[3] ?? "tcp").toLowerCase() };
}

export function withEndpointCrumbs<T extends { label: string }>(
  current: { id: string; name: string } | undefined,
  crumbs: T[],
  pathname: string,
): T[] {
  if (!current || (pathname !== `/e/${current.id}` && !pathname.startsWith(`/e/${current.id}/`))) return crumbs;
  if (crumbs[0]?.label === "Home") return crumbs;
  const home = { label: "Home", href: "/home" } as unknown as T;
  const endpoint = { label: current.name, href: `/e/${current.id}`, mono: true } as unknown as T;
  return [home, endpoint, ...crumbs];
}
