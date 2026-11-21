"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { clock } from "../lib/format";

export function Icon({ name }: { name: string }) {
  const paths: Record<string, ReactNode> = {
    overview: <><rect x="3" y="3" width="4.5" height="4.5" /><rect x="8.5" y="3" width="4.5" height="4.5" /><rect x="3" y="8.5" width="4.5" height="4.5" /><rect x="8.5" y="8.5" width="4.5" height="4.5" /></>,
    containers: <><path d="M2.5 6 8 3.5 13.5 6 8 8.5 2.5 6Z" /><path d="M2.5 8.5 8 11l5.5-2.5" /><path d="M2.5 11 8 13.5 13.5 11" /></>,
    images: <><rect x="3" y="3" width="10" height="10" rx="1" /><path d="M3 10.5 6 8l2 1.5 2-2 3 3" /></>,
    volumes: <path d="M3 5.5 8 3l5 2.5v5L8 13l-5-2.5v-5Z" />,
    networks: <><circle cx="4.5" cy="8" r="1.5" /><circle cx="11.5" cy="4.5" r="1.5" /><circle cx="11.5" cy="11.5" r="1.5" /><path d="M6 8h4M10.2 5.6 6.2 7.2M10.2 10.4 6.2 8.8" /></>,
    workloads: <path d="M3 12V4h4v8M9 12V7h4v5" />,
    pods: <circle cx="8" cy="8" r="4.5" />,
    services: <path d="M8 2.5v11M3 5.5h10M3 10.5h10" />,
    endpoints: <><circle cx="8" cy="8" r="2" /><path d="M8 2.5v2M8 11.5v2M2.5 8h2M11.5 8h2" /></>,
  };
  return (
    <svg className="icon" viewBox="0 0 16 16" aria-hidden="true">
      {paths[name] ?? paths.overview}
    </svg>
  );
}

export function Badge({ state }: { state: string }) {
  const tone = state === "running" ? "ok" : state === "paused" || state === "restarting" ? "warn" : state === "dead" ? "bad" : "muted";
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
}: {
  title: string;
  message: string;
  attempts: number;
  at?: Date;
  onRetry: () => void;
}) {
  return (
    <div className="state" role="alert">
      <h2>{title}</h2>
      <p>{message}</p>
      <button className="btn" onClick={onRetry}>Retry</button>
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
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
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
        className="dialog"
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
