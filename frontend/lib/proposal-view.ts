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

function withProtocol(value: string): string {
  return value.includes("/") ? value : `${value}/tcp`;
}

/** A duplicate's port line, in the forms `docker::parse_port_line` accepts. */
function publishLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed) return "";
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("expose:")) {
    return `${withProtocol(trimmed.slice("expose:".length).trim())} (exposed only, not published)`;
  }
  if (lower.startsWith("auto:")) {
    return `${ALL_INTERFACES}:<random> → ${withProtocol(trimmed.slice("auto:".length).trim())}`;
  }
  const parts = trimmed.split(":");
  if (parts.length === 2) {
    return `${ALL_INTERFACES}:${parts[0]} → ${withProtocol(parts[1])}`;
  }
  if (parts.length === 3) {
    return `${parts[0]}:${parts[1]} → ${withProtocol(parts[2])}`;
  }
  return trimmed;
}

function portsOf(value: unknown): string {
  const lines = entries(value).flatMap((entry) => {
    if (typeof entry === "string") {
      const line = publishLine(entry);
      return line ? [line] : [];
    }
    if (entry && typeof entry === "object") {
      const port = entry as Bag;
      const container = port.container;
      const host = port.host;
      const protocol = text(port.protocol) || "tcp";
      if (typeof container !== "number" && typeof container !== "string") return [];
      const published = host === undefined || host === null ? "<random>" : String(host);
      return [`${ALL_INTERFACES}:${published} → ${String(container)}/${protocol}`];
    }
    return [];
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
