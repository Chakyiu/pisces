"use client";

import { useEffect, useState } from "react";
import { ApiError, api } from "../../../../lib/api";
import { atTime, clock, left } from "../../../../lib/format";
import { unifiedDiff, type DiffLine } from "../../../../lib/diff";
import { effectiveFields } from "../../../../lib/proposal-view";
import type { Proposal, StackDetail } from "../../../../lib/types";
import { Dialog, Empty, ErrorState, Icon, Loading } from "../../../../components/bits";
import { AiAccessTabs } from "../../../../components/ai-access-tabs";
import { PageFrame, useConsole } from "../../../../components/shell";

const STACK_ACTIONS = new Set(["stack-create", "stack-update"]);
const FILTERS = [
  { value: "pending", label: "Pending" },
  { value: "all", label: "All" },
  { value: "expired", label: "Expired" },
  { value: "decided", label: "Decided" },
] as const;

export default function ProposalsPage() {
  return (
    <PageFrame
      title="AI access"
      crumbs={[{ label: "AI access", href: "/ai-access" }, { label: "Proposals" }]}
    >
      <ProposalScreen />
    </PageFrame>
  );
}

function ProposalScreen() {
  const { endpoints, username } = useConsole();
  const [items, setItems] = useState<Proposal[] | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState("");
  const [attempts, setAttempts] = useState(0);
  const [at, setAt] = useState<Date | undefined>();
  const [filter, setFilter] = useState<string>("pending");
  const [review, setReview] = useState<Proposal | null>(null);
  const [alert, setAlert] = useState("");

  async function load(retry: boolean) {
    if (retry) setAttempts((n) => n + 1);
    setStatus("loading");
    try {
      const body = await api<{ items: Proposal[] }>("/api/proposals");
      setItems(body.items);
      setStatus("ready");
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : "The API did not answer within 10 seconds. Nothing on this page was changed.");
      setAt(new Date());
      setStatus("error");
    }
  }

  useEffect(() => { void load(false); }, []);

  const all = items ?? [];
  const pending = all.filter((item) => item.status === "pending").length;
  const visible = all.filter((item) => {
    if (filter === "all") return true;
    if (filter === "pending") return item.status === "pending";
    if (filter === "expired") return item.status === "expired";
    return item.status !== "pending" && item.status !== "expired";
  });

  function environmentName(id: string): string {
    return endpoints.find((endpoint) => endpoint.id === id)?.name ?? id;
  }

  return (
    <div className="stack">
      <AiAccessTabs pending={pending} />
      {alert ? <div className="alert bad" role="alert">{alert}</div> : null}
      <section className="widget">
        <div className="widget-head">
          <div className="widget-title"><Icon name="containers" /> Pending proposals</div>
          <div className="grow" />
          <select
            className="select"
            aria-label="Proposal status"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            style={{ width: 140 }}
          >
            {FILTERS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </div>
        <p className="ai-help" style={{ padding: "0 16px 12px" }}>
          Confirm and reject run as {username || "the operator"} in this browser.
        </p>
        {status === "loading" && !items ? <Loading noun="proposals" /> : null}
        {status === "error" ? (
          <ErrorState title="The proposal queue could not be read." message={message} attempts={attempts} at={at} onRetry={() => void load(true)} />
        ) : null}
        {status === "ready" && visible.length === 0 ? (
          filter === "pending" && all.length > 0 ? (
            <Empty
              title="Nothing is waiting for you."
              body="Every proposal has been decided or has expired."
              action={{ label: "Show all proposals", onClick: () => setFilter("all") }}
            />
          ) : filter === "all" ? (
            <Empty
              title="No proposals yet."
              body="An agent with Operate access on a container proposes changes here, and nothing runs until you confirm it."
              action={{ label: "See containers", href: endpoints[0] ? `/e/${endpoints[0].id}/containers` : "/home" }}
            />
          ) : (
            <Empty
              title={`No ${filter} proposals.`}
              body="The filter is hiding every row."
              action={{ label: "Show all proposals", onClick: () => setFilter("all") }}
            />
          )
        ) : null}
        {visible.length > 0 ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Target</th>
                  <th>Action</th>
                  <th>Requested</th>
                  <th>Expires</th>
                  <th>Status</th>
                  <th aria-label="Decision" />
                </tr>
              </thead>
              <tbody>
                {visible.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <strong>{target(item)}</strong>
                      <span className="cell-2">
                        {item.project ? `${environmentName(item.endpointId)} · ${item.project}` : environmentName(item.endpointId)}
                      </span>
                    </td>
                    <td className="mono">{actionLabel(item.action)}</td>
                    <td className="mono" title={atTime(item.createdAt)}>{atTime(item.createdAt)}</td>
                    <td className="mono">{item.status === "pending" ? left(item.expiresAt) : "—"}</td>
                    <td><StatusCell item={item} /></td>
                    <td>
                      <button className="btn" type="button" onClick={() => setReview(item)}>
                        {item.status === "pending" ? "Review" : "View"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
      {review ? (
        <ReviewDialog
          proposal={review}
          onClose={() => setReview(null)}
          onDecided={async (error) => {
            setReview(null);
            setAlert(error);
            await load(false);
          }}
        />
      ) : null}
    </div>
  );
}

function target(item: Proposal): string {
  if (item.containerName) return item.containerName;
  if (item.project) return item.project;
  return item.containerId ?? "—";
}

function actionLabel(action: string): string {
  switch (action) {
    case "start": return "Start";
    case "stop": return "Stop";
    case "restart": return "Restart";
    case "run": return "Create container";
    case "settings": return "Edit settings";
    case "duplicate": return "Duplicate";
    case "recreate": return "Recreate";
    case "stack-create": return "Compose up";
    case "stack-update": return "Compose up";
    default: return action;
  }
}

function StatusCell({ item }: { item: Proposal }) {
  if (item.status === "pending") return <span className="badge warn"><i className="sq warn" />Pending</span>;
  if (item.status === "expired") {
    return (
      <span className="badge muted" title={atTime(item.expiresAt)}>
        <i className="sq" />Expired {item.decidedAt ? clock(new Date(item.decidedAt * 1000)) : ""}
      </span>
    );
  }
  return (
    <span className={`badge ${item.status === "rejected" || item.status === "failed" ? "bad" : "ok"}`} title={item.message ?? undefined}>
      <i className={`sq ${item.status === "rejected" || item.status === "failed" ? "bad" : "ok"}`} />
      {item.status}{item.decidedBy ? ` · ${item.decidedBy}` : ""}
    </span>
  );
}

function ReviewDialog({
  proposal,
  onClose,
  onDecided,
}: {
  proposal: Proposal;
  onClose: () => void;
  onDecided: (error: string) => Promise<void>;
}) {
  const { endpoints, username } = useConsole();
  const [busy, setBusy] = useState("");
  const [diff, setDiff] = useState<DiffLine[] | null>(null);
  const [diffError, setDiffError] = useState("");
  const decided = proposal.status !== "pending";
  const stack = STACK_ACTIONS.has(proposal.action);
  const payload = (proposal.payload ?? {}) as { project?: string; compose?: string };
  const project = proposal.project ?? payload.project ?? "";
  const environment = endpoints.find((endpoint) => endpoint.id === proposal.endpointId)?.name ?? proposal.endpointId;
  const name = proposal.containerName ?? project ?? proposal.containerId ?? "";
  const fields = effectiveFields(proposal.action, proposal.payload);
  const rows =
    proposal.action === "duplicate" && name ? [{ label: "Source container", value: name }, ...fields] : fields;
  const replacesSource = proposal.action === "duplicate" && name !== "" && name === String((proposal.payload as { name?: unknown } | undefined)?.name ?? "");

  useEffect(() => {
    if (!stack || !payload.compose) return;
    let live = true;
    async function loadDiff() {
      let before = "";
      try {
        const body = await api<StackDetail>(`/api/endpoints/${proposal.endpointId}/stacks/${encodeURIComponent(project)}`);
        before = body.compose ?? "";
      } catch (err) {
        if (!(err instanceof ApiError) || err.code !== "not_found") {
          if (live) setDiffError(err instanceof ApiError ? err.message : "The current compose file could not be read.");
        }
      }
      if (live) setDiff(unifiedDiff(before, payload.compose ?? ""));
    }
    void loadDiff();
    return () => { live = false; };
  }, [proposal.endpointId, project, payload.compose, stack]);

  async function decide(kind: "confirm" | "reject") {
    setBusy(kind);
    try {
      await api(`/api/proposals/${encodeURIComponent(proposal.id)}/${kind}`, {
        method: "POST",
        timeoutMs: stack && kind === "confirm" ? 310_000 : undefined,
      });
      await onDecided("");
    } catch (err) {
      const text = err instanceof ApiError ? err.message : "The API did not answer within 10 seconds.";
      await onDecided(
        kind === "confirm"
          ? `Confirm failed. ${text}`
          : `Reject failed. ${text}`,
      );
    } finally {
      setBusy("");
    }
  }

  const verb = proposal.action.replace(/^stack-/, "");

  return (
    <Dialog
      className="container-edit-dialog"
      title={decided ? actionLabel(proposal.action) : `${actionLabel(proposal.action)} ${name}?`}
      onClose={onClose}
    >
        <div className="facts">
          <div className="fact"><span>Target</span><strong>{name} <span className="cell-2">{environment}</span></strong></div>
          <div className="fact"><span>Action</span><strong>{actionLabel(proposal.action)}</strong></div>
          <div className="fact"><span>Requested</span><strong className="mono">{atTime(proposal.createdAt)}</strong></div>
          <div className="fact"><span>Expires</span><strong className="mono">{left(proposal.expiresAt)}</strong></div>
          <div className="fact"><span>Requested by</span><strong className="mono">{proposal.credentialId ?? "agent credential"}</strong></div>
          <div className="fact"><span>Proposal ID</span><strong className="mono">{proposal.id}</strong></div>
        </div>
        {rows.length > 0 ? (
          <>
            <h3>What will run</h3>
            <div className="facts">
              {rows.map((field) => (
                <div className="fact" key={field.label}>
                  <span>{field.label}</span>
                  <strong className="mono" style={{ whiteSpace: "pre-wrap" }}>{field.value}</strong>
                </div>
              ))}
            </div>
          </>
        ) : null}
        {stack ? (
          <>
            <h3>Compose changes</h3>
            {diffError ? <p className="ai-help">{diffError}</p> : null}
            {diff === null ? (
              <p className="ai-help">Loading the current compose file…</p>
            ) : (
              <div className="diff" role="group" tabIndex={0} aria-label="Compose changes">
                {diff.map((line, index) => (
                  <div key={index} className={line.kind}>{line.text}</div>
                ))}
              </div>
            )}
            <p className="ai-help">
              Environment values, label values, and mount sources are removed by Pisces before the
              proposal is stored. Pisces re-checks every service and mount at the moment you confirm.
            </p>
          </>
        ) : null}
        {proposal.action === "duplicate" ? (
          <p className="ai-help">
            The copy inherits the source container&apos;s environment, labels, and mounts. Pisces
            rejects agent-proposed values for those fields, and never stores one.
            {replacesSource
              ? " The new name is the source's own name, so Pisces replaces the source container in place."
              : ""}
          </p>
        ) : null}
        {proposal.action === "recreate" && !stack ? (
          <p className="ai-help">
            Pisces stops the container, starts a replacement from its current configuration under the
            same name, and removes the original only once the replacement is running.
          </p>
        ) : null}
        {decided ? (
          <p>
            {proposal.status === "expired"
              ? "This proposal expired before it was decided. Nothing ran. The agent must propose again."
              : `${actionLabel(proposal.action)} was ${proposal.status} by ${proposal.decidedBy ?? "the operator"} at ${atTime(proposal.decidedAt)}. Nothing else will run from it.`}
            {proposal.message ? ` ${proposal.message}` : ""}
          </p>
        ) : (
          <p>
            Confirming {verb === "run" ? "creates the container" : `${verb}s ${name}`} now, as {username || "the operator"} in
            this browser. The agent cannot confirm its own proposal. A proposal runs once, and
            expires if you do not decide.
          </p>
        )}
        <div className="dialog-actions">
          {decided ? (
            <button className="btn" data-focus="first" type="button" onClick={onClose}>Close</button>
          ) : (
            <>
              <button className="btn" data-focus="first" type="button" onClick={onClose}>Cancel</button>
              <button className="btn danger" type="button" disabled={Boolean(busy)} onClick={() => void decide("reject")}>
                {busy === "reject" ? "Rejecting…" : "Reject"}
              </button>
              <button className="btn primary" type="button" disabled={Boolean(busy)} onClick={() => void decide("confirm")}>
                {busy === "confirm" ? "Confirming…" : `Confirm ${actionLabel(proposal.action).toLowerCase()}`}
              </button>
            </>
          )}
        </div>
    </Dialog>
  );
}

