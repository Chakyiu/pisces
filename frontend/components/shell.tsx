"use client";

import { createContext, useContext, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { api } from "../lib/api";
import type { Endpoint, Overview, Page } from "../lib/types";
import { dockerSectionHref, safeNextPath, withEndpointCrumbs } from "../lib/ux";
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

type NavCountKey = "containers" | "images" | "networks" | "volumes" | "stacks" | null;

const DOCKER_NAV: { icon: string; label: string; suffix: string; countKey: NavCountKey }[] = [
  { icon: "overview", label: "Dashboard", suffix: "", countKey: null },
  { icon: "stacks", label: "Stacks", suffix: "/stacks", countKey: "stacks" },
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
  const [stackTotal, setStackTotal] = useState<number | null>(null);
  const [pendingProposals, setPendingProposals] = useState(0);
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
    if (session.status !== "out" || window.location.pathname.startsWith("/login")) return;
    const next = safeNextPath(`${window.location.pathname}${window.location.search}${window.location.hash}`);
    const params = new URLSearchParams();
    if (session.ended) params.set("ended", "1");
    if (next) params.set("next", next);
    const query = params.toString();
    router.replace(query ? `/login?${query}` : "/login");
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

  useEffect(() => {
    if (!current || current.kind !== "docker") {
      setStackTotal(null);
      return;
    }
    let cancelled = false;
    void api<Page<unknown>>(`/api/endpoints/${current.id}/stacks?limit=1`)
      .then((body) => {
        if (!cancelled) setStackTotal(body.total);
      })
      .catch(() => {
        if (!cancelled) setStackTotal(null);
      });
    return () => {
      cancelled = true;
    };
  }, [current?.id, current?.kind, pathname]);

  useEffect(() => {
    if (session.status !== "in") return;
    let cancelled = false;
    void api<{ items: { status: string }[] }>("/api/proposals")
      .then((body) => {
        if (!cancelled) setPendingProposals(body.items.filter((item) => item.status === "pending").length);
      })
      .catch(() => {
        if (!cancelled) setPendingProposals(0);
      });
    return () => {
      cancelled = true;
    };
  }, [session.status, pathname]);

  if (session.status === "checking") return <Gate title="Checking session" />;
  if (session.status === "error") {
    return <Gate title="The Pisces API did not answer within 10 seconds." onRetry={() => void session.refresh()} />;
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
    if (key === "stacks") return stackTotal ?? undefined;
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
          <Link href="/home" className="brand">{open ? "Pisces" : "P"}</Link>
          <nav className="nav" aria-label="Primary">
            <NavLink href="/home" icon="home" label="Home" active={pathname === "/home"} collapsed={collapsed} />
            <EnvSwitcher
              current={current}
              collapsed={collapsed}
              endpoints={endpoints}
              down={down}
              pathname={pathname}
            />
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
            {open ? <div className="nav-group-label">AI & Security</div> : null}
            <NavLink href="/ai-access" icon="user" label="AI access" active={pathname === "/ai-access"} collapsed={collapsed} />
            <NavLink
              href="/ai-access/proposals"
              icon="eye"
              label="Proposals"
              active={pathname.startsWith("/ai-access/proposals")}
              collapsed={collapsed}
              count={pendingProposals > 0 ? pendingProposals : undefined}
            />
          </nav>
        </aside>
        <div className="main">
          <header className="page-header">
            <IconButton name="sidebar" label="Toggle sidebar" onClick={toggleSidebar} />
            <span className="header-rule" aria-hidden="true" />
            <HeaderCrumbs crumbs={crumbs} />
            <div className="header-spacer" />
            <div className="popover header-popover">
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
                <span className="header-user-name">{session.username}</span>
                <Icon name="chevron" />
              </button>
              {menu ? (
                <div id={USER_MENU_ID} ref={menuRef} className="menu" role="menu" onKeyDown={onMenuKeyDown}>
                  <div className="menu-user" aria-hidden="true">{session.username}</div>
                  <div className="menu-note">Signed in · 8h cookie session</div>
                  <button type="button" role="menuitem" tabIndex={-1} onClick={() => void signOut()}><Icon name="sign-out" />Sign out</button>
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

function HeaderCrumbs({ crumbs }: { crumbs: Crumb[] }) {
  return (
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
  const { setCrumbs, current } = useConsole();
  const pathname = usePathname();
  const scoped = withEndpointCrumbs(current, crumbs, pathname);
  const serialized = JSON.stringify(scoped);
  const latest = useRef(scoped);
  latest.current = scoped;
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
      aria-label={count != null ? `${label}, ${count}` : label}
      title={count != null ? `${label} (${count})` : label}
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

function EnvSwitcher({
  current,
  collapsed,
  endpoints,
  down,
  pathname,
}: {
  current?: Endpoint;
  collapsed: boolean;
  endpoints: Endpoint[];
  down: Record<string, boolean>;
  pathname: string;
}) {
  const router = useRouter();
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [openMenu, setOpenMenu] = useState(false);
  const [box, setBox] = useState<{ top: number; left: number; width: number } | null>(null);
  const label = current ? current.name : "Choose environment";
  const icon = current ? (current.kind === "kubernetes" ? "kubernetes" : "docker") : "home";

  function place() {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.max(240, rect.width);
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    setBox({ top: rect.bottom + 4, left, width });
  }

  useEffect(() => { setOpenMenu(false); }, [pathname]);

  useEffect(() => {
    if (!openMenu) return;
    place();
    function onDoc(event: MouseEvent) {
      const target = event.target as Node;
      if (buttonRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpenMenu(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpenMenu(false);
    }
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [openMenu]);

  return (
    <div className="env-switcher-wrap">
      <button
        ref={buttonRef}
        type="button"
        className="env-switcher"
        aria-label={`Environment: ${label}`}
        aria-haspopup="menu"
        aria-expanded={openMenu}
        title={label}
        onClick={() => {
          if (openMenu) setOpenMenu(false);
          else {
            place();
            setOpenMenu(true);
          }
        }}
      >
        <Icon name={icon} />
        {collapsed ? null : (
          <>
            <span className="env-switcher-label">{label}</span>
            <Icon name="chevron" />
          </>
        )}
      </button>
      {openMenu && box ? (
        <div
          ref={menuRef}
          className="menu env-menu"
          role="menu"
          style={{ position: "fixed", top: box.top, left: box.left, width: box.width, right: "auto" }}
        >
          {endpoints.length === 0 ? <div className="menu-note">No environments yet.</div> : null}
          {endpoints.map((endpoint) => {
            const isDown = down[endpoint.id] || endpoint.status === "down";
            const href = dockerSectionHref(pathname, current?.id, endpoint.id, endpoint.kind, current?.kind);
            return (
              <button
                key={endpoint.id}
                type="button"
                role="menuitem"
                aria-current={endpoint.id === current?.id ? "true" : undefined}
                onClick={() => {
                  setOpenMenu(false);
                  router.push(href);
                }}
              >
                <Icon name={endpoint.kind === "kubernetes" ? "kubernetes" : "docker"} />
                <i className={`sq ${isDown ? "bad" : "ok"}`} aria-hidden="true" />
                <span className="env-switcher-label">{endpoint.name}</span>
                {endpoint.id === current?.id ? <span aria-hidden="true">✓</span> : null}
              </button>
            );
          })}
          <Link role="menuitem" href="/home" onClick={() => setOpenMenu(false)}>Manage environments</Link>
        </div>
      ) : null}
    </div>
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