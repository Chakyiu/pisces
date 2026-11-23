"use client";

import { createContext, useContext, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { api } from "../lib/api";
import type { Endpoint, Overview } from "../lib/types";
import { useSession } from "./session";
import { Gate, Icon, IconButton } from "./bits";

export type Crumb = { label: string; href?: string; mono?: boolean; translate?: "no" };

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

type NavCountKey = "containers" | "images" | "networks" | "volumes" | null;

const DOCKER_NAV: { icon: string; label: string; suffix: string; countKey: NavCountKey }[] = [
  { icon: "overview", label: "Dashboard", suffix: "", countKey: null },
  { icon: "stacks", label: "Stacks", suffix: "/stacks", countKey: null },
  { icon: "containers", label: "Containers", suffix: "/containers", countKey: "containers" },
  { icon: "images", label: "Images", suffix: "/images", countKey: "images" },
  { icon: "networks", label: "Networks", suffix: "/networks", countKey: "networks" },
  { icon: "volumes", label: "Volumes", suffix: "/volumes", countKey: "volumes" },
];

const SIDEBAR_KEY = "pisces.sidebar.open";
const USER_MENU_ID = "user-menu";

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
  const [navCounts, setNavCounts] = useState<Overview["counts"] | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

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

  useEffect(() => {
    if (menu) menuRef.current?.querySelector<HTMLElement>("[role=\"menuitem\"]")?.focus();
  }, [menu]);

  useEffect(() => { setMenu(false); }, [pathname]);
  useEffect(() => {
    if (window.innerWidth < 561) setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!current || current.kind !== "docker") {
      setNavCounts(null);
      return;
    }
    let cancelled = false;
    void api<Overview>(`/api/endpoints/${current.id}/overview`)
      .then((body) => {
        if (!cancelled && body && "counts" in body) setNavCounts(body.counts);
      })
      .catch(() => {
        if (!cancelled) setNavCounts(null);
      });
    return () => {
      cancelled = true;
    };
  }, [current?.id, current?.kind]);

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

  function closeMenu() {
    setMenu(false);
    menuButtonRef.current?.focus();
  }

  function onMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[role=\"menuitem\"]"));
    if (!items.length) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        items[index === -1 ? 0 : (index + 1) % items.length].focus();
        break;
      case "ArrowUp":
        event.preventDefault();
        items[index === -1 ? items.length - 1 : (index - 1 + items.length) % items.length].focus();
        break;
      case "Home":
        event.preventDefault();
        items[0].focus();
        break;
      case "End":
        event.preventDefault();
        items[items.length - 1].focus();
        break;
      case "Escape":
        event.preventDefault();
        closeMenu();
        break;
      case "Tab":
        setMenu(false);
        break;
    }
  }

  function toggleSidebar() {
    setOpen((value) => {
      const next = !value;
      localStorage.setItem(SIDEBAR_KEY, String(next));
      return next;
    });
  }

  function navCount(key: NavCountKey) {
    if (!key || !navCounts) return undefined;
    if (key === "containers") return navCounts.containersRunning + navCounts.containersStopped;
    return navCounts[key];
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

  const collapsed = !open;

  return (
    <ConsoleCtx.Provider value={value}>
      <div className={`shell${open ? " sidebar-open" : ""}${overlay ? " overlay" : ""}`}>
        <aside className={`sidebar${open ? "" : " collapsed"}`}>
          <div className="brand">{open ? "Pisces" : "P"}</div>
          <nav className="nav" aria-label="Primary">
            <EnvSwitcher current={current} collapsed={collapsed} />
            {current?.kind === "docker" ? (
              <>
                {open ? <div className="nav-group-label">Docker</div> : null}
                {DOCKER_NAV.map((item) => {
                  const href = `/e/${current.id}${item.suffix}`;
                  const active = item.suffix === "" ? pathname === `/e/${current.id}` : pathname.startsWith(href);
                  return (
                    <NavLink
                      key={item.label}
                      href={href}
                      icon={item.icon}
                      label={item.label}
                      active={active}
                      collapsed={collapsed}
                      count={navCount(item.countKey)}
                    />
                  );
                })}
              </>
            ) : null}
            {current?.kind === "kubernetes" ? (
              <>
                {open ? <div className="nav-group-label">Kubernetes</div> : null}
                <K8sNav id={current.id} pathname={pathname} collapsed={collapsed} />
              </>
            ) : null}
          </nav>
          <div className="sidebar-footer">
            <div className="footer-settings" aria-hidden={collapsed}>
              <Icon name="settings" />
              <span>Settings</span>
              <span className="nav-soon">soon</span>
            </div>
            <div className="popover">
              <button
                ref={menuButtonRef}
                className="btn user-btn"
                type="button"
                aria-label="User menu"
                title="User menu"
                aria-haspopup="menu"
                aria-expanded={menu}
                aria-controls={menu ? USER_MENU_ID : undefined}
                onClick={() => setMenu((value) => !value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && menu) {
                    event.preventDefault();
                    closeMenu();
                  }
                }}
              >
                <Icon name="user" />
                <span>{session.username}</span>
                <Icon name="chevron" />
              </button>
              {menu ? (
                <div id={USER_MENU_ID} ref={menuRef} className="menu" role="menu" onKeyDown={onMenuKeyDown}>
                  <div className="menu-user" aria-hidden="true">{session.username}</div>
                  <Link role="menuitem" tabIndex={-1} href="/ai-access" onClick={() => setMenu(false)}><Icon name="user" />AI access</Link>
                  <button type="button" role="menuitem" tabIndex={-1} onClick={() => void signOut()}><Icon name="sign-out" />Sign out</button>
                </div>
              ) : null}
            </div>
          </div>
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
                    <Link href={crumb.href} className={crumb.mono ? "crumb-name" : "crumb"} translate={crumb.translate}>{crumb.label}</Link>
                  ) : (
                    <span className={crumb.mono ? "crumb-name" : "crumb"} translate={crumb.translate}>{crumb.label}</span>
                  )}
                </span>
              ))}
            </nav>
            <div className="header-spacer" />
          </header>
          <div className="content">{children}</div>
        </div>
      </div>
    </ConsoleCtx.Provider>
  );
}

export function PageFrame({
  title,
  count,
  crumbs,
  actions,
  onRefresh,
  children,
}: {
  title: string;
  count?: number;
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
        <h1>
          {title}
          {count != null ? <span className="count-pill">{count}</span> : null}
        </h1>
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
  count,
  soon,
  muted,
}: {
  href: string;
  icon: string;
  label: string;
  active: boolean;
  collapsed: boolean;
  nested?: boolean;
  count?: number;
  soon?: boolean;
  muted?: boolean;
}) {
  return (
    <Link
      href={href}
      className={`${active ? "active" : ""}${nested ? " nested" : ""}${muted ? " muted-nav" : ""}`}
      aria-current={active ? "page" : undefined}
      aria-label={label}
      title={label}
    >
      <Icon name={icon} />
      {collapsed ? null : (
        <>
          <span className="nav-label">{label}</span>
          {count != null ? <span className="nav-count">{count}</span> : null}
          {soon ? <span className="nav-soon">soon</span> : null}
        </>
      )}
    </Link>
  );
}

function EnvSwitcher({ current, collapsed }: { current?: Endpoint; collapsed: boolean }) {
  const label = current ? current.name : "Choose environment";
  const icon = current ? (current.kind === "kubernetes" ? "kubernetes" : "docker") : "home";
  return (
    <Link href="/home" className="env-switcher" aria-label={`Environment: ${label}`} title={label}>
      <Icon name={icon} />
      {collapsed ? null : (
        <>
          <span className="env-switcher-label">{label}</span>
          <Icon name="chevron" />
        </>
      )}
    </Link>
  );
}

function K8sNav({ id, pathname, collapsed }: { id: string; pathname: string; collapsed: boolean }) {
  const base = `/e/${id}`;
  const services = pathname.startsWith(`${base}/services`);
  const items = [
    { href: base, icon: "overview", label: "Dashboard", active: pathname === base },
    { href: `${base}/workloads`, icon: "workloads", label: "Applications", active: pathname.startsWith(`${base}/workloads`) },
    { href: `${base}/services`, icon: "networks", label: "Networking", active: false },
  ];
  return (
    <>
      {items.map((item) => (
        <NavLink key={item.label} href={item.href} icon={item.icon} label={item.label} active={item.active} collapsed={collapsed} soon muted />
      ))}
      {services ? (
        <NavLink href={`${base}/services`} icon="services" label="Services" active collapsed={collapsed} nested={!collapsed} soon muted />
      ) : null}
    </>
  );
}