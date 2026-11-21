"use client";

import { useEffect, useState } from "react";
import { ApiError, api } from "../../../../../lib/api";
import type { Network } from "../../../../../lib/types";
import { Dialog, Empty, ErrorState, Loading } from "../../../../../components/bits";
import { DockerView, Pager, publishApiError, usePaged } from "../../../../../components/gate";
import { useConsole } from "../../../../../components/shell";

export default function NetworksPage() {
  const { setHeader } = useConsole();
  useEffect(() => { setHeader({ title: "Networks" }); }, [setHeader]);
  return <DockerView noun="networks">{(endpoint) => <Body id={endpoint.id} name={endpoint.name} />}</DockerView>;
}

function Body({ id, name }: { id: string; name: string }) {
  const [q, setQ] = useState("");
  const [applied, setApplied] = useState("");
  const [offset, setOffset] = useState(0);
  const [create, setCreate] = useState(false);
  const [networkName, setNetworkName] = useState("");
  const [driver, setDriver] = useState("bridge");
  const [remove, setRemove] = useState<Network | null>(null);
  const [alert, setAlert] = useState("");
  const [pending, setPending] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => { setApplied(q); setOffset(0); }, 200);
    return () => clearTimeout(timer);
  }, [q]);
  const query = usePaged<Network>(`/api/endpoints/${id}/networks?q=${encodeURIComponent(applied)}&limit=50${offset ? `&cursor=${offset}` : ""}`);

  async function createNetwork() {
    setPending(true);
    setAlert("");
    try {
      await api(`/api/endpoints/${id}/networks`, { method: "POST", body: { name: networkName.trim(), driver: driver.trim() || "bridge" } });
      setCreate(false);
      await query.reload();
    } catch (err) {
      if (err instanceof ApiError) publishApiError(err.code);
      setAlert(err instanceof ApiError ? err.message : "Create failed.");
    } finally {
      setPending(false);
    }
  }

  async function removeNetwork() {
    if (!remove) return;
    setPending(true);
    try {
      await api(`/api/endpoints/${id}/networks/${encodeURIComponent(remove.name)}`, { method: "DELETE" });
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
        <button className="btn primary" type="button" onClick={() => { setNetworkName(""); setDriver("bridge"); setCreate(true); }}>Create network</button>
      </div>
      {alert ? <div className="alert bad" role="alert">{alert}</div> : null}
      {query.status === "loading" && !query.data ? <Loading noun="networks" /> : null}
      {query.status === "error" ? <ErrorState title={`Docker endpoint ${name} is not responding.`} message={query.message} attempts={query.attempts} at={query.at} onRetry={query.retry} /> : null}
      {query.status === "ready" && query.data?.items.length === 0 ? (
        applied
          ? <Empty title={`No networks match “${applied}”.`} body="The filter is hiding every network." action={{ label: "Clear search", onClick: () => setQ("") }} />
          : <Empty title="No networks reported." body="The engine returned an empty network list." />
      ) : null}
      {query.data && query.data.items.length > 0 ? (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Driver</th><th>Scope</th><th>Subnet</th><th>Containers</th><th className="actions">Actions</th></tr></thead>
            <tbody>
              {query.data.items.map((item) => (
                <tr key={item.name}>
                  <td>{item.name}</td>
                  <td className="mono">{item.driver}</td>
                  <td>{item.scope || "—"}</td>
                  <td className="mono">{item.subnet || "—"}</td>
                  <td className="mono">{item.containerCount}</td>
                  <td className="actions">
                    <button className="btn tiny danger" type="button" disabled={!item.removable} title={item.removable ? undefined : `${item.name} cannot be removed.`} onClick={() => setRemove(item)}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pager total={query.data.total} offset={offset} noun="networks" nextCursor={query.data.nextCursor} onPrev={() => setOffset(Math.max(0, offset - 50))} onNext={() => query.data?.nextCursor && setOffset(Number(query.data.nextCursor))} />
        </div>
      ) : null}
      {create ? (
        <Dialog title="Create network" onClose={() => setCreate(false)}>
          <label className="label">Name<input className="field" value={networkName} onChange={(event) => setNetworkName(event.target.value)} /></label>
          <label className="label">Driver<input className="field" value={driver} onChange={(event) => setDriver(event.target.value)} /></label>
          <div className="dialog-actions">
            <button className="btn" type="button" onClick={() => setCreate(false)}>Cancel</button>
            <button className="btn primary" type="button" disabled={pending || !networkName.trim()} onClick={() => void createNetwork()}>{pending ? "Creating…" : "Create"}</button>
          </div>
        </Dialog>
      ) : null}
      {remove ? (
        <Dialog title={`Remove network ${remove.name}?`} onClose={() => setRemove(null)}>
          <p>Remove network {remove.name}? Containers attached to it must be disconnected first.</p>
          <div className="dialog-actions">
            <button className="btn" data-focus="first" type="button" onClick={() => setRemove(null)}>Cancel</button>
            <button className="btn danger" type="button" disabled={pending} onClick={() => void removeNetwork()}>{pending ? "Removing…" : "Remove"}</button>
          </div>
        </Dialog>
      ) : null}
    </>
  );
}
