"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ApiError, api } from "../../../lib/api";
import { atTime, left } from "../../../lib/format";
import type { AgentCredential, AiAccessItem, Endpoint, IssuedCredential } from "../../../lib/types";
import { Dialog, ErrorState, Icon, Loading } from "../../../components/bits";
import { AiAccessTabs } from "../../../components/ai-access-tabs";
import { PageFrame, useConsole } from "../../../components/shell";

type Counts = { read: number; operate: number; locked: number };

// Same steps the API accepts: 8h, 24h, 7d, 30d. Other values are rejected.
const TTL_CHOICES = [
  { secs: 8 * 60 * 60, label: "8 hours" },
  { secs: 24 * 60 * 60, label: "24 hours" },
  { secs: 7 * 24 * 60 * 60, label: "7 days" },
  { secs: 30 * 24 * 60 * 60, label: "30 days" },
] as const;

const READ_ONLY_TTL = 24 * 60 * 60;

function ttlLabel(secs: number): string {
  const known = TTL_CHOICES.find((choice) => choice.secs === secs);
  if (known) return known.label;
  if (secs > 0 && secs % 86400 === 0) {
    const days = secs / 86400;
    return `${days} day${days === 1 ? "" : "s"}`;
  }
  if (secs > 0 && secs % 3600 === 0) {
    const hours = secs / 3600;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return secs > 0 ? `${secs} seconds` : "—";
}

function tierLabel(tier: AgentCredential["accessTier"]): string {
  return tier === "operate" ? "Operate" : "Read";
}

function statusLabel(state: AgentCredential["state"]): string {
  switch (state) {
    case "active":
      return "ACTIVE";
    case "expired":
      return "EXPIRED";
    case "idle":
      return "IDLE";
    case "revoked":
      return "REVOKED";
    case "none":
      return "NONE";
  }
}

function idleSeconds(text: string): number | null {
  if (!/^\d+$/.test(text)) return null;
  const days = Number(text);
  if (days > 30) return null;
  return days * 86400;
}

export default function AiAccessPage() {
  return (
    <PageFrame title="AI access" crumbs={[{ label: "AI access" }]}>
      <CredentialScreen />
    </PageFrame>
  );
}

function CredentialScreen() {
  const { endpoints, username } = useConsole();
  const [credential, setCredential] = useState<AgentCredential | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState("");
  const [attempts, setAttempts] = useState(0);
  const [at, setAt] = useState<Date | undefined>();
  const [issued, setIssued] = useState<IssuedCredential | null>(null);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [chooserOpen, setChooserOpen] = useState(false);
  const [ttlSecs, setTtlSecs] = useState<number>(TTL_CHOICES[0].secs);
  const [idleDays, setIdleDays] = useState("7");
  const [busy, setBusy] = useState("");
  const [alert, setAlert] = useState("");
  const [counts, setCounts] = useState<Counts | null>(null);
  const [openRows, setOpenRows] = useState<OpenRow[]>([]);
  const [locking, setLocking] = useState("");
  const [pending, setPending] = useState(0);

  async function load(retry: boolean) {
    if (retry) setAttempts((n) => n + 1);
    setStatus("loading");
    try {
      const body = await api<AgentCredential>("/api/agent/credential");
      setCredential(body);
      setStatus("ready");
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : "The API did not answer within 10 seconds. Nothing on this page was changed.");
      setAt(new Date());
      setStatus("error");
    }
  }

  useEffect(() => { void load(false); }, []);

  useEffect(() => {
    let live = true;
    async function collect() {
      const totals: Counts = { read: 0, operate: 0, locked: 0 };
      const rows: OpenRow[] = [];
      let seen = false;
      for (const endpoint of endpoints as Endpoint[]) {
        if (endpoint.kind !== "docker") continue;
        try {
          const body = await api<{ items: AiAccessItem[] }>(`/api/ai-access/${endpoint.id}`);
          seen = true;
          for (const item of body.items) {
            if (item.state === "operate") totals.operate += 1;
            else if (item.state === "read") totals.read += 1;
            else totals.locked += 1;
            if (item.state === "read" || item.state === "operate") {
              rows.push({ ...item, endpointId: endpoint.id, endpointName: endpoint.name });
            }
          }
        } catch {
          // A down endpoint just drops out of the count.
        }
      }
      if (live) {
        setCounts(seen ? totals : null);
        setOpenRows(rows);
      }
    }
    async function proposals() {
      try {
        const body = await api<{ items: { status: string }[] }>("/api/proposals");
        if (live) setPending(body.items.filter((item) => item.status === "pending").length);
      } catch {
        // The queue count is decoration; the tab still opens.
      }
    }
    void collect();
    void proposals();
    return () => { live = false; };
  }, [endpoints, credential]);

  function openChooser() {
    setTtlSecs(TTL_CHOICES[0].secs);
    setIdleDays("7");
    setAlert("");
    setRevokeOpen(false);
    setChooserOpen(true);
  }

  async function issue() {
    const idle = idleSeconds(idleDays);
    if (idle === null) {
      setAlert("Idle expiry must be a whole number of days from 0 through 30.");
      return;
    }
    setBusy("issue");
    setAlert("");
    try {
      const body = await api<IssuedCredential>("/api/agent/credential", {
        method: "POST",
        body: { ttlSecs, idleSecs: idle },
      });
      setIssued(body);
      setChooserOpen(false);
      setRevokeOpen(false);
      await load(false);
    } catch (err) {
      setAlert(err instanceof ApiError ? err.message : "The API did not answer within 10 seconds. Nothing changed.");
    } finally {
      setBusy("");
    }
  }

  async function lock(row: OpenRow) {
    if (row.forcedLocked) return;
    setLocking(`${row.endpointId}:${row.containerId}`);
    setAlert("");
    try {
      await api(`/api/ai-access/${row.endpointId}/${encodeURIComponent(row.containerId)}`, {
        method: "PUT",
        body: { state: "locked" },
      });
      setOpenRows((current) => current.filter((item) => item.endpointId !== row.endpointId || item.containerId !== row.containerId));
      setCounts((current) => current ? {
        ...current,
        read: current.read - (row.state === "read" ? 1 : 0),
        operate: current.operate - (row.state === "operate" ? 1 : 0),
        locked: current.locked + 1,
      } : current);
    } catch (err) {
      setAlert(err instanceof ApiError ? err.message : "Lock failed. This container's access did not change.");
    } finally {
      setLocking("");
    }
  }

  async function revoke() {
    setBusy("revoke");
    setAlert("");
    try {
      await api("/api/agent/credential", { method: "DELETE" });
      setRevokeOpen(false);
      await load(false);
    } catch (err) {
      const text = err instanceof ApiError ? err.message : "The API did not answer within 10 seconds.";
      setRevokeOpen(false);
      setAlert(`Revoke failed. ${text}`);
    } finally {
      setBusy("");
    }
  }

  const state = credential?.state ?? "none";
  const open = counts ? `${counts.read} Read · ${counts.operate} Operate · ${counts.locked} Locked` : "—";

  return (
    <div className="stack">
      <AiAccessTabs pending={pending} />
      {alert ? <div className="alert bad" role="alert">{alert}</div> : null}
      {status === "loading" && !credential ? <Loading noun="agent credential" /> : null}
      {status === "error" ? (
        <ErrorState
          title="The Pisces API did not answer within 10 seconds. Nothing on this page was changed."
          message={message}
          attempts={attempts}
          at={at}
          onRetry={() => void load(true)}
        />
      ) : null}
      {status === "ready" && credential ? (
        <section className="widget">
          <div className="widget-head">
            <div className="widget-title"><Icon name="user" /> Agent credential</div>
            <div className="grow" />
            {state === "active" ? (
              <>
                <button className="btn" type="button" disabled={Boolean(busy)} onClick={openChooser}>
                  {busy === "issue" ? "Issuing…" : "Replace credential"}
                </button>
                <button className="btn danger" type="button" disabled={Boolean(busy)} onClick={() => setRevokeOpen(true)}>
                  Revoke credential
                </button>
              </>
            ) : null}
            {state === "expired" || state === "revoked" || state === "idle" ? (
              <button className="btn primary" type="button" disabled={Boolean(busy)} onClick={openChooser}>
                {busy === "issue" ? "Issuing…" : "Issue new credential"}
              </button>
            ) : null}
            {state === "none" ? (
              <button className="btn primary" type="button" disabled={Boolean(busy)} onClick={openChooser}>
                {busy === "issue" ? "Issuing…" : "Issue credential"}
              </button>
            ) : null}
          </div>
          <p className="ai-help" style={{ padding: "0 16px" }}>
            One credential at a time. Pisces keeps a verifier, never the secret.
          </p>
          {state === "expired" || state === "idle" ? (
            <div className="alert" role="alert" style={{ margin: "0 16px 12px" }}>
              <strong>Agent calls are refused.</strong>
              <p>
                {state === "idle"
                  ? "This credential passed its idle deadline. Container access settings are unchanged and apply again as soon as you issue a new credential."
                  : "Every request with this credential now fails closed. Container access settings are unchanged and apply again as soon as you issue a new credential."}
              </p>
            </div>
          ) : null}
          {state === "none" ? (
            <p className="ai-help" style={{ padding: "0 16px 16px" }}>
              No agent can call this install until you issue a credential. Choose 8 hours, 24 hours,
              7 days, or 30 days. A lifetime longer than 24 hours is Read only.
            </p>
          ) : (
            <div className="facts" style={{ padding: "0 16px 16px" }}>
              <div className="fact">
                <span>Status</span>
                <strong>{statusLabel(state)}</strong>
              </div>
              <Fact label="Credential ID" value={credential.id} mono />
              <Fact label="Issued" value={atTime(credential.issuedAt)} />
              <Fact label="TTL" value={ttlLabel(credential.ttlSecs)} />
              <Fact
                label="Expires"
                value={state === "active" ? `${atTime(credential.expiresAt)} (${left(credential.expiresAt)})` : atTime(credential.expiresAt)}
              />
              <Fact
                label="Idle deadline"
                value={credential.idleDeadline ? `${atTime(credential.idleDeadline)} (${left(credential.idleDeadline)})` : "Disabled"}
              />
              <Fact label="Last used" value={credential.lastUsedAt ? atTime(credential.lastUsedAt) : "Never"} />
              <Fact label="Access tier" value={tierLabel(credential.accessTier)} />
              <Fact label="Containers open" value={open} />
            </div>
          )}
          {state === "active" && credential.accessTier === "read" ? (
            <p className="ai-help" style={{ padding: "0 16px 16px" }}>
              This lifetime is longer than 24 hours, so the credential is Read only. Restart, stop,
              remove, and other changes are refused.
            </p>
          ) : null}
          <p className="ai-help" style={{ padding: "0 16px 16px" }}>
            Your own sign-in secrets are not managed here and are never displayed in Pisces.
          </p>
        </section>
      ) : null}
      {status === "ready" ? (
        <section className="widget">
          <div className="widget-head">
            <div className="widget-title">Authorized containers</div>
          </div>
          {openRows.length === 0 ? (
            <p className="ai-help" style={{ padding: "0 16px 16px" }}>
              No containers are open for Read or Operate. The default is Locked.
            </p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Container</th>
                    <th>Environment</th>
                    <th>Access</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {openRows.map((row) => (
                    <tr key={`${row.endpointId}:${row.containerId}`}>
                      <td className="name-cell" title={row.containerName}>
                        <Link className="name-link" href={`/e/${row.endpointId}/containers/${encodeURIComponent(row.containerId)}`}>{row.containerName}</Link>
                      </td>
                      <td>{row.endpointName}</td>
                      <td>{row.state === "operate" ? "Operate" : "Read"}</td>
                      <td>
                        <button
                          className="btn"
                          type="button"
                          disabled={row.forcedLocked || locking === `${row.endpointId}:${row.containerId}`}
                          title={row.forcedLocked ? row.reason : `Lock ${row.containerName}`}
                          onClick={() => void lock(row)}
                        >
                          {locking === `${row.endpointId}:${row.containerId}` ? "Locking…" : "Lock"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}
      {status === "ready" && credential?.state === "active" ? (
        <p className="ai-help">
          <Link className="ai-link" href="/ai-access/proposals">
            {pending === 0 ? "Open the proposal queue." : `Review ${pending} pending proposal${pending === 1 ? "" : "s"}.`}
          </Link>
        </p>
      ) : null}
      {chooserOpen ? (
        <Dialog title="Issue an agent credential" onClose={() => setChooserOpen(false)}>
          <>
            <p>
              One credential at a time. Issuing replaces whatever is current, and the previous secret
              stops working immediately.
            </p>
            <label className="label">
              Lifetime
              <select
                className="select"
                data-focus="first"
                value={ttlSecs}
                onChange={(event) => setTtlSecs(Number(event.target.value))}
              >
                {TTL_CHOICES.map((choice) => (
                  <option key={choice.secs} value={choice.secs}>{choice.label}</option>
                ))}
              </select>
            </label>
            <label className="label">
              Idle expiry (days)
              <input
                className="field"
                inputMode="numeric"
                value={idleDays}
                onChange={(event) => setIdleDays(event.target.value)}
              />
            </label>
            <p className="help">
              0 disables idle expiry. The credential still ends at its absolute expiry. The default
              is 7 days without a successful use.
            </p>
            {ttlSecs > READ_ONLY_TTL ? (
              <p className="help">
                A lifetime longer than 24 hours is Read only. Restart, stop, remove, and other
                changes are refused.
              </p>
            ) : null}
            <div className="dialog-actions">
              <button className="btn" type="button" onClick={() => setChooserOpen(false)}>Cancel</button>
              <button className="btn primary" type="button" disabled={Boolean(busy)} onClick={() => void issue()}>
                {busy === "issue" ? "Issuing…" : "Issue credential"}
              </button>
            </div>
          </>
        </Dialog>
      ) : null}
      {issued ? <IssuedDialog issued={issued} onDone={() => setIssued(null)} /> : null}
      {revokeOpen ? (
        <Dialog title="Revoke the agent credential?" onClose={() => setRevokeOpen(false)}>
          <>
            <p>
              Agent calls stop at once and the {pending} pending proposal{pending === 1 ? "" : "s"} {pending === 1 ? "is" : "are"} rejected.
              Your browser session keeps working, and no container&apos;s Locked, Read, or
              Operate setting changes.
            </p>
            <div className="dialog-actions">
              <button className="btn" data-focus="first" type="button" onClick={() => setRevokeOpen(false)}>Cancel</button>
              <button className="btn" type="button" disabled={Boolean(busy)} onClick={openChooser}>
                Revoke and issue a replacement
              </button>
              <button className="btn danger" type="button" disabled={Boolean(busy)} onClick={() => void revoke()}>
                {busy === "revoke" ? "Revoking…" : "Revoke"}
              </button>
            </div>
          </>
        </Dialog>
      ) : null}
      {status === "ready" ? (
        <p className="note">
          Confirm and reject run as {username || "the operator"} in this browser.
        </p>
      ) : null}
    </div>
  );
}

type OpenRow = AiAccessItem & { endpointId: string; endpointName: string };

function Fact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="fact">
      <span>{label}</span>
      <strong className={mono ? "mono" : undefined} title={value}>{value}</strong>
    </div>
  );
}

function IssuedDialog({ issued, onDone }: { issued: IssuedCredential; onDone: () => void }) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(issued.secret);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="scrim">
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="issued-title">
        <h2 id="issued-title">Credential issued</h2>
        <p>Copy the secret now. This is the only time Pisces shows it — only a verifier is stored.</p>
        <div className="secret-row">
          <code>{issued.secret}</code>
          <button className="btn" data-focus="first" type="button" onClick={() => void copy()}>
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <p className="ai-help">
          Expires {atTime(issued.expiresAt)} ({left(issued.expiresAt)}). TTL {ttlLabel(issued.ttlSecs)}.
          Access tier {tierLabel(issued.accessTier)}. Idle deadline{" "}
          {issued.idleDeadline ? `${atTime(issued.idleDeadline)} (${left(issued.idleDeadline)})` : "disabled"}.
          Store it in the agent&apos;s own configuration. Do not put it in a container environment
          variable, a Docker label, or a shared log.
        </p>
        <label className="check" style={{ width: "auto", height: "auto", justifyItems: "start", gridAutoFlow: "column", gap: 8, margin: "12px 0" }}>
          <input type="checkbox" checked={saved} onChange={(event) => setSaved(event.target.checked)} />
          <span>I saved the secret.</span>
        </label>
        <div className="dialog-actions">
          <button className="btn primary" type="button" disabled={!saved} onClick={onDone}>Done</button>
        </div>
      </div>
    </div>
  );
}
