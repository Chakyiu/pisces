"use client";

import { useEffect, useState } from "react";
import { ApiError, api } from "../lib/api";
import { Dialog } from "./bits";

export function DockerDialog({ onClose, onAdd }: { onClose: () => void; onAdd: (name: string) => Promise<void> }) {
  const [name, setName] = useState("local");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  return (
    <Dialog title="Add Docker endpoint" onClose={onClose}>
      <label className="label">
        Name
        <input className="field" value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <label className="label">
        Engine
        <input className="field" readOnly value="This machine" />
      </label>
      {error ? <p className="field-error">{error}</p> : null}
      <div className="dialog-actions">
        <button className="btn" type="button" onClick={onClose}>Cancel</button>
        <button
          className="btn primary"
          type="button"
          disabled={pending}
          onClick={() => {
            setPending(true);
            setError("");
            onAdd(name.trim() || "local").catch((err: unknown) => {
              setError(err instanceof ApiError ? err.message : "The endpoint could not be added.");
              setPending(false);
            });
          }}
        >
          {pending ? "Adding…" : "Add"}
        </button>
      </div>
    </Dialog>
  );
}

export function KubernetesDialog({
  onClose,
  onAdd,
}: {
  onClose: () => void;
  onAdd: (name: string, context: string) => Promise<void>;
}) {
  const [name, setName] = useState("desk");
  const [contexts, setContexts] = useState<string[] | null>(null);
  const [context, setContext] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  function load() {
    setContexts(null);
    setError("");
    api<{ items: { name: string }[] }>("/api/kubernetes/contexts")
      .then((body) => {
        setContexts(body.items.map((item) => item.name));
        setContext(body.items[0]?.name ?? "");
      })
      .catch((err: unknown) => {
        setContexts([]);
        setError(err instanceof ApiError ? `Couldn’t load contexts. ${err.message}` : "Couldn’t load contexts.");
      });
  }

  useEffect(() => { load(); }, []);

  const empty = contexts !== null && contexts.length === 0 && !error;
  return (
    <Dialog title="Add Kubernetes context" onClose={onClose}>
      <label className="label">
        Name
        <input className="field" value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <label className="label">
        Context
        {contexts === null ? (
          <select className="select" disabled><option>Loading contexts…</option></select>
        ) : error ? (
          <span className="field-error">{error} <button className="btn" type="button" onClick={load}>Retry</button></span>
        ) : empty ? (
          <span className="note">No Kubernetes context is visible to the server.</span>
        ) : (
          <select className="select" value={context} onChange={(event) => setContext(event.target.value)}>
            {contexts.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        )}
      </label>
      <div className="dialog-actions">
        <button className="btn" type="button" onClick={onClose}>Cancel</button>
        <button
          className="btn primary"
          type="button"
          disabled={pending || !context || Boolean(error) || contexts === null}
          onClick={() => {
            setPending(true);
            onAdd(name.trim() || "desk", context).catch((err: unknown) => {
              setError(err instanceof ApiError ? err.message : "The endpoint could not be added.");
              setPending(false);
            });
          }}
        >
          {pending ? "Adding…" : "Add"}
        </button>
      </div>
    </Dialog>
  );
}
