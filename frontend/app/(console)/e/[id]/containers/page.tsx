"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ApiError, api } from "../../../../../lib/api";
import { age, portList } from "../../../../../lib/format";
import type { Container } from "../../../../../lib/types";
import { Badge, Dialog, Empty, ErrorState, Loading } from "../../../../../components/bits";
import { DockerView, Pager, publishApiError, usePaged } from "../../../../../components/gate";
import { useConsole } from "../../../../../components/shell";

export default function ContainersPage() {
  const { setHeader } = useConsole();
  useEffect(() => { setHeader({ title: "Containers" }); }, [setHeader]);
  return <DockerView noun="containers">{(endpoint) => <Body id={endpoint.id} name={endpoint.name} />}</DockerView>;
}

function Body({ id, name }: { id: string; name: string }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [state, setState] = useState("all");
  const [appliedQ, setAppliedQ] = useState("");
  const [offset, setOffset] = useState(0);
  const [pending, setPending] = useState<{ id: string; action: string } | null>(null);
  const [alert, setAlert] = useState("");
  const [remove, setRemove] = useState<Container | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => { setAppliedQ(q); setOffset(0); }, 200);
    return () => clearTimeout(timer);
  }, [q]);
  const cursor = offset ? `&cursor=${offset}` : "";
  const query = usePaged<Container>(
    `/api/endpoints/${id}/containers?q=${encodeURIComponent(appliedQ)}&state=${encodeURIComponent(state)}${cursor}&limit=50`,
  );

  async function act(container: Container, action: "start" | "stop" | "restart" | "remove") {
    setPending({ id: container.id, action });
    setAlert("");
    try {
      await api(`/api/endpoints/${id}/containers/${encodeURIComponent(container.id)}${action === "remove" ? "" : `/${action}`}`, {
        method: action === "remove" ? "DELETE" : "POST",
      });
      setRemove(null);
      await query.reload();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "The engine did not answer.";
      if (err instanceof ApiError) publishApiError(err.code);
      const label = action[0].toUpperCase() + action.slice(1);
      setAlert(`${label} failed. ${message}`);
    } finally {
      setPending(null);
    }
  }

  const filtered = Boolean(appliedQ) || (state !== "all" && state !== "");
  return (
    <>
      <div className="toolbar">
        <label className="label">
          Search
          <input className="field" placeholder="name or image" value={q} onChange={(event) => setQ(event.target.value)} />
        </label>
        <label className="label">
          State
          <select className="select" value={state} onChange={(event) => { setState(event.target.value); setOffset(0); }}>
            {["all", "created", "running", "paused", "restarting", "exited", "dead"].map((item) => (
              <option key={item} value={item}>{item === "all" ? "All" : item}</option>
            ))}
          </select>
        </label>
      </div>
      {alert ? <div className="alert bad" role="alert">{alert}</div> : null}
      {query.status === "loading" && !query.data ? <Loading noun="containers" /> : null}
      {query.status === "error" ? (
        <ErrorState
          title={`Docker endpoint ${name} is not responding.`}
          message={query.message}
          attempts={query.attempts}
          at={query.at}
          onRetry={query.retry}
        />
      ) : null}
      {query.status === "ready" && query.data && query.data.items.length === 0 ? (
        filtered ? (
          <Empty title={`No containers match “${appliedQ || state}”.`} body="The filter is hiding every container." action={{ label: "Clear search", onClick: () => { setQ(""); setState("all"); } }} />
        ) : (
          <Empty
            title={`No containers on ${name}.`}
            body="The engine is up. Nothing is running or stopped. Start one from an image already on the machine."
            action={{ label: "Go to images", primary: true, onClick: () => router.push(`/e/${id}/images`) }}
          />
        )
      ) : null}
      {query.data && query.data.items.length > 0 ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Name</th><th>Image</th><th>State</th><th>Ports</th><th>Age</th><th className="actions">Actions</th></tr>
            </thead>
            <tbody>
              {query.data.items.map((item) => {
                const busy = pending?.id === item.id;
                const running = item.state === "running" || item.state === "restarting";
                return (
                  <tr key={item.id}>
                    <td className="name-cell" title={item.name}>
                      <Link href={`/e/${id}/containers/${encodeURIComponent(item.id)}`}>{item.name}</Link>
                    </td>
                    <td className="mono name-cell" title={item.image}>{item.image}</td>
                    <td><Badge state={item.state} /></td>
                    <td className="mono">{portList(item.ports)}</td>
                    <td className="mono">{age(item.created)}</td>
                    <td className="actions">
                      <div className="row-actions">
                        <button className="btn tiny" type="button" disabled={busy} onClick={() => void act(item, running ? "stop" : "start")}>
                          {busy && (pending?.action === "start" || pending?.action === "stop") ? `${running ? "Stopping" : "Starting"}…` : running ? "Stop" : "Start"}
                        </button>
                        <button className="btn tiny" type="button" disabled={busy} onClick={() => void act(item, "restart")}>
                          {busy && pending?.action === "restart" ? "Restarting…" : "Restart"}
                        </button>
                        <button className="btn tiny danger" type="button" disabled={busy} onClick={() => setRemove(item)}>Remove</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <Pager
            total={query.data.total}
            offset={offset}
            noun="containers"
            nextCursor={query.data.nextCursor}
            onPrev={() => setOffset(Math.max(0, offset - 50))}
            onNext={() => query.data?.nextCursor && setOffset(Number(query.data.nextCursor))}
          />
        </div>
      ) : null}
      {remove ? (
        <Dialog title={`Remove ${remove.name}?`} onClose={() => setRemove(null)}>
          <p>
            {remove.state === "running"
              ? `${remove.name} is running. Removing it stops it and deletes the writable layer.`
              : `${remove.name} is ${remove.state}. Removing it deletes the writable layer.`}
            {" "}Named volumes stay on {name}.
          </p>
          <div className="dialog-actions">
            <button className="btn" data-focus="first" type="button" onClick={() => setRemove(null)}>Cancel</button>
            <button className="btn danger" type="button" disabled={pending?.id === remove.id} onClick={() => void act(remove, "remove")}>
              {pending?.action === "remove" ? "Removing…" : "Remove"}
            </button>
          </div>
        </Dialog>
      ) : null}
    </>
  );
}
