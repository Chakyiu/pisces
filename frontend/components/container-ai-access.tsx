"use client";

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import Link from "next/link";
import { ApiError, api } from "../lib/api";
import { clock } from "../lib/format";
import type { AiAccess, AiAccessLabel, AiAccessState } from "../lib/types";

const OPTIONS: { value: AiAccessState; label: string; tone: string; help: string }[] = [
  {
    value: "locked",
    label: "Locked",
    tone: "",
    help: "Default. The agent sees one list row — name, state, image, ports. No logs, no details, no actions.",
  },
  {
    value: "read",
    label: "Read",
    tone: "ok",
    help: "The agent can read logs and non-secret details. Environment values, label values, mount paths, and the console stay hidden, and it cannot change anything.",
  },
  {
    value: "operate",
    label: "Operate",
    tone: "warn",
    help: "Everything in Read, plus start, stop, restart, settings, duplicate, recreate, and stack apply as proposals you confirm. The agent never calls Docker itself.",
  },
];

export function ContainerAiAccess({
  endpointId,
  containerId,
  containerName,
}: {
  endpointId: string;
  containerId: string;
  containerName: string;
}) {
  const [value, setValue] = useState<AiAccess | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState<AiAccessState | null>(null);
  const [saved, setSaved] = useState<Date | null>(null);
  const [failure, setFailure] = useState("");
  const [pending, setPending] = useState<number | null>(null);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  async function load() {
    setStatus("loading");
    try {
      const body = await api<AiAccess>(`/api/ai-access/${endpointId}/${encodeURIComponent(containerId)}`);
      setValue(body);
      setStatus("ready");
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : "The API did not answer within 10 seconds.");
      setStatus("error");
    }
  }

  useEffect(() => {
    void load();
    // The container id is the key; the endpoint never changes under one detail page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpointId, containerId]);

  async function save(next: AiAccessState) {
    if (!value || saving || value.forcedLocked || next === value.state) return;
    setSaving(next);
    setFailure("");
    try {
      await api(`/api/ai-access/${endpointId}/${encodeURIComponent(containerId)}`, {
        method: "PUT",
        body: { state: next },
      });
      setValue({ ...value, state: next });
      setSaved(new Date());
    } catch (err) {
      const text = err instanceof ApiError ? err.message : "The API did not answer within 10 seconds.";
      setFailure(`${next[0].toUpperCase()}${next.slice(1)} was not saved. ${text} This container is still ${value.state}, and the agent's access did not change.`);
    } finally {
      setSaving(null);
    }
  }

  useEffect(() => {
    if (value?.state !== "operate") {
      setPending(null);
      return;
    }
    let live = true;
    api<{ items: { status: string }[] }>("/api/proposals")
      .then((body) => {
        if (live) setPending(body.items.filter((item) => item.status === "pending").length);
      })
      .catch(() => undefined);
    return () => { live = false; };
  }, [value?.state]);

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!value) return;
    const keys = ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const enabled = OPTIONS.filter((option) => !(value.forcedLocked && option.value !== "locked"));
    const index = enabled.findIndex((option) => option.value === value.state);
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
    const target = enabled[(index + step + enabled.length) % enabled.length];
    if (!target) return;
    const all = OPTIONS.findIndex((option) => option.value === target.value);
    buttons.current[all]?.focus();
    void save(target.value);
  }

  if (status === "loading" && !value) {
    return (
      <section className="widget">
        <h2>AI access</h2>
        <div className="widget-pad">
          <div className="skel" />
          <div className="skel" />
          <p className="note">Loading AI access</p>
        </div>
      </section>
    );
  }

  if (status === "error" || !value) {
    return (
      <section className="widget">
        <h2>AI access</h2>
        <div className="widget-pad">
          <div className="alert bad" role="alert">
            <strong>The agent policy for this container could not be read.</strong>
            <p>{message} The agent sees nothing for this container until Pisces can read the policy.</p>
          </div>
          <button className="btn" type="button" onClick={() => void load()}>Try again</button>
        </div>
      </section>
    );
  }

  const current = OPTIONS.find((option) => option.value === value.state) ?? OPTIONS[0];

  return (
    <section className="widget">
      <h2>AI access</h2>
      <div className="widget-pad">
        {value.forcedLocked ? (
          <div className="alert" role="alert">
            <strong>Locked for the agent — {value.reason}.</strong>
            {value.mount ? <p>Matched mount: <code>{value.mount}</code>.</p> : null}
            <p>
              A container that mounts the Docker socket, the Docker named pipe, host /, or the Pisces
              data directory can take over this machine, so Read and Operate are not offered. You can
              still manage it here in the browser.
            </p>
          </div>
        ) : null}
        <div className="bulk ai-seg" role="radiogroup" aria-label={`AI access for ${containerName}`} onKeyDown={onKeyDown}>
          {OPTIONS.map((option, index) => {
            const forced = value.forcedLocked && option.value !== "locked";
            const checked = value.state === option.value;
            return (
              <button
                key={option.value}
                ref={(node) => { buttons.current[index] = node; }}
                className="btn"
                type="button"
                role="radio"
                aria-checked={checked}
                aria-disabled={forced || value.forcedLocked || undefined}
                tabIndex={checked ? 0 : -1}
                title={forced ? `Not available: this container mounts ${value.mount ?? value.reason}` : undefined}
                disabled={forced || value.forcedLocked || Boolean(saving)}
                onClick={() => void save(option.value)}
              >
                <i className={`sq ${option.tone}`} />
                {option.label}
              </button>
            );
          })}
        </div>
        <p className="ai-help">{current.help}</p>
        <p className="ai-help">Your browser session is unrestricted in every state.</p>
        {value.forcedLocked ? (
          <p className="ai-help">Set by Pisces. Not editable while that mount exists.</p>
        ) : (
          <p className="ai-status" role="status">
            {saving ? "Saving…" : saved ? `Saved ${clock(saved)}.` : ""}
          </p>
        )}
        {value.state === "operate" && pending !== null ? (
          <Link className="ai-link" href="/ai-access/proposals">
            {pending === 0 ? "The proposal queue is empty." : `Review ${pending} pending proposal${pending === 1 ? "" : "s"}.`}
          </Link>
        ) : null}
        {failure ? (
          <div className="alert bad" role="alert">
            <strong>{failure}</strong>
            <button className="btn" type="button" onClick={() => void save(current.value)}>Try again</button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

/** The list-row form of the policy: never asks the API for more detail. */
export function AiAccessBadge({ access }: { access?: AiAccessLabel | null }) {
  if (!access) return <span className="note">—</span>;
  if (access.forcedLocked) {
    return (
      <span className="badge muted" title={`Forced lock: ${access.reason}${access.mount ? ` (${access.mount})` : ""}`}>
        <i className="sq" />Locked · forced
      </span>
    );
  }
  const tone = access.state === "read" ? "ok" : access.state === "operate" ? "warn" : "muted";
  const label = access.state === "read" ? "Read" : access.state === "operate" ? "Operate" : "Locked";
  return (
    <span className={`badge ${tone}`}>
      <i className={`sq ${tone}`} />{label}
    </span>
  );
}
