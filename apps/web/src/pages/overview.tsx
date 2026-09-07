import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, type Project, type WorkflowDef } from "../api.js";
import { Empty, ErrorBanner, StatusBadge, timeAgo, useAsync } from "../ui.js";

export function OverviewPage() {
  const { data: projects, error } = useAsync(api.projects, []);
  const { data: dash } = useAsync(() => api.dashboard(), []);

  if (error) return <ErrorBanner error={error} />;

  return (
    <>
      <h1>Overview</h1>
      <p className="page-sub">Every number here is computed from stored executions. Nothing is estimated.</p>
      <div className="stat-row">
        <div className="stat"><div className="stat-value">{dash?.totals.executions ?? "—"}</div><div className="stat-label">Executions</div></div>
        <div className="stat"><div className="stat-value" style={{ color: "var(--green)" }}>{dash?.totals.passed ?? "—"}</div><div className="stat-label">Passed</div></div>
        <div className="stat"><div className="stat-value" style={{ color: "var(--red)" }}>{dash?.totals.failed ?? "—"}</div><div className="stat-label">Failed</div></div>
        <div className="stat"><div className="stat-value" style={{ color: "var(--amber)" }}>{dash?.totals.flakySuspects ?? "—"}</div><div className="stat-label">Flaky suspects</div></div>
      </div>

      <h2>Recent executions</h2>
      {dash?.recent.length
        ? <ExecutionTable executions={dash.recent} />
        : <Empty>No executions yet. Create a project, add a workflow, and run it — the <Link to="/guide">Guide</Link> walks through it in five steps.</Empty>}

      <h2>Projects</h2>
      {projects?.length
        ? <div className="row">{projects.map((p) => <Link key={p.id} className="card" style={{ minWidth: 220 }} to={`/projects/${p.id}`}><strong>{p.name}</strong><div className="dim small">{p.description ?? ""}</div></Link>)}</div>
        : <Empty>No projects yet. Create the first one in <Link to="/projects">Projects</Link>.</Empty>}
    </>
  );
}

export function ExecutionTable({ executions }: { executions: { id: string; workflowName: string; status: string; startedAt: string; durationMs?: number; environment: string }[] }) {
  return (
    <div className="card" style={{ padding: 0 }}>
      <table>
        <thead><tr><th>Status</th><th>Workflow</th><th>Environment</th><th>Started</th><th>Duration</th></tr></thead>
        <tbody>
          {executions.map((e) => (
            <tr key={e.id}>
              <td><StatusBadge status={e.status} /></td>
              <td><Link to={`/executions/${e.id}`}>{e.workflowName}</Link></td>
              <td className="mono">{e.environment}</td>
              <td className="dim">{timeAgo(e.startedAt)}</td>
              <td className="mono dim">{e.durationMs != null ? `${e.durationMs}ms` : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ProjectsPage() {
  const { data, error, reload } = useAsync(api.projects, []);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<unknown>();
  const navigate = useNavigate();

  if (error) return <ErrorBanner error={error} />;
  const projects = data ?? [];

  async function create(): Promise<void> {
    if (!name.trim()) return;
    setCreating(true); setCreateError(undefined);
    try {
      const p = await api.createProject(name.trim(), description || undefined);
      reload();
      setName(""); setDescription("");
      navigate(`/projects/${p.id}`);
    } catch (e) { setCreateError(e); }
    finally { setCreating(false); }
  }

  return (
    <>
      <h1>Projects</h1>
      <p className="page-sub">A project groups workflows, executions, and secrets.</p>

      <div className="card mt">
        <div className="row">
          <input placeholder="Project name" value={name} onChange={(e) => setName(e.target.value)} aria-label="Project name" style={{ minWidth: 240 }} />
          <input placeholder="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} aria-label="Project description" style={{ minWidth: 300 }} />
          <button className="primary" onClick={() => { void create(); }} disabled={creating || !name.trim()}>Create project</button>
        </div>
        {createError ? <div className="mt"><ErrorBanner error={createError} /></div> : null}
      </div>

      <h2>Existing</h2>
      {projects.length
        ? (
          <div className="card" style={{ padding: 0 }}>
            <table>
              <thead><tr><th>Name</th><th>Description</th><th>Created</th></tr></thead>
              <tbody>
                {projects.map((p: Project) => (
                  <tr key={p.id}>
                    <td><Link to={`/projects/${p.id}`}>{p.name}</Link></td>
                    <td className="dim">{p.description ?? "—"}</td>
                    <td className="dim">{timeAgo(p.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
        : <Empty>No projects. Create the first one above.</Empty>}
    </>
  );
}

export function ProjectDashboardPage() {
  const { projectId } = useParams();
  const { data, error } = useAsync(() => api.dashboard(projectId), [projectId]);
  if (error) return <ErrorBanner error={error} />;
  const d = data;
  return (
    <>
      <h1>Project dashboard</h1>
      <p className="page-sub">Computed from this project's stored executions.</p>
      <div className="stat-row">
        <div className="stat"><div className="stat-value">{d?.totals.executions ?? "—"}</div><div className="stat-label">Executions</div></div>
        <div className="stat"><div className="stat-value" style={{ color: "var(--green)" }}>{d?.totals.passed ?? "—"}</div><div className="stat-label">Passed</div></div>
        <div className="stat"><div className="stat-value" style={{ color: "var(--red)" }}>{d?.totals.failed ?? "—"}</div><div className="stat-label">Failed</div></div>
        <div className="stat"><div className="stat-value" style={{ color: "var(--amber)" }}>{d?.totals.flakySuspects ?? "—"}</div><div className="stat-label">Flaky suspects</div></div>
      </div>
      <h2>Recent</h2>
      {d?.recent.length ? <ExecutionTable executions={d.recent} /> : <Empty>No executions for this project yet.</Empty>}
    </>
  );
}

export { WorkflowDetailPage } from "./WorkflowDetail.js";
export type { WorkflowDef };
