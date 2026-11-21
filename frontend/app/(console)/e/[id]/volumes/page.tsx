"use client";

import { useEffect, useState } from "react";
import { ApiError, api } from "../../../../../lib/api";
import { stamp } from "../../../../../lib/format";
import type { Volume } from "../../../../../lib/types";
import { Dialog, Empty, ErrorState, Loading } from "../../../../../components/bits";
import { DockerView, Pager, publishApiError, usePaged } from "../../../../../components/gate";
import { useConsole } from "../../../../../components/shell";

export default function VolumesPage() {
  const { setHeader } = useConsole();
  useEffect(() => { setHeader({ title: "Volumes" }); }, [setHeader]);
  return <DockerView noun="volumes">{(endpoint) => <Body id={endpoint.id} name={endpoint.name} />}</DockerView>;
}

function Body({ id, name }: { id: string; name: string }) {
  const [q, setQ] = useState("");
  const [applied, setApplied] = useState("");
  const [offset, setOffset] = useState(0);
  const [create, setCreate] = useState(false);
  const [volumeName, setVolumeName] = useState("");
  const [driver, setDriver] = useState("local");
  const [remove, setRemove] = useState<Volume | null>(null);
  const [alert, setAlert] = useState("");
  const [pending, setPending] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => { setApplied(q); setOffset(0); }, 200);
    return () => clearTimeout(timer);
  }, [q]);
  const query = usePaged<Volume>(`/api/endpoints/${id}/volumes?q=${encodeURIComponent(applied)}&limit=50${offset ? `&cursor=${offset}` : ""}`);

  async function createVolume() {
    setPending(true);
    setAlert("");
    try {
      await api(`/api/endpoints/${id}/volumes`, { method: "POST", body: { name: volumeName.trim(), driver: driver.trim() || "local" } });
      setCreate(false);
      await query.reload();
    } catch (err) {
      if (err instanceof ApiError) publishApiError(err.code);
      setAlert(err instanceof ApiError ? err.message : "Create failed.");
    } finally {
      setPending(false);
    }
  }

  async function removeVolume() {
    if (!remove) return;
    setPending(true);
    try {
      await api(`/api/endpoints/${id}/volumes/${encodeURIComponent(remove.name)}`, { method: "DELETE" });
      setRemove(null);
      await query.reload();
    } catch (err) {
      if (err instanceof ApiError) publishApiError(err.code);
      setAlert(`Remove failed. ${err instanceof ApiError ? err.message : "The engine did not answer."}`);
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <div className="toolbar">
        <label className="label">Search<input className="field" placeholder="name" value={q} onChange={(event) => setQ(event.target.value)} /></label>
        <button className="btn primary" type="button" onClick={() => { setVolumeName(""); setDriver("local"); setCreate(true); }}>Create volume</button>
      </div>
      {alert ? <div className="alert bad" role="alert">{alert}</div> : null}
      {query.status === "loading" && !query.data ? <Loading noun="volumes" /> : null}
      {query.status === "error" ? <ErrorState title={`Docker endpoint ${name} is not responding.`} message={query.message} attempts={query.attempts} at={query.at} onRetry={query.retry} /> : null}
      {query.status === "ready" && query.data?.items.length === 0 ? (
        applied
          ? <Empty title={`No volumes match “${applied}”.`} body="The filter is hiding every volume." action={{ label: "Clear search", onClick: () => setQ("") }} />
          : <Empty title={`No volumes on ${name}.`} body="Create one to give a container storage that outlives it." />
      ) : null}
      {query.data && query.data.items.length > 0 ? (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Driver</th><th>Mountpoint</th><th>Created</th><th className="actions">Actions</th></tr></thead>
            <tbody>
              {query.data.items.map((item) => (
                <tr key={item.name}>
                  <td className="name-cell" title={item.name}>{item.name}</td>
                  <td className="mono">{item.driver}</td>
                  <td className="mono name-cell" title={item.mountpoint}>{item.mountpoint}</td>
                  <td className="mono">{stamp(item.created)}</td>
                  <td className="actions"><button className="btn tiny danger" type="button" onClick={() => setRemove(item)}>Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pager total={query.data.total} offset={offset} noun="volumes" nextCursor={query.data.nextCursor} onPrev={() => setOffset(Math.max(0, offset - 50))} onNext={() => query.data?.nextCursor && setOffset(Number(query.data.nextCursor))} />
        </div>
      ) : null}
      {create ? (
        <Dialog title="Create volume" onClose={() => setCreate(false)}>
          <label className="label">Name<input className="field" value={volumeName} onChange={(event) => setVolumeName(event.target.value)} /></label>
          <label className="label">Driver<input className="field" value={driver} onChange={(event) => setDriver(event.target.value)} /></label>
          <div className="dialog-actions">
            <button className="btn" type="button" onClick={() => setCreate(false)}>Cancel</button>
            <button className="btn primary" type="button" disabled={pending || !volumeName.trim()} onClick={() => void createVolume()}>{pending ? "Creating…" : "Create"}</button>
          </div>
        </Dialog>
      ) : null}
      {remove ? (
        <Dialog title={`Remove volume ${remove.name}?`} onClose={() => setRemove(null)}>
          <p>Remove volume {remove.name}? Containers using it must be stopped first.</p>
          <div className="dialog-actions">
            <button className="btn" data-focus="first" type="button" onClick={() => setRemove(null)}>Cancel</button>
            <button className="btn danger" type="button" disabled={pending} onClick={() => void removeVolume()}>{pending ? "Removing…" : "Remove"}</button>
          </div>
        </Dialog>
      ) : null}
    </>
  );
}
