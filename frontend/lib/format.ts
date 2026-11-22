import type { Port } from "./types";

export function age(unix: number): string {
  if (!unix) return "—";
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - unix);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function bytes(value: number): string {
  if (!value) return "0 B";
  const gb = value / 1024 ** 3;
  if (gb >= 1) return `${gb >= 10 ? Math.round(gb) : trim(gb)} GB`;
  const mb = value / 1024 ** 2;
  if (mb >= 1) return `${mb >= 10 ? Math.round(mb) : trim(mb)} MB`;
  return `${Math.max(1, Math.round(value / 1024))} KB`;
}

function trim(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}

export function portList(ports: Port[]): string {
  if (ports.length === 0) return "—";
  return ports.map((port) => {
    const host = port.host ? `${port.host} → ` : "";
    return `${host}${port.container}/${port.protocol}${port.host ? "" : " (exposed)"}`;
  }).join(", ");
}

export function stamp(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

export function clock(date: Date): string {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function imageLabel(tags: string[]): string {
  return tags.find((item) => item && item !== "<none>:<none>") || "<none>:<none>";
}

export function shortId(id: string): string {
  return id.replace(/^sha256:/, "").slice(0, 12);
}

export function blank(value: string | null | undefined): string {
  return value && value.trim() ? value : "None";
}
