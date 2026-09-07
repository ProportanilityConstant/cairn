import { useState } from "react";
import { createBrowserRouter, Link, RouterProvider, useRouteError } from "react-router-dom";
import { Empty, ErrorBanner, Shell, NotFound, RouteError, timeAgo, useAsync, load } from "./ui.js";
import { OverviewPage, ProjectsPage, ProjectDashboardPage } from "./pages/overview.js";
import { ProjectDetailPage, WorkflowDetailPage } from "./pages/WorkflowDetail.js";
import { ExecutionsPage, ExecutionDetailPage, EvidencePage } from "./pages/executions.js";
import { GuidePage } from "./pages/guide.js";

function SettingsPage() {
  const { data: secrets, error, reload } = useAsync(() => api.secrets(), []);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState<string>();
  const [opError, setOpError] = useState<unknown>();

  async function save(): Promise<void> {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) { setSaved("Invalid name: letters, digits, underscores."); return; }
    setOpError(undefined);
    try {
      await api.setSecret(name, value);
      setValue("");
      setSaved(`Secret "${name}" stored (AES-256-GCM, encrypted at rest).`);
      setName("");
      reload();
    } catch (e) { setOpError(e); }
  }

  async function remove(name: string): Promise<void> {
    setOpError(undefined);
    try { await api.deleteSecret(name); reload(); }
    catch (e) { setOpError(e); }
  }

  return (
    <>
      <h1>Settings</h1>
      <p className="page-sub">Server configuration comes from environment variables and the encrypted store — the console never handles your AI keys.</p>

      <h2>Secrets</h2>
      <p className="dim small">Referenced in workflows as <code className="mono">{"{{secrets.NAME}}"}</code> and in HTTP steps via <code className="mono">authRef</code>. Values are encrypted with CAIRN_SECRET_KEY and are never displayed, logged, or returned by the API.</p>
      <div className="card">
        <div className="row">
          <input placeholder="NAME" value={name} onChange={(e) => setName(e.target.value)} aria-label="Secret name" style={{ width: 180 }} />
          <input placeholder="Value" type="password" value={value} onChange={(e) => setValue(e.target.value)} aria-label="Secret value" style={{ width: 260 }} />
          <button className="primary" onClick={() => { void save(); }} disabled={!name || !value}>Store secret</button>
        </div>
        {saved ? <div className="dim small mt">{saved}</div> : null}
      </div>
      <div className="mt">
        {secrets?.length
          ? (
            <div className="card" style={{ padding: 0 }}>
              <table>
                <thead><tr><th>Name</th><th>Created</th><th /></tr></thead>
                <tbody>
                  {secrets.map((s) => (
                    <tr key={s.name}>
                      <td className="mono">{s.name}</td>
                      <td className="dim">{timeAgo(s.createdAt)}</td>
                      <td><button className="small danger" onClick={() => { void remove(s.name); }}>Delete</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
          : <Empty>No secrets stored.</Empty>}
        {opError ? <ErrorBanner error={opError} /> : null}
      </div>

      <h2>AI provider</h2>
      <div className="card">
        <p className="dim small" style={{ margin: 0 }}>Configured via environment variables at server start:</p>
        <pre className="pre mt">{`CAIRN_AI_KIND=local                    # deterministic, offline, no data leaves the machine
CAIRN_AI_KIND=openai-compatible        # OpenAI, Ollama, vLLM, OpenRouter…
CAIRN_AI_BASE_URL=http://localhost:11434/v1
CAIRN_AI_MODEL=llama3.1
CAIRN_AI_KIND=anthropic
CAIRN_AI_API_KEY=sk-ant-…`}</pre>
        <p className="dim small">Cairn never sends workflow data to a provider you have not configured yourself.</p>
      </div>
    </>
  );
}

const router = createBrowserRouter([
  {
    path: "/",
    element: <Shell />,
    errorElement: <Shell><RouteErrorPage /></Shell>,
    children: [
      { index: true, element: <OverviewPage /> },
      { path: "projects", element: <ProjectsPage /> },
      { path: "projects/:projectId", element: <ProjectDetailPage /> },
      { path: "projects/:projectId/dashboard", element: <ProjectDashboardPage /> },
      { path: "workflows/:id", element: <WorkflowDetailPage /> },
      { path: "executions", element: <ExecutionsPage /> },
      { path: "executions/:id", element: <ExecutionDetailPage /> },
      { path: "executions/:id/evidence/:evidenceId", element: <EvidencePage /> },
      { path: "guide", element: <GuidePage /> },
      { path: "settings", element: <SettingsPage /> },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
]);

/** Wraps the router-level 404 so the shell stays visible. */
function NotFoundPage() {
  return <NotFound />;
}

/** Router error boundary content (rendered inside the shell). */
function RouteErrorPage() {
  const err = useRouteError();
  return <RouteError error={err} />;
}

export default function App() {
  return <RouterProvider router={router} />;
}
