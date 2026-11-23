"use client";

import { useEffect, useState } from "react";
import { ApiError, api } from "../lib/api";
import type { EnvValue, LabelValue, MountEdit } from "../lib/types";
import { Dialog } from "./bits";

type ContainerConfig = {
  name: string;
  image: string;
  command: string[];
  entrypoint: string[];
  env: EnvValue[];
  labels: LabelValue[];
  ports: string[];
  restartPolicy: string;
  networks: string[];
  mounts: MountEdit[];
};

function lines(value: string): string[] {
  return value.split(/\r?\n/).filter((line) => line.length > 0);
}

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
  const [command, setCommand] = useState("");
  const [entrypoint, setEntrypoint] = useState("");
  const [ports, setPorts] = useState("");
  const [env, setEnv] = useState<EnvValue[]>([]);
  const [labels, setLabels] = useState<LabelValue[]>([]);
  const [mounts, setMounts] = useState<MountEdit[]>([]);
  const [revealed, setRevealed] = useState<Record<number, boolean>>({});
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
        setCommand(body.command.join("\n"));
        setEntrypoint(body.entrypoint.join("\n"));
        setPorts(body.ports.join("\n"));
        setEnv(body.env);
        setRevealed({});
        setLabels(body.labels);
        setMounts(body.mounts);
        setRestart(body.restartPolicy || "no");
      })
      .catch(() => setError("The container's live config could not be read."));
  }, [endpointId, containerId]);

  // Same name selects the recreate/replace path; a different name duplicates.
  const replace = Boolean(config) && name.trim().toLowerCase() === config?.name.toLowerCase();

  async function submit() {
    if (!config) return;
    const nextPorts = ports.split("\n").map((line) => line.trim()).filter(Boolean);
    const nextCommand = lines(command);
    const nextEntrypoint = lines(entrypoint);
    const body: Record<string, unknown> = { name: name.trim() };
    if (image.trim() !== config.image) body.image = image.trim();
    if (command !== config.command.join("\n")) body.command = nextCommand;
    if (entrypoint !== config.entrypoint.join("\n")) body.entrypoint = nextEntrypoint;
    if (JSON.stringify(nextPorts) !== JSON.stringify(config.ports)) body.ports = nextPorts;
    if (JSON.stringify(env) !== JSON.stringify(config.env)) body.env = env;
    if (JSON.stringify(labels) !== JSON.stringify(config.labels)) body.labels = labels;
    if (JSON.stringify(mounts) !== JSON.stringify(config.mounts)) body.mounts = mounts;
    if (restart !== config.restartPolicy) body.restart_policy = restart;

    setPending(true);
    setError("");
    try {
      const created = await api<{ id: string; name: string }>(
        `/api/endpoints/${endpointId}/containers/${encodeURIComponent(containerId)}/duplicate`,
        { method: "POST", timeoutMs: 120_000, body },
      );
      onCreated(created);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Container edit failed. Check its state before retrying.");
      setPending(false);
    }
  }

  function updateEnv(index: number, patch: Partial<EnvValue>) {
    setEnv((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row));
  }

  function updateLabel(index: number, patch: Partial<LabelValue>) {
    setLabels((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row));
  }

  function updateMount(index: number, patch: Partial<MountEdit>) {
    setMounts((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row));
  }

  return (
    <Dialog title="Duplicate / edit" onClose={onClose} className="container-edit-dialog">
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
            Entrypoint (one argument per line)
            <textarea className="field" rows={2} value={entrypoint} onChange={(event) => setEntrypoint(event.target.value)} />
          </label>
          <label className="label">
            Command (one argument per line)
            <textarea className="field" rows={3} value={command} onChange={(event) => setCommand(event.target.value)} />
          </label>
          <label className="label">
            Ports (host:container, expose:container, or auto:container; one per line)
            <textarea className="field" rows={3} value={ports} onChange={(event) => setPorts(event.target.value)} />
          </label>
          <div className="label">
            Environment (values hidden by default)
            <div className="edit-rows">
              {env.map((row, index) => (
                <div className="edit-row env-edit-row" key={index}>
                  <input className="field" aria-label={`Environment variable ${index + 1} name`} value={row.key} onChange={(event) => updateEnv(index, { key: event.target.value })} />
                  <input className="field" aria-label={`Environment variable ${index + 1} value`} type={revealed[index] ? "text" : "password"} value={row.value} onChange={(event) => updateEnv(index, { value: event.target.value })} />
                  <button className="btn" type="button" onClick={() => setRevealed((current) => ({ ...current, [index]: !current[index] }))}>{revealed[index] ? "Hide" : "Reveal"}</button>
                  <button className="btn" type="button" aria-label={`Remove environment variable ${index + 1}`} onClick={() => { setEnv((current) => current.filter((_, rowIndex) => rowIndex !== index)); setRevealed({}); }}>Remove</button>
                </div>
              ))}
              <button className="btn" type="button" onClick={() => setEnv((current) => [...current, { key: "", value: "" }])}>Add variable</button>
            </div>
          </div>
          <div className="label">
            Labels
            <div className="edit-rows">
              {labels.map((row, index) => (
                <div className="edit-row" key={index}>
                  <input className="field" aria-label={`Label ${index + 1} name`} value={row.key} onChange={(event) => updateLabel(index, { key: event.target.value })} />
                  <input className="field" aria-label={`Label ${index + 1} value`} value={row.value} onChange={(event) => updateLabel(index, { value: event.target.value })} />
                  <button className="btn" type="button" aria-label={`Remove label ${index + 1}`} onClick={() => setLabels((current) => current.filter((_, rowIndex) => rowIndex !== index))}>Remove</button>
                </div>
              ))}
              <button className="btn" type="button" onClick={() => setLabels((current) => [...current, { key: "", value: "" }])}>Add label</button>
            </div>
          </div>
          <div className="label">
            Mounts
            <div className="edit-rows">
              {mounts.map((mount, index) => (
                <div className="edit-row mount-edit-row" key={index}>
                  <select className="select" aria-label={`Mount ${index + 1} type`} value={mount.mountType} onChange={(event) => updateMount(index, { mountType: event.target.value })}>
                    <option value="bind">bind</option>
                    <option value="volume">volume</option>
                    <option value="tmpfs">tmpfs</option>
                  </select>
                  <input className="field" aria-label={`Mount ${index + 1} source`} disabled={mount.mountType === "tmpfs"} value={mount.source} onChange={(event) => updateMount(index, { source: event.target.value })} />
                  <input className="field" aria-label={`Mount ${index + 1} destination`} value={mount.destination} onChange={(event) => updateMount(index, { destination: event.target.value })} />
                  <label className="check-field">
                    <input type="checkbox" checked={mount.readOnly} onChange={(event) => updateMount(index, { readOnly: event.target.checked })} />
                    <span>Read-only</span>
                  </label>
                  <button className="btn" type="button" aria-label={`Remove mount ${index + 1}`} onClick={() => setMounts((current) => current.filter((_, rowIndex) => rowIndex !== index))}>Remove</button>
                </div>
              ))}
              <button className="btn" type="button" onClick={() => setMounts((current) => [...current, { source: "", destination: "", mountType: "volume", readOnly: false }])}>Add mount</button>
            </div>
          </div>
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
            Networks ({config.networks.join(", ") || "default bridge"}) and all untouched settings carry over.
          </p>
          {replace ? (
            <p className="field-error">
              This replaces {config.name}: the old container stops first, its writable layer is discarded,
              and the replacement gets a new ID. Attached volumes are reused.
            </p>
          ) : null}
          {error ? <p className="field-error">{error}</p> : null}
          <div className="dialog-actions">
            <button className="btn" type="button" onClick={onClose}>Cancel</button>
            <button className={replace ? "btn danger" : "btn primary"} type="button" disabled={pending} onClick={() => void submit()}>
              {pending ? (replace ? "Replacing…" : "Duplicating…") : replace ? "Replace" : "Duplicate"}
            </button>
          </div>
        </>
      )}
    </Dialog>
  );
}
