"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ApiError, api } from "../lib/api";
import type { Endpoint } from "../lib/types";
import { useSession } from "./session";
import { Dialog, Gate, Icon } from "./bits";

type Header =
  | { title: string }
  | { crumb: string; href: string; name: string };

type ConsoleValue = {
  username: string;
  endpoints: Endpoint[];
  current?: Endpoint;
  ready: boolean;
  refresh: () => Promise<void>;
  reportDown: (id: string) => void;
  setHeader: (header: Header) => void;
};

const ConsoleCtx = createContext<ConsoleValue | null>(null);

export function useConsole(): ConsoleValue {
  const value = useContext(ConsoleCtx);
  if (!value) throw new Error("console missing");
  return value;
}

const DOCKER_NAV = [
  ["overview", "Overview", ""],
  ["containers", "Containers", "/containers"],
  ["images", "Images", "/images"],
  ["volumes", "Volumes", "/volumes"],
  ["networks", "Networks", "/networks"],
] as const;

const K8S_NAV = [
  ["overview", "Overview", ""],
  ["workloads", "Workloads", "/workloads"],
  ["pods", "Pods", "/pods"],
  ["services", "Services", "/services"],
] as const;

export function Shell({ children }: { children: ReactNode }) {
  const session = useSession();
  const pathname = usePathname();
  const router = useRouter();
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [ready, setReady] = useState(false);
  const [down, setDown] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<"endpoint" | "user" | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [dialog, setDialog] = useState<"docker" | "k8s" | "remove" | null>(null);
  const [header, setHeader] = useState<Header>({ title: "Pisces" });

  const id = pathname.match(/^\/e\/([^/]+)/)?.[1];
  const current = endpoints.find((endpoint) => endpoint.id === id);

  async function refresh() {
    try {
      const body = await api<{ items: Endpoint[] }>("/api/endpoints");
      setEndpoints(body.items);
      setDown((prev) => {
        const next = { ...prev };
        for (const endpoint of body.items) {
          if (endpoint.status === "up") delete next[endpoint.id];
          if (endpoint.status === "down") next[endpoint.id] = true;
        }
        return next;
      });
    } finally {
      setReady(true);
    }
  }

  useEffect(() => {
    if (session.status === "in") void refresh();
  }, [session.status]);

  useEffect(() => {
    if (session.status === "out") {
      router.replace(session.ended ? "/login?ended=1" : "/login");
    }
  }, [session, router]);

  if (session.status === "checking") return <Gate title="Checking session" />;
  if (session.status === "error") {
    return <Gate title="The API did not answer within 10 seconds." onRetry={() => void session.refresh()} />;
  }
  if (session.status !== "in") return <Gate title="Checking session" />;

  const nav = !current
    ? ([["endpoints", "Endpoints", "/endpoints"]] as const)
    : current.kind === "kubernetes"
      ? K8S_NAV
      : DOCKER_NAV;
  const base = current ? `/e/${current.id}` : "";
  const status = footer(endpoints, current, down);

  async function signOut() {
    await api("/api/session", { method: "DELETE" }).catch(() => undefined);
    session.signOut();
    router.replace("/login");
  }

  async function addDocker(name: string) {
    const created = await api<Endpoint>("/api/endpoints", {
      method: "POST",
      body: { kind: "docker", name },
    });
    await refresh();
    setDialog(null);
    router.push(`/e/${created.id}`);
  }

  async function addKubernetes(name: string, context: string) {
    const created = await api<Endpoint>("/api/endpoints", {
      method: "POST",
      body: { kind: "kubernetes", name, context },
    });
    await refresh();
    setDialog(null);
    router.push(`/e/${created.id}`);
  }

  async function removeEndpoint() {
    if (!current) return;
    await api(`/api/endpoints/${current.id}`, { method: "DELETE" });
    const rest = endpoints.filter((endpoint) => endpoint.id !== current.id);
    setEndpoints(rest);
    setDialog(null);
    setMenu(null);
    router.push(rest[0] ? `/e/${rest[0].id}` : "/endpoints");
    void refresh();
  }

  const value: ConsoleValue = {
    username: session.username,
    endpoints,
    current,
    ready,
    refresh,
    reportDown(endpointId: string) {
      setDown((prev) => ({ ...prev, [endpointId]: true }));
    },
    setHeader,
  };

  return (
    <ConsoleCtx.Provider value={value}>
      <div className="shell">
        <aside className={drawer ? "sidebar open" : "sidebar"}>
          <div className="brand">Pisces</div>
          <nav className="nav">
            {nav.map(([icon, label, suffix]) => {
              const href = suffix === "/endpoints" ? "/endpoints" : `${base}${suffix}`;
              const active = suffix === "/endpoints" ? pathname.startsWith("/endpoints") : suffix === "" ? pathname === base : pathname.startsWith(href);
              return (
                <a key={label} href={href} className={active ? "active" : undefined} onClick={() => setDrawer(false)}>
                  <Icon name={icon} />
                  {label}
                </a>
              );
            })}
          </nav>
          <div className="footer-status">
            <i className={`sq ${status.tone}`} />
            {status.label}
          </div>
        </aside>
        <div className="main">
          <header className="header">
            <button className="btn menu-btn" type="button" onClick={() => setDrawer((open) => !open)}>Menu</button>
            {"crumb" in header ? (
              <h1>
                <a className="crumb" href={header.href}>{header.crumb}</a>
                {" / "}
                <span className="mono">{header.name}</span>
              </h1>
            ) : (
              <h1>{header.title}</h1>
            )}
            <div className="header-spacer" />
            <div className="cluster">
              {current ? (
                <div className="popover">
                  <button
                    className="btn"
                    type="button"
                    onClick={() => {
                      setMenu(menu === "endpoint" ? null : "endpoint");
                      void refresh();
                    }}
                  >
                    <span className="mono">{current.name}</span> <span className="kind">{current.kind}</span>
                  </button>
                  {menu === "endpoint" ? (
                    <div className="menu" role="menu">
                      {endpoints.map((endpoint) => (
                        <button
                          key={endpoint.id}
                          type="button"
                          onClick={() => {
                            setMenu(null);
                            router.push(`/e/${endpoint.id}`);
                          }}
                        >
                          <span className="endpoint-row">
                            <span>
                              <span className="mono">{endpoint.name}</span> <span className="kind">{endpoint.kind}</span>
                            </span>
                            <span className="kind">{down[endpoint.id] || endpoint.status === "down" ? "Down" : "Up"}{endpoint.id === current.id ? " · Current" : ""}</span>
                          </span>
                        </button>
                      ))}
                      <button type="button" onClick={() => { setMenu(null); setDialog("docker"); }}>Add Docker endpoint</button>
                      <button type="button" onClick={() => { setMenu(null); setDialog("k8s"); }}>Add Kubernetes context</button>
                      <button type="button" onClick={() => { setMenu(null); setDialog("remove"); }}>Remove endpoint</button>
                    </div>
                  ) : null}
                </div>
              ) : null}
              <div className="popover">
                <button className="btn" type="button" onClick={() => setMenu(menu === "user" ? null : "user")}>{session.username}</button>
                {menu === "user" ? (
                  <div className="menu">
                    <div className="kind" style={{ padding: "8px" }}>{session.username}</div>
                    <button type="button" onClick={() => void signOut()}>Sign out</button>
                  </div>
                ) : null}
              </div>
            </div>
          </header>
          <div className="content">{children}</div>
        </div>
      </div>
      {dialog === "docker" ? <DockerDialog onClose={() => setDialog(null)} onAdd={addDocker} /> : null}
      {dialog === "k8s" ? <KubernetesDialog onClose={() => setDialog(null)} onAdd={addKubernetes} /> : null}
      {dialog === "remove" && current ? (
        <Dialog title={`Remove endpoint ${current.name}?`} onClose={() => setDialog(null)}>
          <p className="note">Pisces forgets the connection. It does not delete containers or cluster objects.</p>
          <div className="dialog-actions">
            <button className="btn" data-focus="first" type="button" onClick={() => setDialog(null)}>Cancel</button>
            <button className="btn danger" type="button" onClick={() => void removeEndpoint()}>Remove</button>
          </div>
        </Dialog>
      ) : null}
    </ConsoleCtx.Provider>
  );
}

function footer(endpoints: Endpoint[], current: Endpoint | undefined, down: Record<string, boolean>) {
  if (endpoints.length === 0 || !current) return { label: "No endpoint", tone: "muted" };
  const isDown = down[current.id] || current.status === "down";
  if (current.kind === "kubernetes") return { label: isDown ? "API down" : "API up", tone: isDown ? "bad" : "ok" };
  return { label: isDown ? "Engine down" : "Engine up", tone: isDown ? "bad" : "ok" };
}

function DockerDialog({ onClose, onAdd }: { onClose: () => void; onAdd: (name: string) => Promise<void> }) {
  const [name, setName] = useState("local");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  return (
    <Dialog title="Add Docker endpoint" onClose={onClose}>
      <label className="label">
        Name
        <input className="field" value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <label className="label">
        Engine
        <input className="field" readOnly value="This machine" />
      </label>
      {error ? <p className="field-error">{error}</p> : null}
      <div className="dialog-actions">
        <button className="btn" type="button" onClick={onClose}>Cancel</button>
        <button
          className="btn primary"
          type="button"
          disabled={pending}
          onClick={() => {
            setPending(true);
            setError("");
            onAdd(name.trim() || "local").catch((err: unknown) => {
              setError(err instanceof ApiError ? err.message : "The endpoint could not be added.");
              setPending(false);
            });
          }}
        >
          {pending ? "Adding…" : "Add"}
        </button>
      </div>
    </Dialog>
  );
}

function KubernetesDialog({
  onClose,
  onAdd,
}: {
  onClose: () => void;
  onAdd: (name: string, context: string) => Promise<void>;
}) {
  const [name, setName] = useState("desk");
  const [contexts, setContexts] = useState<string[] | null>(null);
  const [context, setContext] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  function load() {
    setContexts(null);
    setError("");
    api<{ items: { name: string }[] }>("/api/kubernetes/contexts")
      .then((body) => {
        setContexts(body.items.map((item) => item.name));
        setContext(body.items[0]?.name ?? "");
      })
      .catch((err: unknown) => {
        setContexts([]);
        setError(err instanceof ApiError ? `Couldn’t load contexts. ${err.message}` : "Couldn’t load contexts.");
      });
  }

  useEffect(() => { load(); }, []);

  const empty = contexts !== null && contexts.length === 0 && !error;
  return (
    <Dialog title="Add Kubernetes context" onClose={onClose}>
      <label className="label">
        Name
        <input className="field" value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <label className="label">
        Context
        {contexts === null ? (
          <select className="select" disabled><option>Loading contexts…</option></select>
        ) : error ? (
          <span className="field-error">{error} <button className="btn tiny" type="button" onClick={load}>Retry</button></span>
        ) : empty ? (
          <span className="note">No Kubernetes context is visible to the server.</span>
        ) : (
          <select className="select" value={context} onChange={(event) => setContext(event.target.value)}>
            {contexts.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        )}
      </label>
      <div className="dialog-actions">
        <button className="btn" type="button" onClick={onClose}>Cancel</button>
        <button
          className="btn primary"
          type="button"
          disabled={pending || !context || Boolean(error) || contexts === null}
          onClick={() => {
            setPending(true);
            onAdd(name.trim() || "desk", context).catch((err: unknown) => {
              setError(err instanceof ApiError ? err.message : "The endpoint could not be added.");
              setPending(false);
            });
          }}
        >
          {pending ? "Adding…" : "Add"}
        </button>
      </div>
    </Dialog>
  );
}
