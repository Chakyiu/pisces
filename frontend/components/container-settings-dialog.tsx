"use client";

import { useState } from "react";
import { ApiError, api } from "../lib/api";
import { Dialog } from "./bits";

export function ContainerSettingsDialog({
  endpointId,
  containerId,
  name: currentName,
  restartPolicy,
  retryCount,
  onClose,
  onSaved,
}: {
  endpointId: string;
  containerId: string;
  name: string;
  restartPolicy: string;
  retryCount: number | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(currentName);
  const [restart, setRestart] = useState(restartPolicy || "no");
  const [retries, setRetries] = useState(String(retryCount ?? 0));
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function submit() {
    const maximumRetries = Number(retries);
    if (restart === "on-failure" && (!Number.isInteger(maximumRetries) || maximumRetries < 0)) {
      setError("Retry count must be a non-negative whole number.");
      return;
    }
    setPending(true);
    setError("");
    try {
      await api(`/api/endpoints/${endpointId}/containers/${encodeURIComponent(containerId)}/settings`, {
        method: "PUT",
        body: {
          name: name.trim(),
          restart_policy: restart,
          restart_maximum_retry_count: restart === "on-failure" ? maximumRetries : null,
        },
      });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Container settings could not be updated.");
      setPending(false);
    }
  }

  return (
    <Dialog title="Edit container settings" onClose={onClose}>
      <label className="label">
        Name
        <input className="field" data-focus="first" value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <label className="label">
        Restart policy
        <select className="select" value={restart} onChange={(event) => setRestart(event.target.value)}>
          <option value="no">no</option>
          <option value="always">always</option>
          <option value="unless-stopped">unless-stopped</option>
          <option value="on-failure">on-failure</option>
        </select>
      </label>
      {restart === "on-failure" ? (
        <label className="label">
          Maximum retries
          <input className="field" type="number" min="0" step="1" value={retries} onChange={(event) => setRetries(event.target.value)} />
        </label>
      ) : null}
      <p className="help">These settings apply in place. The container keeps its ID and is not restarted.</p>
      {error ? <p className="field-error">{error}</p> : null}
      <div className="dialog-actions">
        <button className="btn" type="button" disabled={pending} onClick={onClose}>Cancel</button>
        <button className="btn primary" type="button" disabled={pending} onClick={() => void submit()}>
          {pending ? "Saving…" : "Save settings"}
        </button>
      </div>
    </Dialog>
  );
}
