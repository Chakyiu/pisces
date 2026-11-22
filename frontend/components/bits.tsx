"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { clock } from "../lib/format";

export function Icon({ name }: { name: string }) {
  const paths: Record<string, ReactNode> = {
    overview: <><rect x="3" y="3" width="4.5" height="4.5" /><rect x="8.5" y="3" width="4.5" height="4.5" /><rect x="3" y="8.5" width="4.5" height="4.5" /><rect x="8.5" y="8.5" width="4.5" height="4.5" /></>,
    stacks: <><rect x="2.5" y="2.5" width="11" height="3" rx="0.5" /><rect x="2.5" y="6.5" width="11" height="3" rx="0.5" /><rect x="2.5" y="10.5" width="11" height="3" rx="0.5" /></>,
    containers: <><path d="M2.5 6 8 3.5 13.5 6 8 8.5 2.5 6Z" /><path d="M2.5 8.5 8 11l5.5-2.5" /><path d="M2.5 11 8 13.5 13.5 11" /></>,
    images: <><rect x="3" y="3" width="10" height="10" rx="1" /><path d="M3 10.5 6 8l2 1.5 2-2 3 3" /></>,
    volumes: <path d="M3 5.5 8 3l5 2.5v5L8 13l-5-2.5v-5Z" />,
    networks: <><circle cx="4.5" cy="8" r="1.5" /><circle cx="11.5" cy="4.5" r="1.5" /><circle cx="11.5" cy="11.5" r="1.5" /><path d="M6 8h4M10.2 5.6 6.2 7.2M10.2 10.4 6.2 8.8" /></>,
    workloads: <path d="M3 12V4h4v8M9 12V7h4v5" />,
    pods: <circle cx="8" cy="8" r="4.5" />,
    services: <path d="M8 2.5v11M3 5.5h10M3 10.5h10" />,
    home: <><path d="M2.5 7.5 8 3l5.5 4.5" /><path d="M4.5 7v6h7V7" /></>,
    slash: <path d="M10.5 3 5.5 13" />,
    docker: <><path d="M2.5 6 8 3.5 13.5 6 8 8.5 2.5 6Z" /><path d="M2.5 8.5 8 11l5.5-2.5" /><path d="M2.5 11 8 13.5 13.5 11" /></>,
    kubernetes: <path d="M8 2.2 13.2 5.2v5.6L8 13.8 2.8 10.8V5.2L8 2.2Z" />,
    clear: <path d="M4 4l8 8M12 4 4 12" />,
    sidebar: <><rect x="2" y="3" width="12" height="10" rx="1" /><path d="M6 3v10" /></>,
    refresh: <><path d="M13.2 8a5.2 5.2 0 1 1-1.4-3.6" /><path d="M11.8 2.2v2.6H9.2" /></>,
    user: <><circle cx="8" cy="5.5" r="2" /><path d="M3.5 13.2c.8-2.2 2.4-3.3 4.5-3.3s3.7 1.1 4.5 3.3" /></>,
    "sign-out": <><path d="M9.5 2.5H4.8A1.3 1.3 0 0 0 3.5 3.8v8.4a1.3 1.3 0 0 0 1.3 1.3h4.7" /><path d="M7.5 8h6" /><path d="M11 5.5 13.5 8 11 10.5" /></>,
    chevron: <path d="M4 6.5 8 10.5 12 6.5" />,
    logs: <><path d="M4 2.5h5.2L12.5 6v7.5H4Z" /><path d="M9.2 2.5V6H12.5" /><path d="M6 8.5h4M6 11h3" /></>,
    play: <path d="M5.5 3.5v9l7-4.5-7-4.5Z" />,
    stop: <rect x="4" y="4" width="8" height="8" rx="1" />,
    restart: <><path d="M13 8a5 5 0 1 1-1.6-3.6" /><path d="M11.6 2.2v2.8H8.8" /></>,
    trash: <><path d="M3.5 5h9" /><path d="M6.2 5V3.5h3.6V5" /><path d="M5 5.5l.6 8h4.8l.6-8" /></>,
    plus: <path d="M8 3.5v9M3.5 8h9" />,
    eye: <><path d="M2 8s2.4-3.8 6-3.8S14 8 14 8s-2.4 3.8-6 3.8S2 8 2 8Z" /><circle cx="8" cy="8" r="1.6" /></>,
    "eye-off": <><path d="M2 8s2.4-3.8 6-3.8S14 8 14 8s-2.4 3.8-6 3.8S2 8 2 8Z" /><circle cx="8" cy="8" r="1.6" /><path d="M3 13 13 3" /></>,
    copy: <><rect x="6" y="6" width="7" height="7" rx="1" /><path d="M10 6V4.2A1.2 1.2 0 0 0 8.8 3H4.2A1.2 1.2 0 0 0 3 4.2v4.6A1.2 1.2 0 0 0 4.2 10H6" /></>,
    console: <><rect x="2.5" y="3" width="11" height="10" rx="1" /><path d="m4.5 6 2 2-2 2M8 10h3" /></>,
  };
  return (
    <svg className="icon" viewBox="0 0 16 16" aria-hidden="true">
      {paths[name] ?? paths.overview}
    </svg>
  );
}

export function IconButton({
  name,
  label,
  onClick,
  disabled,
}: {
  name: string;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button className="icon-btn" type="button" aria-label={label} title={label} onClick={onClick} disabled={disabled}>
      <Icon name={name} />
    </button>
  );
}

export function Badge({ state }: { state: string }) {
  const key = state.toLowerCase();
  const tone = key === "running" || key === "up" ? "ok" : key === "paused" || key === "restarting" || key === "partial" ? "warn" : key === "dead" || key === "down" ? "bad" : "muted";
  return (
    <span className={`badge ${tone}`}>
      <i className={`sq ${tone}`} />
      {state || "unknown"}
    </span>
  );
}

export function Loading({ noun }: { noun: string }) {
  return (
    <div>
      <div className="skel" />
      <div className="skel" />
      <div className="skel" />
      <p className="note">Loading {noun}</p>
    </div>
  );
}

export function ErrorState({
  title,
  message,
  attempts,
  at,
  onRetry,
  retryLabel,
}: {
  title: string;
  message: string;
  attempts: number;
  at?: Date;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <div className="state" role="alert">
      <h2>{title}</h2>
      <p>{message}</p>
      {onRetry ? <button className="btn" onClick={onRetry}>{retryLabel ?? "Retry"}</button> : null}
      {attempts > 0 && at ? (
        <p className="note">Last attempted: {clock(at)} · {attempts} {attempts === 1 ? "retry" : "retries"}</p>
      ) : null}
    </div>
  );
}

export function Empty({ title, body, action }: { title: string; body: string; action?: { label: string; onClick: () => void; primary?: boolean } }) {
  return (
    <div className="state">
      <h2>{title}</h2>
      <p>{body}</p>
      {action ? <button className={action.primary ? "btn primary" : "btn"} onClick={action.onClick}>{action.label}</button> : null}
    </div>
  );
}

export function Dialog({
  title,
  onClose,
  children,
  className,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = ref.current;
    const previous = document.activeElement as HTMLElement | null;
    const focusable = () =>
      Array.from(node?.querySelectorAll<HTMLElement>("button, input, select, textarea, a[href]") ?? []).filter(
        (el) => !el.hasAttribute("disabled"),
      );
    const initial = focusable().find((el) => el.dataset.focus === "first") ?? focusable()[0];
    initial?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={onClose}>
      <div
        className={`dialog ${className ?? ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        ref={ref}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id="dialog-title">{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function Gate({ title, body, onRetry }: { title: string; body?: string; onRetry?: () => void }) {
  return (
    <div className="gate">
      <div>
        <h1>{title}</h1>
        {body ? <p className="note">{body}</p> : null}
        {onRetry ? <button className="btn" onClick={onRetry}>Retry</button> : null}
      </div>
    </div>
  );
}
