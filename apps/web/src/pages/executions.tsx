import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, TERMINAL_STATUSES, type EvidenceMeta, type Execution } from "../api.js";
import { Empty, ErrorBanner, Loading, StatusBadge, useAsync, usePolling } from "../ui.js";
import { ExecutionTable } from "./overview.js";

export function ExecutionsPage() {
  const { data, error } = useAsync(() => api.executions(), []);
  if (error) return <ErrorBanner error={error} />;
  const list = data ?? [];
  return (
    <>
      <h1>Executions</h1>
      <p className="page-sub">Every run, with its full evidence trail.</p>
      {list.length ? <ExecutionTable executions={list} /> : <Empty>No executions yet.</Empty>}
    </>
  );
}

export function ExecutionDetailPage() {
  const { id } = useParams();
  const [poll, setPoll] = useState(true);
  const polled = usePolling<Execution>(() => api.execution(id!), poll && !!id, 1200);
  const { data: loaded, error: loadError } = useAsync(() => api.execution(id!), [id]);
  const execution = polled ?? loaded;

  if (loadError) return <ErrorBanner error={loadError} />;
  if (!execution) return <Loading label="Loading execution" />;
  const terminal = TERMINAL_STATUSES.includes(execution.status);
  if (terminal && poll) setPoll(false);

  return (
    <>
      <div className="row spread">
        <div>
          <h1><Link to={`/workflows/${execution.workflowId}`}>{execution.workflowName}</Link> <span className="faint mono">v{execution.workflowVersion}</span></h1>
          <p className="page-sub mono">{execution.id}</p>
        </div>
        <div className="row">
          <StatusBadge status={execution.status} />
          {!terminal ? <button className="small danger" onClick={() => { void api.cancelExecution(execution.id); }}>Cancel</button> : null}
        </div>
      </div>

      <div className="stat-row">
        <div className="stat"><div className="stat-value">{execution.environment}</div><div className="stat-label">Environment</div></div>
        <div className="stat"><div className="stat-value">{execution.durationMs != null ? `${execution.durationMs}ms` : "—"}</div><div className="stat-label">Duration</div></div>
        <div className="stat"><div className="stat-value">{execution.trigger}</div><div className="stat-label">Trigger</div></div>
      </div>

      {execution.failures.length > 0 ? <FailurePanel executionId={execution.id} /> : null}

      <h2>Step timeline</h2>
      <div className="timeline">
        {execution.steps.map((s) => (
          <div key={s.stepId} className={`tl-step ${s.status}`}>
            <div />
            <div>
              <div className="row">
                <strong>{s.name}</strong>
                <span className="badge kind">{s.kind}</span>
                <StatusBadge status={s.status} />
                {s.attempts > 1 ? <span className="badge">{s.attempts} attempts</span> : null}
              </div>
              {s.skippedReason ? <div className="dim small mt">{s.skippedReason}</div> : null}
              {s.error ? (
                <div className="facts mt">
                  <div><strong className="mono">{s.error.code}</strong> — {s.error.message}</div>
                  {s.error.hint ? <div className="dim small mt">{s.error.hint}</div> : null}
                </div>
              ) : null}
              {s.evidenceIds.length > 0 ? <EvidenceList executionId={execution.id} ids={s.evidenceIds} /> : null}
            </div>
            <div className="mono faint small">{s.durationMs != null ? `${s.durationMs}ms` : ""}</div>
          </div>
        ))}
      </div>
    </>
  );
}

function EvidenceList({ executionId, ids }: { executionId: string; ids: string[] }) {
  const { data } = useAsync(() => api.evidence(executionId), [executionId]);
  if (!data) return null;
  const relevant = data.filter((e: EvidenceMeta) => ids.includes(e.id));
  if (relevant.length === 0) return null;
  return (
    <div className="mt">
      {relevant.map((e) => (
        <div key={e.id} className="row small" style={{ marginBottom: 4 }}>
          <Link to={`/executions/${executionId}/evidence/${e.id}`}>{e.label ?? e.id}</Link>
          <span className="badge">{e.type}</span>
          <span className="faint">{e.size} bytes</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Failure intelligence panel. The contract: observed FACTS first (from the
 * engine), then the AI hypothesis clearly labeled with provider and
 * confidence. A guess is never rendered as truth.
 */
function FailurePanel({ executionId }: { executionId: string }) {
  const { data, error } = useAsync(() => api.execution(executionId), [executionId]);
  const [analysis, setAnalysis] = useState<{ failure: unknown; ai: { provider: string; summary: string; likelyCause: string; suggestedInvestigation: string[]; confidence: string; evidenceRefs: string[] } }>();
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisError, setAnalysisError] = useState<unknown>();

  if (!data || data.failures.length === 0) return null;
  const failure = data.failures[0]!;

  async function analyze(): Promise<void> {
    setAnalyzing(true); setAnalysisError(undefined);
    try { setAnalysis(await api.analyze(executionId)); }
    catch (e) { setAnalysisError(e); }
    finally { setAnalyzing(false); }
  }

  return (
    <>
      <h2>Failure</h2>
      <div className="facts">
        <div><strong>Observed facts</strong></div>
        <div className="mt"><span className="mono">{failure.code}</span> — {failure.message}</div>
        {failure.assertion ? (
          <table className="mt" style={{ maxWidth: 640 }}>
            <tbody>
              <tr><td className="dim">Expected</td><td className="mono">{failure.assertion.expected}</td></tr>
              <tr><td className="dim">Observed</td><td className="mono">{failure.assertion.observed}</td></tr>
              <tr><td className="dim">Where</td><td className="mono">{failure.assertion.target} {failure.assertion.op}</td></tr>
            </tbody>
          </table>
        ) : null}
        {failure.hint ? <div className="dim small mt">Engine hint: {failure.hint}</div> : null}
      </div>

      {analysis ? (
        <div className="hypothesis">
          <div className="row spread">
            <div><strong>Hypothesis</strong> <span className="badge">provider: {analysis.ai.provider}</span> <span className={`badge confidence-${analysis.ai.confidence}`}>confidence: {analysis.ai.confidence}</span></div>
          </div>
          <div className="mt">{analysis.ai.summary}</div>
          <div className="mt"><strong>Likely cause:</strong> {analysis.ai.likelyCause}</div>
          <div className="mt"><strong>Suggested investigation</strong>
            <ul style={{ margin: "4px 0 0" }}>
              {analysis.ai.suggestedInvestigation.map((s, i) => <li key={i}>{s}</li>)}
            </ul>
          </div>
          <div className="faint small mt">This is an inference, not a fact. Verify against the evidence above.</div>
        </div>
      ) : (
        <div className="row mt">
          <button className="primary" onClick={() => { void analyze(); }} disabled={analyzing}>
            {analyzing ? "Analyzing…" : "Analyze failure"}
          </button>
          <span className="faint small">Runs against the configured AI provider (deterministic local heuristics if none is set).</span>
        </div>
      )}
      {analysisError ? <ErrorBanner error={analysisError} /> : null}
      {error ? <ErrorBanner error={error} /> : null}
    </>
  );
}

export function EvidencePage() {
  const { id, evidenceId } = useParams();
  const { data: meta, error } = useAsync(async () => {
    const all = await api.evidence(id!);
    return all.find((e) => e.id === evidenceId);
  }, [id, evidenceId]);
  const { data: body, error: bodyError } = useAsync(async () => {
    const res = await fetch(`/api/executions/${id}/evidence/${evidenceId}`);
    if (!res.ok) throw new Error(`Evidence could not be loaded (HTTP ${res.status})`);
    return await res.json();
  }, [id, evidenceId]);

  if (error) return <ErrorBanner error={error} />;
  if (!meta) return <Loading label="Loading evidence" />;

  return (
    <>
      <h1>Evidence <span className="badge kind">{meta.type}</span></h1>
      <p className="page-sub"><Link to={`/executions/${id}`}>Back to execution</Link> · step <span className="mono">{meta.stepId}</span> · {meta.size} bytes</p>
      {meta.contentType.startsWith("image/") && meta.type === "screenshot"
        ? <img src={`/api/executions/${id}/evidence/${evidenceId}`} alt={meta.label ?? "screenshot"} style={{ maxWidth: "100%", border: "1px solid var(--border)", borderRadius: 8 }} />
        : bodyError
          ? <ErrorBanner error={bodyError} />
          : <pre className="pre">{formatEvidenceBody(body)}</pre>}
    </>
  );
}

/** The API returns the evidence row; the payload lives in `data` as text. Parse and pretty-print it. */
function formatEvidenceBody(body: unknown): string {
  if (body == null) return "Loading…";
  if (typeof body === "object" && "data" in body) {
    const data = (body as { data?: unknown }).data;
    if (typeof data !== "string") return JSON.stringify(data, null, 2);
    try { return JSON.stringify(JSON.parse(data), null, 2); } catch { return data; }
  }
  return typeof body === "string" ? body : JSON.stringify(body, null, 2);
}
