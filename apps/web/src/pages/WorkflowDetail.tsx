import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, TERMINAL_STATUSES, type StepDef, type StepKindInfo, type WorkflowDef } from "../api.js";
import { Empty, ErrorBanner, KindBadge, load, useAsync } from "../ui.js";

export function ProjectDetailPage() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { data: workflows, error, reload } = useAsync(() => api.workflows(projectId!), [projectId]);
  const [creating, setCreating] = useState(false);
  const [intent, setIntent] = useState("");
  const [planNote, setPlanNote] = useState<string>();
  const [planning, setPlanning] = useState(false);

  async function createBlank(): Promise<void> {
    if (!projectId) return;
    const def: WorkflowDef = {
      id: `wf_${Math.random().toString(36).slice(2, 8)}`,
      name: "New workflow",
      version: 1,
      projectId,
      steps: [{ id: "first_step", name: "First step", kind: "http.request", config: { url: "http://localhost:8080/", assertions: [{ target: "status", op: "eq", value: 200 }] } }],
      variables: {},
    };
    const created = await api.createWorkflow(projectId, def);
    navigate(`/workflows/${created.id}`);
  }

  async function createFromIntent(): Promise<void> {
    if (!projectId || intent.trim().length < 8) return;
    setPlanning(true);
    setPlanNote(undefined);
    try {
      const result = await api.plan(projectId, intent.trim());
      const created = await api.createWorkflow(projectId, result.workflow);
      const rationales = result.draft.steps.filter((s) => s.rationale).map((s) => `${s.id}: ${s.rationale}`).join("\n");
      if (rationales) setPlanNote(`Planned by ${result.provider}. Step rationale:\n${rationales}`);
      navigate(`/workflows/${created.id}`);
    } catch (e) {
      setPlanNote(e instanceof Error ? e.message : String(e));
    } finally {
      setPlanning(false);
    }
  }

  if (error) return <ErrorBanner error={error} />;
  const list = workflows ?? [];

  return (
    <>
      <h1>Workflows</h1>
      <p className="page-sub">Describe intent to have a model draft a workflow (edit everything afterward), or start from a blank editor.</p>

      <div className="card">
        <label htmlFor="intent">Describe what to test or automate</label>
        <textarea id="intent" rows={3} style={{ width: "100%" }} placeholder="e.g. Check that GET /api/health on my staging service returns 200 with {status: 'ok'} within 500ms"
          value={intent} onChange={(e) => setIntent(e.target.value)} />
        <div className="row mt">
          <button className="primary" onClick={() => { void createFromIntent(); }} disabled={planning || intent.trim().length < 8}>
            {planning ? "Planning…" : "Draft with AI"}
          </button>
          <button onClick={() => { void createBlank(); }} disabled={creating}>Blank workflow</button>
          <span className="faint small">The draft is validated by the same engine rules as hand-written workflows — invalid steps are dropped, never guessed.</span>
        </div>
        {planNote ? <div className="hypothesis pre mt">{planNote}</div> : null}
      </div>

      <h2>Existing</h2>
      {list.length
        ? (
          <div className="card" style={{ padding: 0 }}>
            <table>
              <thead><tr><th>Name</th><th>Version</th><th>Updated</th></tr></thead>
              <tbody>
                {list.map((w) => (
                  <tr key={w.id}>
                    <td><Link to={`/workflows/${w.id}`}>{w.name}</Link></td>
                    <td className="mono">v{w.version}</td>
                    <td className="dim">{new Date(w.updatedAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
        : <Empty>No workflows yet in this project.</Empty>}
      <div className="mt"><button onClick={() => { void load(() => api.workflows(projectId!), () => {}, () => {}); reload(); }}>Refresh</button></div>
    </>
  );
}

export function WorkflowDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data, error, reload } = useAsync(() => api.workflow(id!), [id]);
  const { data: kinds } = useAsync(() => api.stepKinds(), []);
  const [defText, setDefText] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>();
  const [running, setRunning] = useState(false);
  const [environment, setEnvironment] = useState("default");

  if (error) return <ErrorBanner error={error} />;
  if (!data) return null;
  const wf = data.def;

  async function run(): Promise<void> {
    if (!id) return;
    setRunning(true);
    try {
      const { executionId } = await api.runWorkflow(id, environment, {});
      navigate(`/executions/${executionId}`);
    } finally { setRunning(false); }
  }

  async function save(): Promise<void> {
    if (!defText || !id) return;
    setSaving(true); setSaveError(undefined);
    try {
      const parsed = JSON.parse(defText) as WorkflowDef;
      await api.updateWorkflow(id, parsed);
      reload();
    } catch (e) {
      setSaveError(e);
    } finally { setSaving(false); }
  }

  return (
    <>
      <div className="row spread">
        <div>
          <h1>{wf.name} <span className="faint mono">v{wf.version}</span></h1>
          <p className="page-sub">{wf.description ?? "No description."}</p>
        </div>
        <div className="row">
          <label htmlFor="env" className="small">Environment</label>
          <input id="env" value={environment} onChange={(e) => setEnvironment(e.target.value)} style={{ width: 120 }} />
          <button className="primary" onClick={() => { void run(); }} disabled={running}>{running ? "Starting…" : "Run workflow"}</button>
        </div>
      </div>

      <h2>Steps</h2>
      <div className="card">
        {wf.steps.map((s: StepDef, i) => (
          <div key={s.id} className="step-editor">
            <div className="row spread">
              <div className="row">
                <strong>{i + 1}. {s.name}</strong>
                <KindBadge kind={s.kind} />
                {s.condition ? <span className="badge">when: {s.condition}</span> : null}
                {s.retries ? <span className="badge">retries: {s.retries}</span> : null}
              </div>
              <span className="mono faint">{s.id}</span>
            </div>
            <pre className="pre" style={{ marginTop: 8 }}>{JSON.stringify(s.config, null, 2)}</pre>
          </div>
        ))}
      </div>

      {wf.variables && Object.keys(wf.variables).length > 0
        ? (
          <>
            <h2>Variables</h2>
            <div className="card"><pre className="pre">{JSON.stringify(wf.variables, null, 2)}</pre></div>
          </>
        )
        : null}

      <h2>Edit definition</h2>
      <p className="dim small">Raw JSON, validated server-side with the same rules the engine enforces. Version bumps automatically on save.</p>
      <textarea rows={18} style={{ width: "100%" }} defaultValue={JSON.stringify(wf, null, 2)} onChange={(e) => setDefText(e.target.value)} aria-label="Workflow definition JSON" />
      {saveError ? <ErrorBanner error={saveError} /> : null}
      <div className="row mt">
        <button className="primary" onClick={() => { void save(); }} disabled={saving || !defText}>Save changes</button>
        <button onClick={() => { void api.deleteWorkflow(id!); navigate(`/projects/${wf.projectId}`); }} className="danger">Delete workflow</button>
      </div>
    </>
  );
}

export { TERMINAL_STATUSES };
