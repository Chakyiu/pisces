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
  const [busy, setBusy] = useState("");
  const [alert, setAlert] = useState("");
  const [counts, setCounts] = useState<Counts | null>(null);
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
          }
        } catch {
          // A down endpoint just drops out of the count.
        }
      }
      if (live) setCounts(seen ? totals : null);
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

  async function issue() {
    setBusy("issue");
    setAlert("");
    try {
      const body = await api<IssuedCredential>("/api/agent/credential", { method: "POST" });
      setIssued(body);
      setRevokeOpen(false);
      await load(false);
    } catch (err) {
      setAlert(err instanceof ApiError ? err.message : "The API did not answer within 10 seconds. Nothing changed.");
    } finally {
      setBusy("");
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
                <button className="btn" type="button" disabled={Boolean(busy)} onClick={() => void issue()}>
                  {busy === "issue" ? "Issuing…" : "Replace credential"}
                </button>
                <button className="btn danger" type="button" disabled={Boolean(busy)} onClick={() => setRevokeOpen(true)}>
                  Revoke credential
                </button>
              </>
            ) : null}
            {state === "expired" || state === "revoked" ? (
              <button className="btn primary" type="button" disabled={Boolean(busy)} onClick={() => void issue()}>
                {busy === "issue" ? "Issuing…" : "Issue new credential"}
              </button>
            ) : null}
            {state === "none" ? (
              <button className="btn primary" type="button" disabled={Boolean(busy)} onClick={() => void issue()}>
                {busy === "issue" ? "Issuing…" : "Issue credential"}
              </button>
            ) : null}
          </div>
          <p className="ai-help" style={{ padding: "0 16px" }}>
            One credential at a time. Pisces keeps a verifier, never the secret.
          </p>
          {state === "expired" ? (
            <div className="alert" role="alert" style={{ margin: "0 16px 12px" }}>
              <strong>Agent calls are refused.</strong>
              <p>
                Every request with this credential now fails closed. Container access settings are
                unchanged and apply again as soon as you issue a new credential.
              </p>
            </div>
          ) : null}
          {state === "none" ? (
            <p className="ai-help" style={{ padding: "0 16px 16px" }}>
              No agent can call this install until you issue a credential. Issue one, copy it into the
              agent&apos;s own configuration, and it stays valid for 8 hours.
            </p>
          ) : (
            <div className="facts" style={{ padding: "0 16px 16px" }}>
              <div className="fact">
                <span>Status</span>
                <strong>{state === "active" ? "ACTIVE" : state === "expired" ? "EXPIRED" : "REVOKED"}</strong>
              </div>
              <Fact label="Credential ID" value={credential.id} mono />
              <Fact label="Issued" value={atTime(credential.issuedAt)} />
              <Fact
                label="Expires"
                value={state === "active" ? `${atTime(credential.expiresAt)} (${left(credential.expiresAt)})` : atTime(credential.expiresAt)}
              />
              <Fact label="Last used" value={credential.lastUsedAt ? atTime(credential.lastUsedAt) : "Never"} />
              <Fact label="Containers open" value={open} />
            </div>
          )}
          <p className="ai-help" style={{ padding: "0 16px 16px" }}>
            Your own sign-in secrets are not managed here and are never displayed in Pisces.
          </p>
        </section>
      ) : null}
      {status === "ready" && credential?.state === "active" ? (
        <p className="ai-help">
          <Link className="ai-link" href="/ai-access/proposals">
            {pending === 0 ? "Open the proposal queue." : `Review ${pending} pending proposal${pending === 1 ? "" : "s"}.`}
          </Link>
        </p>
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
              <button className="btn" type="button" disabled={Boolean(busy)} onClick={() => void issue()}>
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
          Expires {atTime(issued.expiresAt)} ({left(issued.expiresAt)}). Store it in the
          agent&apos;s own configuration. Do not put it in a container environment variable, a Docker
          label, or a shared log.
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
