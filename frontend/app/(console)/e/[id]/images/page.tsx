"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ApiError, api } from "../../../../../lib/api";
import { age, bytes, imageLabel, shortId } from "../../../../../lib/format";
import type { ImageItem, Page } from "../../../../../lib/types";
import { listedNames, parsePort } from "../../../../../lib/ux";
import { Dialog, Empty, ErrorState, Icon, Loading, SelectionBar } from "../../../../../components/bits";
import { DockerView, Pager, publishApiError } from "../../../../../components/gate";
import { PageFrame, useConsole } from "../../../../../components/shell";

function extraTags(tags: string[]): string[] {
  const primary = imageLabel(tags);
  return tags.filter((tag) => tag && tag !== primary && tag !== "<none>:<none>");
}

export default function ImagesPage() {
  const { current, ready } = useConsole();
  const refreshRef = useRef<(() => void) | null>(null);
  // Only hand PageFrame a handler once DockerView renders Body; until then the
  // header Refresh would call nothing.
  const mounted = ready && current?.kind === "docker";
  return (
    <PageFrame
      title="Images"
      crumbs={[{ label: "Images" }]}
      onRefresh={mounted ? () => refreshRef.current?.() : undefined}
    >
      <DockerView noun="images">{(endpoint) => <Body refreshRef={refreshRef} id={endpoint.id} name={endpoint.name} />}</DockerView>
    </PageFrame>
  );
}

function Body({ id, name, refreshRef }: { id: string; name: string; refreshRef: { current: (() => void) | null } }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [applied, setApplied] = useState("");
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<Page<ImageItem> | null>(null);
  const [status, setStatus] = useState<"loading" | "error" | "ready">("loading");
  const [message, setMessage] = useState("");
  const [attempts, setAttempts] = useState(0);
  const [at, setAt] = useState<Date | undefined>();
  const [picked, setPicked] = useState<Record<string, ImageItem>>({});
  const [run, setRun] = useState<ImageItem | null>(null);
  const [remove, setRemove] = useState<ImageItem[] | null>(null);
  const [containerName, setContainerName] = useState("");
  const [port, setPort] = useState("");
  const [portError, setPortError] = useState("");
  const [alert, setAlert] = useState("");
  const [pending, setPending] = useState("");
  const loadGen = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => { setApplied(q.trim()); setOffset(0); }, 200);
    return () => clearTimeout(timer);
  }, [q]);
  useEffect(() => { setPicked({}); }, [applied, offset]);

  async function load(retry: boolean) {
    const gen = ++loadGen.current;
    if (retry) setAttempts((value) => value + 1);
    setStatus("loading");
    try {
      let next: Page<ImageItem>;
      if (!applied) {
        next = await api<Page<ImageItem>>(`/api/endpoints/${id}/images?limit=50${offset ? `&cursor=${offset}` : ""}`);
      } else {
        const matched: ImageItem[] = [];
        let cursor: string | null | undefined;
        let guard = 0;
        const needle = applied.toLowerCase();
        do {
          if (gen !== loadGen.current) return;
          const body = await api<Page<ImageItem>>(`/api/endpoints/${id}/images?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
          for (const item of body.items) {
            const hay = `${item.tags.join(" ")} ${item.id}`.toLowerCase();
            if (hay.includes(needle)) matched.push(item);
          }
          cursor = body.nextCursor;
          guard += 1;
          // shortcut: stops after 2000 images, raise the cap if a host has more
        } while (cursor && guard < 40);
        next = {
          items: matched.slice(offset, offset + 50),
          total: matched.length,
          nextCursor: offset + 50 < matched.length ? String(offset + 50) : null,
        };
      }
      if (gen !== loadGen.current) return;
      setPage(next);
      setStatus("ready");
    } catch (err) {
      if (gen !== loadGen.current) return;
      if (err instanceof ApiError && err.code === "cancelled") return;
      if (err instanceof ApiError) publishApiError(err.code);
      setMessage(err instanceof ApiError ? err.message : "The engine did not answer within 10 seconds. Nothing on this page was changed.");
      setAt(new Date());
      setStatus("error");
    }
  }

  useEffect(() => {
    setAttempts(0);
    void load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, applied, offset]);
  refreshRef.current = () => { void load(false); };

  const items = page?.items ?? [];
  const selected = items.filter((item) => picked[item.id]);
  const allChecked = items.length > 0 && selected.length === items.length;

  function toggle(item: ImageItem) {
    setPicked((prev) => {
      const next = { ...prev };
      if (next[item.id]) delete next[item.id];
      else next[item.id] = item;
      return next;
    });
  }

  async function start() {
    if (!run) return;
    const parsed = parsePort(port);
    if (parsed === null) {
      setPortError("Use host:container, a single port, or leave this empty.");
      return;
    }
    setPending("run");
    setAlert("");
    try {
      const created = await api<{ id: string }>(`/api/endpoints/${id}/containers`, {
        method: "POST",
        body: {
          image: imageLabel(run.tags) === "<none>:<none>" ? run.id : imageLabel(run.tags),
          name: containerName.trim() || undefined,
          ports: parsed === "empty" ? [] : [parsed],
        },
      });
      router.push(`/e/${id}/containers/${encodeURIComponent(created.id)}`);
    } catch (err) {
      if (err instanceof ApiError) publishApiError(err.code);
      setAlert(`Run failed. ${err instanceof ApiError ? err.message : "The engine did not answer."}`);
      setPending("");
    }
  }

  async function removeImages() {
    if (!remove) return;
    setPending("remove");
    setAlert("");
    try {
      for (const item of remove) {
        await api(`/api/endpoints/${id}/images/${encodeURIComponent(item.id)}`, { method: "DELETE" });
      }
      setRemove(null);
      setPicked({});
      await load(false);
    } catch (err) {
      if (err instanceof ApiError) publishApiError(err.code);
      setAlert(`Remove failed. ${err instanceof ApiError ? err.message : "The engine did not answer."}`);
    } finally {
      setPending("");
    }
  }

  return (
    <>
      {alert ? <div className="alert bad" role="alert">{alert}</div> : null}
      <section className="widget">
        <div className="widget-head">
          <input className="field search" placeholder="tag or id" value={q} onChange={(event) => setQ(event.target.value)} />
          <div className="grow" />
          <SelectionBar count={selected.length} onClear={() => setPicked({})}>
            <button className="btn danger" type="button" disabled={Boolean(pending) || selected.length === 0} onClick={() => setRemove(selected)}>
              <Icon name="trash" /> Remove
            </button>
          </SelectionBar>
        </div>
        {status === "loading" && !page ? <Loading noun="images" /> : null}
        {status === "error" ? (
          <ErrorState title={`Docker endpoint ${name} is not responding.`} message={message} attempts={attempts} at={at} onRetry={() => void load(true)} />
        ) : null}
        {status === "ready" && page?.items.length === 0 ? (
          applied ? (
            <Empty title={`No images match “${applied}”.`} body="The filter is hiding every image on this engine." action={{ label: "Clear search", onClick: () => setQ("") }} />
          ) : (
            <Empty title={`No images on ${name}.`} body="Images show up when the engine already has them. This version does not pull or build." action={{ label: "Refresh", primary: true, onClick: () => void load(true) }} />
          )
        ) : null}
        {page && page.items.length > 0 ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="col-check"><label className="check"><input type="checkbox" aria-label="Select all" checked={allChecked} onChange={() => setPicked(allChecked ? {} : Object.fromEntries(items.map((item) => [item.id, item])))} /></label></th>
                  <th>Tag</th>
                  <th>ID</th>
                  <th>Size</th>
                  <th>Age</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td className="col-check">
                      <label className="check">
                        <input type="checkbox" aria-label={`Select ${imageLabel(item.tags)}`} checked={Boolean(picked[item.id])} onChange={() => toggle(item)} />
                      </label>
                    </td>
                    <td className="mono name-cell cell-name" title={item.tags.join(", ") || item.id}>
                      {imageLabel(item.tags)}
                      {extraTags(item.tags).length ? <span className="tag-more">{extraTags(item.tags).join(", ")}</span> : null}
                    </td>
                    <td className="mono cell-secondary" title={item.id}>{shortId(item.id)}</td>
                    <td className="mono cell-meta">{bytes(item.sizeBytes)}</td>
                    <td className="mono cell-meta">{age(item.created)}</td>
                    <td className="cell-action">
                      <button className="btn" type="button" onClick={() => { setRun(item); setContainerName(""); setPort(""); setPortError(""); }}>
                        <Icon name="play" /> Run
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pager total={page.total} offset={offset} noun="images" nextCursor={page.nextCursor} onPrev={() => setOffset(Math.max(0, offset - 50))} onNext={() => page.nextCursor && setOffset(Number(page.nextCursor))} />
          </div>
        ) : null}
      </section>
      {run ? (
        <Dialog title="Run container" onClose={() => setRun(null)}>
          <form onSubmit={(event) => { event.preventDefault(); void start(); }}>
            <label className="label">Image<input className="field" readOnly value={imageLabel(run.tags)} /></label>
            <label className="label">Name<input className="field" data-focus="first" value={containerName} onChange={(event) => setContainerName(event.target.value)} /></label>
            <label className="label">
              Port
              <input className="field" placeholder="8080:80" value={port} onBlur={() => setPortError(parsePort(port) === null ? "Use host:container, a single port, or leave this empty." : "")} onChange={(event) => setPort(event.target.value)} />
              {portError ? <span className="field-error">{portError}</span> : null}
            </label>
            <div className="dialog-actions">
              <button className="btn" type="button" onClick={() => setRun(null)}>Cancel</button>
              <button className="btn primary" type="submit" disabled={pending === "run"}>{pending === "run" ? "Running…" : "Run"}</button>
            </div>
          </form>
        </Dialog>
      ) : null}
      {remove ? (
        <Dialog title={remove.length === 1 ? `Remove ${imageLabel(remove[0].tags)}?` : `Remove ${remove.length} images?`} onClose={() => setRemove(null)}>
          <p>{remove.length === 1 ? `Remove image ${imageLabel(remove[0].tags)}? This deletes it from the local engine.` : `Remove ${listedNames(remove.map((item) => imageLabel(item.tags)))}? This deletes them from the local engine.`}</p>
          <div className="dialog-actions">
            <button className="btn" data-focus="first" type="button" onClick={() => setRemove(null)}>Cancel</button>
            <button className="btn danger" type="button" disabled={pending === "remove"} onClick={() => void removeImages()}>{pending === "remove" ? "Removing…" : "Remove"}</button>
          </div>
        </Dialog>
      ) : null}
    </>
  );
}
