"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ApiError, api } from "../../../../../lib/api";
import type { Stack, StackContainer } from "../../../../../lib/types";
import { Badge, Dialog, Empty, ErrorState, Icon, Loading, SelectionBar } from "../../../../../components/bits";
import { ImagePullConfirmDialog } from "../../../../../components/image-pull-confirm-dialog";
import { DockerView, Pager, publishApiError, usePaged } from "../../../../../components/gate";
import { PageFrame, useConsole } from "../../../../../components/shell";
import { listedNames } from "../../../../../lib/ux";

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
  const [remove, setRemove] = useState<Stack[] | null>(null);
  const [restart, setRestart] = useState<Stack[] | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => { setAppliedQ(q); setOffset(0); }, 200);
    return () => clearTimeout(timer);
  }, [q]);
  useEffect(() => { setPicked({}); }, [appliedQ, offset]);
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

  function usesCompose(stack: Stack) {
    return stack.origin === "managed" && stack.hasFile;
  }

  async function act(action: "start" | "stop" | "restart", targets = selected, repull = false) {
    setPending(action);
    setAlert("");
    try {
      for (const stack of targets) {
        if (action === "restart" && usesCompose(stack)) {
          await api(`/api/endpoints/${id}/stacks/${encodeURIComponent(stack.project)}/restart`, {
            method: "POST",
            body: { repull },
            timeoutMs: 310_000,
          });
          continue;
        }
        const containers = stack.containers.filter((container) =>
          action === "restart" ? true : action === "start" ? !up(container) : up(container),
        );
        for (const container of containers) {
          await api(`/api/endpoints/${id}/containers/${encodeURIComponent(container.id)}/${action}`, { method: "POST" });
        }
      }
      setPicked({});
      setRestart(null);
      await query.reload();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "The engine did not answer.";
      if (err instanceof ApiError) publishApiError(err.code);
      const label = action[0].toUpperCase() + action.slice(1);
      setAlert(`${label} failed. ${message}`);
      await query.reload();
    } finally {
      setPending("");
    }
  }

  async function removeStacks() {
    if (!remove) return;
    setPending("remove");
    setAlert("");
    try {
      for (const stack of remove) {
        await api(`/api/endpoints/${id}/stacks/${encodeURIComponent(stack.project)}`, { method: "DELETE", timeoutMs: 310_000 });
      }
      setRemove(null);
      setPicked({});
      await query.reload();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "The engine did not answer.";
      if (err instanceof ApiError) publishApiError(err.code);
      setAlert(`Delete failed. ${message}`);
      await query.reload();
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
          <input className="field search" placeholder="project name" value={q} onChange={(event) => setQ(event.target.value)} />
          <div className="grow" />
          <SelectionBar count={selected.length} onClear={() => setPicked({})}>
            <button className="btn" type="button" disabled={disabled || !canStart} onClick={() => void act("start")}>
              <Icon name="play" /> {label("start", "Starting…", "Start")}
            </button>
            <button className="btn" type="button" disabled={disabled || !canStop} onClick={() => void act("stop")}>
              <Icon name="stop" /> {label("stop", "Stopping…", "Stop")}
            </button>
            <button className="btn" type="button" disabled={disabled || selected.length === 0} onClick={() => setRestart(selected)}>
              <Icon name="restart" /> {label("restart", "Restarting…", "Restart")}
            </button>
            <button className="btn danger" type="button" disabled={disabled || selected.length === 0} onClick={() => setRemove(selected)}>
              <Icon name="trash" /> Delete
            </button>
          </SelectionBar>
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
                    <td className="name-cell cell-name" title={stack.project} translate="no">
                      <Link className="name-link" href={`/e/${id}/stacks/${encodeURIComponent(stack.project)}?tab=stack`} translate="no">{stack.project}</Link>
                    </td>
                    <td className="cell-secondary"><span className="origin-badge">{stack.origin === "managed" ? "Managed" : "Discovered"}</span></td>
                    <td className="cell-status"><Badge state={stack.state} /></td>
                    <td className="stack-containers cell-meta">
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
      {remove ? (
        <Dialog title={remove.length === 1 ? `Delete stack ${remove[0].project}?` : `Delete ${remove.length} stacks?`} onClose={() => setRemove(null)}>
          <p>Selected: {listedNames(remove.map((stack) => stack.project))}.</p>
          {remove.some((stack) => stack.origin === "managed") ? (
            <p>Managed ({listedNames(remove.filter((stack) => stack.origin === "managed").map((stack) => stack.project))}): containers are removed and the Compose file Pisces stored is deleted. Named volumes stay.</p>
          ) : null}
          {remove.some((stack) => stack.origin !== "managed") ? (
            <p>Discovered ({listedNames(remove.filter((stack) => stack.origin !== "managed").map((stack) => stack.project))}): containers are stopped and removed. Pisces did not store a Compose file for these. Named volumes stay.</p>
          ) : null}
          <div className="dialog-actions">
            <button className="btn" data-focus="first" type="button" onClick={() => setRemove(null)}>Cancel</button>
            <button className="btn danger" type="button" disabled={pending === "remove"} onClick={() => void removeStacks()}>
              {pending === "remove" ? "Deleting…" : "Delete"}
            </button>
          </div>
        </Dialog>
      ) : null}
      {restart && restart.some(usesCompose) ? (
        <ImagePullConfirmDialog
          title={restart.length === 1 ? `Restart stack ${restart[0].project}?` : `Restart ${restart.length} stacks?`}
          intro={`Managed stacks restart through Compose. ${restart.some((stack) => !usesCompose(stack)) ? "Discovered stacks in this selection restart their containers on the engine and do not pull images." : "Choose whether to pull images from the registry first."}`}
          confirmLabel="Restart"
          pending={pending === "restart"}
          onClose={() => setRestart(null)}
          onConfirm={(repull) => void act("restart", restart, repull)}
        />
      ) : null}
      {restart && !restart.some(usesCompose) ? (
        <Dialog title={restart.length === 1 ? `Restart stack ${restart[0].project}?` : `Restart ${restart.length} stacks?`} onClose={() => setRestart(null)}>
          <p>Restart {listedNames(restart.map((stack) => stack.project))} by restarting the containers already on {name}. This does not pull images.</p>
          <div className="dialog-actions">
            <button className="btn" data-focus="first" type="button" onClick={() => setRestart(null)}>Cancel</button>
            <button className="btn primary" type="button" disabled={pending === "restart"} onClick={() => void act("restart", restart, false)}>
              {pending === "restart" ? "Restarting…" : "Restart"}
            </button>
          </div>
        </Dialog>
      ) : null}
    </>
  );
}
