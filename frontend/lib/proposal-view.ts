/**
 * Turns a stored proposal payload into the list of effective values the
 * operator is consenting to. Every field a proposal can change is rendered
 * here: a field with no proposed value is shown as inherited or unchanged, and
 * a payload key this module does not know is still listed (with its value
 * hidden) so nothing can be changed silently.
 *
 * Values the agent is not allowed to keep — environment values, label values
 * and mount sources — are never rendered; Pisces blanks them before a proposal
 * is stored, and this module only ever shows the keys or the destination.
 */

export type ProposalField = { label: string; value: string };

type Bag = Record<string, unknown>;

const HIDDEN = "changed (value hidden)";

const FROM_IMAGE = "From the image (this proposal does not set it)";
const UNCHANGED = "Rebuilt from the container's current configuration (unchanged)";

const KNOWN_KEYS: Record<string, string[]> = {
  run: ["action", "image", "name", "ports"],
  settings: ["name", "restart_policy", "restart_maximum_retry_count"],
  duplicate: [
    "name",
    "image",
    "command",
    "entrypoint",
    "env",
    "labels",
    "ports",
    "mounts",
    "restart_policy",
  ],
  recreate: ["action"],
  start: ["action"],
  stop: ["action"],
  restart: ["action"],
  "stack-create": ["project", "compose"],
  "stack-update": ["project", "compose"],
};

function bag(payload: unknown): Bag {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return payload as Bag;
  }
  return {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function entries(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function present(value: unknown): boolean {
  return value !== undefined && value !== null;
}

/** Environment or label keys, in the two shapes a payload can carry. */
function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      if (typeof entry === "string") {
        const key = entry.split("=")[0].trim();
        return key ? [key] : [];
      }
      if (entry && typeof entry === "object") {
        const key = text((entry as Bag).key);
        return key ? [key] : [];
      }
      return [];
    });
  }
  if (value && typeof value === "object") {
    return Object.keys(value as Bag).filter(Boolean);
  }
  return [];
}

/** Mount destinations only: the source stays blank, so it is never shown. */
function mountsOf(value: unknown): string[] {
  return entries(value).flatMap((entry) => {
    if (typeof entry === "string") {
      const [, rest] = entry.split(":");
      const destination = (rest ?? entry).split(":").slice(0, 1).join("").trim();
      return destination ? [destination] : [];
    }
    if (entry && typeof entry === "object") {
      const mount = entry as Bag;
      const destination = text(mount.destination);
      if (!destination) return [];
      const kind = text(mount.mount_type) || "bind";
      return [`${destination} (${kind}${mount.read_only === true ? ", read-only" : ""})`];
    }
    return [];
  });
}

/** Every published port on this daemon is bound to all interfaces, so the bind
 * address is rendered instead of left implicit: the operator is approving the
 * exposure, not just the number. */
const ALL_INTERFACES = "0.0.0.0";

/** `docker::parse_port_line` and `special_port_line` accept these only. */
const PROTOCOLS = ["tcp", "udp", "sctp"];

const NOT_A_MAPPING = "not a valid port mapping, so this proposal will be rejected";

/** `str::parse::<u16>` with the port-range check the engine applies. */
function u16Port(value: string): number | null {
  if (!/^\+?\d+$/.test(value)) return null;
  const port = Number(value);
  return port >= 1 && port <= 65535 ? port : null;
}

/** `docker::special_port_line` (backend/src/docker.rs:839). The prefix match is
 * case-sensitive, so `Expose:3000` is not the expose form and never becomes one. */
function specialPort(line: string, prefix: string): { matched: boolean; port: string | null } {
  if (!line.startsWith(prefix)) return { matched: false, port: null };
  const value = line.slice(prefix.length);
  const slash = value.indexOf("/");
  const raw = slash < 0 ? value : value.slice(0, slash);
  const protocol = slash < 0 ? "tcp" : value.slice(slash + 1);
  const port = u16Port(raw);
  const valid = port !== null && PROTOCOLS.includes(protocol);
  return { matched: true, port: valid ? `${port}/${protocol}` : null };
}

/** `docker::parse_port_line` (backend/src/docker.rs:810): `host:container`, a
 * single bare port, and an optional `/tcp`, `/udp` or `/sctp`. */
function portMapping(line: string): { host: number; container: number; protocol: string } | null {
  const slash = line.indexOf("/");
  const mapping = slash < 0 ? line : line.slice(0, slash);
  const protocol = slash < 0 ? "tcp" : line.slice(slash + 1);
  if (!PROTOCOLS.includes(protocol)) return null;
  const colon = mapping.indexOf(":");
  const host = u16Port(colon < 0 ? mapping : mapping.slice(0, colon));
  const container = u16Port(colon < 0 ? mapping : mapping.slice(colon + 1));
  if (host === null || container === null) return null;
  return { host, container, protocol };
}

/** One duplicate port line, rendered as the engine would apply it — or as the
 * rejection it will be. Lines the engine skips outright render as null. */
function publishLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const expose = specialPort(trimmed, "expose:");
  if (expose.matched) {
    return expose.port ? `${expose.port} (exposed only, not published)` : `${trimmed} — ${NOT_A_MAPPING}`;
  }
  const auto = specialPort(trimmed, "auto:");
  if (auto.matched) {
    return auto.port ? `${ALL_INTERFACES}:<random> → ${auto.port}` : `${trimmed} — ${NOT_A_MAPPING}`;
  }
  const mapping = portMapping(trimmed);
  if (!mapping) return `${trimmed} — ${NOT_A_MAPPING}`;
  return `${ALL_INTERFACES}:${mapping.host} → ${mapping.container}/${mapping.protocol}`;
}

/** A `RunPortBody`, whose host and container are already integers. */
function objectPort(entry: Bag): string {
  const port = (value: unknown): number | null =>
    typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535
      ? value
      : typeof value === "string"
        ? u16Port(value.trim())
        : null;
  const host = port(entry.host);
  const container = port(entry.container);
  const protocol = text(entry.protocol) || "tcp";
  const valid = host !== null && container !== null && PROTOCOLS.includes(protocol);
  return valid
    ? `${ALL_INTERFACES}:${host} → ${container}/${protocol}`
    : `Invalid port mapping — ${NOT_A_MAPPING}`;
}

function portsOf(value: unknown): string {
  const lines = entries(value).flatMap((entry) => {
    if (typeof entry === "string") {
      const line = publishLine(entry);
      return line ? [line] : [];
    }
    if (entry && typeof entry === "object") return [objectPort(entry as Bag)];
    return [`${String(entry)} — ${NOT_A_MAPPING}`];
  });
  return lines.length > 0 ? lines.join("\n") : "None published";
}

function commandOf(value: unknown): string {
  const joined = text(value);
  if (joined) return joined;
  return entries(value)
    .filter((part): part is string => typeof part === "string")
    .join(" ");
}

function policyOf(value: unknown, retries?: unknown): string {
  const policy = text(value);
  if (!policy) return "No restart policy";
  const maximum = typeof retries === "number" ? `${retries} retries` : text(retries);
  return maximum ? `${policy} (${maximum})` : policy;
}

function hiddenKeys(action: string, payload: Bag): ProposalField[] {
  const known = new Set(KNOWN_KEYS[action] ?? []);
  return Object.keys(payload)
    .filter((key) => !known.has(key))
    .sort()
    .map((key) => ({ label: key, value: HIDDEN }));
}

/**
 * What a duplicate does to the source container. Docker compares the requested
 * name with the *live* name ignoring case, so this does too; the source is
 * identified by its recorded id, never by a display-name fallback.
 */
export type DuplicateEffect = "copy" | "replace" | "replace-unknown-source";

export function duplicateEffect(
  containerName: string | null | undefined,
  containerId: string | null | undefined,
  proposedName: unknown,
): DuplicateEffect {
  const proposed = text(proposedName);
  if (!proposed) return "copy";
  const source = text(containerName);
  if (!source) return text(containerId) ? "replace-unknown-source" : "copy";
  return proposed.toLowerCase() === source.toLowerCase() ? "replace" : "copy";
}

/**
 * Effective fields for one proposal. Stack actions return no rows: their
 * payload is a compose file and the review dialog renders it as a diff.
 */
export function effectiveFields(action: string, payload: unknown): ProposalField[] {
  const body = bag(payload);
  const unknown = hiddenKeys(action, body);

  switch (action) {
    case "run": {
      const name = text(body.name);
      return [
        { label: "Name", value: name || "Generated by Docker" },
        { label: "Image", value: text(body.image) || "Missing image reference" },
        { label: "Published ports", value: portsOf(body.ports) },
        { label: "Command", value: FROM_IMAGE },
        { label: "Entrypoint", value: FROM_IMAGE },
        { label: "Restart policy", value: FROM_IMAGE },
        ...unknown,
      ];
    }
    case "settings": {
      const name = text(body.name);
      return [
        { label: "Name", value: name || "Unchanged" },
        {
          label: "Restart policy",
          value: policyOf(body.restart_policy, body.restart_maximum_retry_count),
        },
        ...unknown,
      ];
    }
    case "duplicate": {
      const image = text(body.image);
      const command = commandOf(body.command);
      const entrypoint = commandOf(body.entrypoint);
      const policy = text(body.restart_policy);
      const envKeys = present(body.env) ? keysOf(body.env) : [];
      const labelKeys = present(body.labels) ? keysOf(body.labels) : [];
      const mounts = present(body.mounts) ? mountsOf(body.mounts) : [];
      return [
        { label: "New name", value: text(body.name) || "Missing name" },
        { label: "Image", value: image || "The source's image (unchanged)" },
        { label: "Published ports", value: present(body.ports) ? portsOf(body.ports) : "The source's published ports (unchanged)" },
        { label: "Command", value: command || "The source's command (unchanged)" },
        { label: "Entrypoint", value: entrypoint || "The source's entrypoint (unchanged)" },
        { label: "Restart policy", value: policy || "The source's restart policy (unchanged)" },
        {
          label: "Environment keys",
          value: present(body.env)
            ? `${envKeys.length > 0 ? envKeys.join(", ") : "every entry"} (values removed)`
            : "Inherited from the source",
        },
        {
          label: "Label keys",
          value: present(body.labels)
            ? `${labelKeys.length > 0 ? labelKeys.join(", ") : "every label"} (values removed)`
            : "Inherited from the source",
        },
        {
          label: "Mounts",
          value: present(body.mounts)
            ? mounts.length > 0
              ? mounts.join(", ")
              : "No mounts"
            : "Inherited from the source",
        },
        ...unknown,
      ];
    }
    case "recreate":
      return [
        { label: "Configuration", value: UNCHANGED },
        ...unknown,
      ];
    case "start":
    case "stop":
    case "restart":
      return [
        { label: "Configuration", value: "Unchanged; this only changes the container's state" },
        ...unknown,
      ];
    default:
      if (action.startsWith("stack-")) return unknown;
      return [ { label: "Payload", value: "Unrecognised action; review the stored request before confirming" }, ...unknown ];
  }
}
