"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ApiError, api } from "../../../../../lib/api";
import type { Stack, StackContainer } from "../../../../../lib/types";
import { Badge, Empty, ErrorState, Icon, Loading } from "../../../../../components/bits";
import { DockerView, Pager, publishApiError, usePaged } from "../../../../../components/gate";
import { PageFrame, useConsole } from "../../../../../components/shell";

function up(container: StackContainer) {
  return container.state === "running" || container.state === "restarting";
}

export default function StacksPage() {
  const { current } = useConsole();
  const refreshRef = useRef<() => void>(() => {});
  return (
    <PageFrame
      title="Stacks"
      crumbs={[{ label: "Stacks" }]}
      actions={current ? <Link className="btn primary" href={`/e/${current.id}/stacks/new`}><Icon name="plus" />Add stack</Link> : null}
      onRefresh={() => refreshRef.current()}
    >
      <DockerView noun="stacks">{(endpoint) => <Body refreshRef={refreshRef} id={endpoint.id} name={endpoint.name} />}</DockerView>
    </PageFrame>
  );
}

function Body({ id, name, refreshRef }: { id: string; name: string; refreshRef: { current: () => void } }) {
  const [q, setQ] = useState("");
  const [appliedQ, setAppliedQ] = useState("");
  const [offset, setOffset] = useState(0);
  const [picked, setPicked] = useState<Record<string, Stack>>({});
  const [pending, setPending] = useState("");
  const [alert, setAlert] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => { setAppliedQ(q); setOffset(0); }, 200);
    return () => clearTimeout(timer);
  }, [q]);
  const cursor = offset ? `&cursor=${offset}` : "";
  const query = usePaged<Stack>(`/api/endpoints/${id}/stacks?q=${encodeURIComponent(appliedQ)}${cursor}&limit=50`);
  refreshRef.current = () => { void query.reload(); };

  const items = query.data?.items ?? [];
  const selected = items.filter((item) => picked[item.project]);
  const allChecked = items.length > 0 && selected.length === items.length;
  const canStart = selected.some((stack) => stack.containers.some((container) => !up(container)));
  const canStop = selected.some((stack) => stack.containers.some(up));

  function toggle(stack: Stack) {
    setPicked((prev) => {
      const next = { ...prev };
      if (next[stack.project]) delete next[stack.project];
      else next[stack.project] = stack;
      return next;
    });
  }

  function toggleAll() {
    setPicked((prev) => {
      const next = { ...prev };
      if (allChecked) items.forEach((stack) => delete next[stack.project]);
      else items.forEach((stack) => { next[stack.project] = stack; });
      return next;
    });
  }

  async function act(action: "start" | "stop" | "restart") {
    setPending(action);
    setAlert("");
    try {
      for (const stack of selected) {
        const targets = stack.containers.filter((container) =>
          action === "restart" ? true : action === "start" ? !up(container) : up(container),
        );
        for (const container of targets) {
          await api(`/api/endpoints/${id}/containers/${encodeURIComponent(container.id)}/${action}`, { method: "POST" });
        }
      }
      setPicked({});
      await query.reload();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "The engine did not answer.";
      if (err instanceof ApiError) publishApiError(err.code);
      const label = action[0].toUpperCase() + action.slice(1);
      setAlert(`${label} failed. ${message}`);
    } finally {
      setPending("");
    }
  }

  const label = (action: string, busy: string, idle: string) => (pending === action ? busy : idle);
  const disabled = Boolean(pending);

  return (
    <>
      {alert ? <div className="alert bad" role="alert">{alert}</div> : null}
      <section className="widget">
        <div className="widget-head">
          <div className="widget-title"><Icon name="stacks" /> Stacks</div>
          <input className="field search" placeholder="project name" value={q} onChange={(event) => setQ(event.target.value)} />
          <div className="grow" />
          <div className="bulk">
            <button className="btn" type="button" disabled={disabled || !canStart} onClick={() => void act("start")}>
              <Icon name="play" /> {label("start", "Starting…", "Start")}
            </button>
            <button className="btn" type="button" disabled={disabled || !canStop} onClick={() => void act("stop")}>
              <Icon name="stop" /> {label("stop", "Stopping…", "Stop")}
            </button>
            <button className="btn" type="button" disabled={disabled || selected.length === 0} onClick={() => void act("restart")}>
              <Icon name="restart" /> {label("restart", "Restarting…", "Restart")}
            </button>
          </div>
        </div>
        {query.status === "loading" && !query.data ? <Loading noun="stacks" /> : null}
        {query.status === "error" ? (
          <ErrorState title={`Docker endpoint ${name} is not responding.`} message={query.message} attempts={query.attempts} at={query.at} onRetry={query.retry} />
        ) : null}
        {query.status === "ready" && query.data && query.data.items.length === 0 ? (
          appliedQ ? (
            <Empty title={`No stacks match “${appliedQ}”.`} body="The filter is hiding every stack." action={{ label: "Clear search", onClick: () => setQ("") }} />
          ) : (
            <Empty
              title={`No stacks on ${name}.`}
              body="Deploy a Compose file from here, or start a project on the engine. Either one shows up in this list."
              action={{ label: "Add stack", href: `/e/${id}/stacks/new`, primary: true }}
            />
          )
        ) : null}
        {query.data && query.data.items.length > 0 ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="col-check"><label className="check"><input type="checkbox" aria-label="Select all" checked={allChecked} onChange={toggleAll} /></label></th>
                  <th>Name</th>
                  <th>Origin</th>
                  <th>State</th>
                  <th>Containers</th>
                </tr>
              </thead>
              <tbody>
                {items.map((stack) => (
                  <tr key={stack.project}>
                    <td className="col-check">
                      <label className="check">
                        <input type="checkbox" aria-label={`Select ${stack.project}`} checked={Boolean(picked[stack.project])} onChange={() => toggle(stack)} />
                      </label>
                    </td>
                    <td className="name-cell" title={stack.project} translate="no">
                      <Link className="name-link" href={`/e/${id}/stacks/${encodeURIComponent(stack.project)}?tab=stack`} translate="no">{stack.project}</Link>
                    </td>
                    <td><span className="origin-badge">{stack.origin === "managed" ? "Managed" : "Discovered"}</span></td>
                    <td><Badge state={stack.state} /></td>
                    <td className="stack-containers">
                      <span className="mono">{stack.running}/{stack.total}</span>
                      {stack.containers.map((container) => (
                        <Link key={container.id} className="name-link mono" href={`/e/${id}/containers/${encodeURIComponent(container.id)}`}>
                          {container.name}
                        </Link>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pager
              total={query.data.total}
              offset={offset}
              noun={query.data.total === 1 ? "stack" : "stacks"}
              nextCursor={query.data.nextCursor}
              onPrev={() => setOffset(Math.max(0, offset - 50))}
              onNext={() => query.data?.nextCursor && setOffset(Number(query.data.nextCursor))}
            />
          </div>
        ) : null}
      </section>
    </>
  );
}
