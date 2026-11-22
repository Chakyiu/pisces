"use client";

import { useEffect, useState } from "react";
import { ApiError, api } from "../lib/api";
import { Dialog } from "./bits";

// The engine's live config for one container, as served by
// GET /api/endpoints/{id}/containers/{cid}/config.
type ContainerConfig = {
  name: string;
  image: string;
  env: string[];
  ports: string[];
  restartPolicy: string;
  networks: string[];
  mounts: string[];
};

export function ContainerDuplicateDialog({
  endpointId,
  containerId,
  onClose,
  onCreated,
}: {
  endpointId: string;
  containerId: string;
  onClose: () => void;
  onCreated: (created: { id: string; name: string }) => void;
}) {
  const [config, setConfig] = useState<ContainerConfig | null>(null);
  const [name, setName] = useState("");
  const [image, setImage] = useState("");
  const [ports, setPorts] = useState("");
  const [env, setEnv] = useState("");
  const [restart, setRestart] = useState("no");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    api<ContainerConfig>(
      `/api/endpoints/${endpointId}/containers/${encodeURIComponent(containerId)}/config`,
    )
      .then((body) => {
        setConfig(body);
        setName(body.name);
        setImage(body.image);
        setPorts(body.ports.join("\n"));
        setEnv(body.env.join("\n"));
        setRestart(body.restartPolicy || "no");
      })
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : "The container config could not be read.");
      });
  }, [endpointId, containerId]);

  // Keeping the original name is the replace path: docker's name uniqueness is
  // case-insensitive, and the backend routes the same call accordingly.
  const replace = Boolean(config) && name.trim().toLowerCase() === config?.name.toLowerCase();

  function submit() {
    if (!config) return;
    setPending(true);
    setError("");
    api<{ id: string; name: string }>(
      `/api/endpoints/${endpointId}/containers/${encodeURIComponent(containerId)}/duplicate`,
      {
        method: "POST",
        timeoutMs: 120_000,
        body: {
          name: name.trim(),
          image: image.trim(),
          ports: ports.split("\n").map((line) => line.trim()).filter(Boolean),
          env: env.split("\n").map((line) => line.trim()).filter(Boolean),
          restart_policy: restart,
        },
      },
    )
      .then(onCreated)
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : "The engine did not answer.");
        setPending(false);
      });
  }

  return (
    <Dialog title="Duplicate / edit" onClose={onClose}>
      {!config ? (
        <>
          <p>{error || "Reading the container's live config from the engine…"}</p>
          <div className="dialog-actions">
            <button className="btn" data-focus="first" type="button" onClick={onClose}>Close</button>
          </div>
        </>
      ) : (
        <>
          <label className="label">
            Name
            <input className="field" data-focus="first" value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label className="label">
            Image
            <input className="field" value={image} onChange={(event) => setImage(event.target.value)} />
          </label>
          <label className="label">
            Ports (host:container, one per line)
            <textarea className="field" rows={3} value={ports} onChange={(event) => setPorts(event.target.value)} />
          </label>
          <label className="label">
            Environment (KEY=VALUE, one per line)
            <textarea className="field" rows={5} value={env} onChange={(event) => setEnv(event.target.value)} />
          </label>
          <label className="label">
            Restart
            <select className="select" value={restart} onChange={(event) => setRestart(event.target.value)}>
              <option value="no">no</option>
              <option value="always">always</option>
              <option value="unless-stopped">unless-stopped</option>
              <option value="on-failure">on-failure</option>
            </select>
          </label>
          <p className="help">
            Mounts ({config.mounts.length ? config.mounts.join(", ") : "none"}), networks (
            {config.networks.join(", ") || "default bridge"}), command and other settings carry over unchanged.
          </p>
          {replace ? (
            <p className="field-error">
              The name matches the original: this replaces {config.name}. It is stopped, its writable
              layer is discarded, and it gets a new container id.
            </p>
          ) : null}
          {error ? <p className="field-error">{error}</p> : null}
          <div className="dialog-actions">
            <button className="btn" type="button" onClick={onClose}>Cancel</button>
            <button
              className={replace ? "btn danger" : "btn primary"}
              type="button"
              disabled={pending}
              onClick={submit}
            >
              {pending ? (replace ? "Replacing…" : "Duplicating…") : replace ? "Replace" : "Duplicate"}
            </button>
          </div>
        </>
      )}
    </Dialog>
  );
}
