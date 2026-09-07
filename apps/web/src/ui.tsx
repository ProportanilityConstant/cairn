import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, Outlet, useNavigate, useParams } from "react-router-dom";
import { api, ApiError, TERMINAL_STATUSES } from "./api.js";

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge ${status}`}>{status}</span>;
}

export function KindBadge({ kind }: { kind: string }) {
  return <span className="badge kind">{kind}</span>;
}

export function ErrorBanner({ error }: { error: unknown }) {
  if (!error) return null;
  const e = error as ApiError;
  return (
    <div className="error-banner" role="alert">
      <strong>{e.code ?? "Error"}</strong> — {e.message}
      {e.hint ? <div className="hint">{e.hint}</div> : null}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <div className="loading" role="status" aria-live="polite">
      <div className="stone-pulse" /><div className="stone-pulse" /><div className="stone-pulse" />
      <span className="small">{label}…</span>
    </div>
  );
}

export function NotFound({ path }: { path?: string }) {
  return (
    <div className="notfound">
      <div className="splash-stack" style={{ marginBottom: 20 }} aria-hidden="true">
        <div className="stone s1" style={{ animation: "none", opacity: 1, transform: "none" }} />
        <div className="stone s2" style={{ animation: "none", opacity: 1, transform: "none" }} />
        <div className="stone s3" style={{ animation: "none", opacity: 1, transform: "none", width: 22 }} />
      </div>
      <h1>404</h1>
      <p className="dim">Nothing is stacked at <code className="mono">{path ?? "this address"}</code>.</p>
      <p><Link to="/">Back to the overview</Link></p>
    </div>
  );
}

/** Router error boundary: renders a real page, never the raw router dump. */
export function RouteError({ error }: { error: unknown }) {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div className="route-error">
      <ErrorBanner error={{ code: "E_ROUTE", message: msg, hint: "If this keeps happening, restart the server and reload the console." }} />
      <p><Link to="/">Back to the overview</Link></p>
    </div>
  );
}

export function usePolling<T>(fn: () => Promise<T>, active: boolean, intervalMs = 1500): T | undefined {
  const [data, setData] = useState<T>();
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const d = await fn();
        if (!cancelled) setData(d);
      } catch { /* transient poll errors are surfaced by initial load */ }
      if (!cancelled) timer = setTimeout(tick, intervalMs);
    };
    void tick();
    return () => { cancelled = true; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, intervalMs]);
  return data;
}

export async function load<T>(fn: () => Promise<T>, set: (t: T) => void, fail: (e: unknown) => void): Promise<void> {
  try { set(await fn()); } catch (e) { fail(e); }
}

export function timeAgo(iso: string): string {
  const s = Math.max(1, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function Shell({ children }: { children?: ReactNode }) {
  const [health, setHealth] = useState<{ ai: string; version: string }>();
  useEffect(() => { void load(api.health, setHealth, () => {}); }, []);
  const { projectId } = useParams();

  return (
    <>
      <nav className="sidebar" aria-label="Main navigation">
        <div className="brand">
          <img src="/logo.svg" alt="" width={30} height={30} />
          <div>
            <div className="brand-name">cairn</div>
            <div className="brand-sub">Evidence-first QA</div>
          </div>
        </div>
        <div className="nav">
          <NavLink to="/" end>Overview</NavLink>
          <NavLink to="/projects">Projects</NavLink>
          <NavLink to="/executions">Executions</NavLink>
          {projectId ? <div className="nav-section">Project</div> : null}
          {projectId ? <NavLink to={`/projects/${projectId}`} end>Workflows</NavLink> : null}
          {projectId ? <NavLink to={`/projects/${projectId}/dashboard`}>Dashboard</NavLink> : null}
          <div className="nav-section">System</div>
          <NavLink to="/guide">Guide</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </div>
        <div style={{ marginTop: "auto", padding: "12px 16px" }} className="faint small">
          v{health?.version ?? "…"} · AI: {health ? (health.ai === "none" ? "not set (local heuristics)" : health.ai) : "connecting…"}
        </div>
      </nav>
      <main className="main"><div className="content">{children ?? <Outlet />}</div></main>
    </>
  );
}

export function useProjectId(): string {
  return useParams<{ projectId: string }>().projectId ?? "";
}

/** Hook for one-shot loading with error state. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): { data?: T; error?: unknown; reload: () => void } {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<unknown>();
  const [n, setN] = useState(0);
  useEffect(() => {
    let cancelled = false;
    fn().then((d) => { if (!cancelled) { setData(d); setError(undefined); } }).catch((e) => { if (!cancelled) setError(e); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return { data, error, reload: () => setN((x) => x + 1) };
}

export function useNavigateToExecution() {
  const navigate = useNavigate();
  return (id: string) => navigate(`/executions/${id}`);
}
