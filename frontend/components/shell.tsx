"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { api } from "../lib/api";
import type { Endpoint } from "../lib/types";
import { useSession } from "./session";
import { Gate, Icon, IconButton } from "./bits";

export type Crumb = { label: string; href?: string; mono?: boolean };

type ConsoleValue = {
  username: string;
  endpoints: Endpoint[];
  current?: Endpoint;
  ready: boolean;
  down: Record<string, boolean>;
  refresh: () => Promise<void>;
  reportDown: (id: string) => void;
  setCrumbs: (crumbs: Crumb[]) => void;
};

const ConsoleCtx = createContext<ConsoleValue | null>(null);

export function useConsole(): ConsoleValue {
  const value = useContext(ConsoleCtx);
  if (!value) throw new Error("console missing");
  return value;
}

const DOCKER_NAV = [
  { icon: "overview", label: "Dashboard", suffix: "" },
  { icon: "containers", label: "Containers", suffix: "/containers" },
  { icon: "images", label: "Images", suffix: "/images" },
  { icon: "networks", label: "Networks", suffix: "/networks" },
  { icon: "volumes", label: "Volumes", suffix: "/volumes" },
] as const;

const SIDEBAR_KEY = "pisces.sidebar.open";

export function Shell({ children }: { children: ReactNode }) {
  const session = useSession();
  const pathname = usePathname();
  const router = useRouter();
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [ready, setReady] = useState(false);
  const [down, setDown] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState(false);
  const [open, setOpen] = useState(true);
  const [overlay, setOverlay] = useState(false);
  const [crumbs, setCrumbs] = useState<Crumb[]>([]);

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

  useEffect(() => {
    // Initial open follows viewport. Stored false only keeps a wide desktop collapsed.
    const width = window.innerWidth;
    const stored = localStorage.getItem(SIDEBAR_KEY);
    setOpen(width >= 992 && stored !== "false");
    setOverlay(width < 561);
    function onResize() {
      setOverlay(window.innerWidth < 561);
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => { setMenu(false); }, [pathname]);
  useEffect(() => {
    if (window.innerWidth < 561) setOpen(false);
  }, [pathname]);

  if (session.status === "checking") return <Gate title="Checking session" />;
  if (session.status === "error") {
    return <Gate title="The API did not answer within 10 seconds." onRetry={() => void session.refresh()} />;
  }
  if (session.status !== "in") return <Gate title="Checking session" />;

  async function signOut() {
    await api("/api/session", { method: "DELETE" }).catch(() => undefined);
    session.signOut();
    router.replace("/login");
  }

  function toggleSidebar() {
    setOpen((value) => {
      const next = !value;
      localStorage.setItem(SIDEBAR_KEY, String(next));
      return next;
    });
  }

  const value: ConsoleValue = {
    username: session.username,
    endpoints,
    current,
    ready,
    down,
    refresh,
    reportDown(endpointId: string) {
      setDown((prev) => ({ ...prev, [endpointId]: true }));
    },
    setCrumbs,
  };

  const home = pathname === "/home" || pathname === "/endpoints";

  return (
    <ConsoleCtx.Provider value={value}>
      <div className={`shell${open ? " sidebar-open" : ""}${overlay ? " overlay" : ""}`}>
        <aside className={`sidebar${open ? "" : " collapsed"}`}>
          <div className="brand">{open ? "Pisces" : "P"}</div>
          <nav className="nav" aria-label="Primary">
            <NavLink href="/home" icon="home" label="Home" active={home} collapsed={!open} />
            <EnvBlock current={current} collapsed={!open} />
            {current?.kind === "kubernetes" ? (
              <K8sNav id={current.id} pathname={pathname} collapsed={!open} />
            ) : current ? (
              DOCKER_NAV.map((item) => {
                const href = `/e/${current.id}${item.suffix}`;
                const active = item.suffix === "" ? pathname === `/e/${current.id}` : pathname.startsWith(href);
                return <NavLink key={item.label} href={href} icon={item.icon} label={item.label} active={active} collapsed={!open} />;
              })
            ) : null}
          </nav>
          <div className="sidebar-footer">{open ? "Pisces" : "P"}</div>
        </aside>
        <div className="main">
          <header className="page-header">
            <IconButton name="sidebar" label="Toggle sidebar" onClick={toggleSidebar} />
            <span className="header-rule" aria-hidden="true" />
            <nav className="crumbs" aria-label="Breadcrumb">
              {crumbs.map((crumb, index) => (
                <span key={`${crumb.label}-${index}`} className="crumb-item">
                  {index > 0 ? <span className="crumb-sep">/</span> : null}
                  {crumb.href ? (
                    <Link href={crumb.href} className={crumb.mono ? "crumb-name" : "crumb"}>{crumb.label}</Link>
                  ) : (
                    <span className={crumb.mono ? "crumb-name" : "crumb"}>{crumb.label}</span>
                  )}
                </span>
              ))}
            </nav>
            <div className="header-spacer" />
            <div className="popover">
              <button className="btn user-btn" type="button" aria-label="User menu" title="User menu" aria-expanded={menu} onClick={() => setMenu((value) => !value)}>
                <Icon name="user" />
                <span>{session.username}</span>
                <Icon name="chevron" />
              </button>
              {menu ? (
                <div className="menu" role="menu">
                  <div className="menu-user">{session.username}</div>
                  <button type="button" onClick={() => void signOut()}><Icon name="sign-out" />Sign out</button>
                </div>
              ) : null}
            </div>
          </header>
          <div className="content">{children}</div>
        </div>
      </div>
    </ConsoleCtx.Provider>
  );
}

export function PageFrame({
  title,
  crumbs,
  actions,
  onRefresh,
  children,
}: {
  title: string;
  crumbs: Crumb[];
  actions?: ReactNode;
  onRefresh?: () => void;
  children: ReactNode;
}) {
  const { setCrumbs } = useConsole();
  const serialized = JSON.stringify(crumbs);
  const latest = useRef(crumbs);
  latest.current = crumbs;
  useEffect(() => {
    setCrumbs(latest.current);
  }, [serialized, setCrumbs]);
  return (
    <>
      <div className="title-row">
        <h1>{title}</h1>
        <div className="title-actions">
          {actions}
          {onRefresh ? <IconButton name="refresh" label="Refresh page" onClick={onRefresh} /> : null}
        </div>
      </div>
      {children}
    </>
  );
}

function NavLink({
  href,
  icon,
  label,
  active,
  collapsed,
  nested,
}: {
  href: string;
  icon: string;
  label: string;
  active: boolean;
  collapsed: boolean;
  nested?: boolean;
}) {
  return (
    <Link
      href={href}
      className={`${active ? "active" : ""}${nested ? " nested" : ""}`}
      aria-current={active ? "page" : undefined}
      aria-label={label}
      title={label}
    >
      <Icon name={icon} />
      {collapsed ? null : <span>{label}</span>}
    </Link>
  );
}

function EnvBlock({ current, collapsed }: { current?: Endpoint; collapsed: boolean }) {
  const router = useRouter();
  if (!current) {
    return (
      <div className="env-none" title="None selected" aria-label="None selected">
        {collapsed ? null : <span>Environment:</span>}
        <Icon name="slash" />
        {collapsed ? null : <span>None selected</span>}
      </div>
    );
  }
  return (
    <div className="env-current">
      <span className="env-icon" title={current.name} aria-label={current.name}>
        <Icon name={current.kind === "kubernetes" ? "kubernetes" : "docker"} />
      </span>
      {collapsed ? null : <span className="env-name" title={current.name}>{current.name}</span>}
      {collapsed ? null : (
        <button
          className="icon-btn"
          type="button"
          aria-label="Clear environment"
          title="Clear environment"
          onClick={() => router.push("/home")}
        >
          <Icon name="clear" />
        </button>
      )}
    </div>
  );
}

function K8sNav({ id, pathname, collapsed }: { id: string; pathname: string; collapsed: boolean }) {
  const base = `/e/${id}`;
  const services = pathname.startsWith(`${base}/services`);
  return (
    <>
      <NavLink href={base} icon="overview" label="Dashboard" active={pathname === base} collapsed={collapsed} />
      <NavLink href={`${base}/workloads`} icon="workloads" label="Applications" active={pathname.startsWith(`${base}/workloads`)} collapsed={collapsed} />
      <NavLink href={`${base}/services`} icon="networks" label="Networking" active={false} collapsed={collapsed} />
      {services ? (
        <NavLink href={`${base}/services`} icon="services" label="Services" active collapsed={collapsed} nested={!collapsed} />
      ) : null}
    </>
  );
}
