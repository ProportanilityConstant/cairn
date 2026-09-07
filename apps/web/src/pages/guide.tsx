import { Link } from "react-router-dom";

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="step-editor">
      <div className="row">
        <span className="badge" style={{ background: "var(--accent-dim)", borderColor: "var(--accent-dim)", color: "#fff" }}>{n}</span>
        <strong>{title}</strong>
      </div>
      <div className="mt" style={{ lineHeight: 1.7 }}>{children}</div>
    </div>
  );
}

export function GuidePage() {
  return (
    <>
      <h1>Guide</h1>
      <p className="page-sub">From zero to your first verified run. Follow the steps in order — every command is copy-paste ready.</p>

      <h2>What Cairn is</h2>
      <p className="dim" style={{ maxWidth: 760 }}>
        Cairn runs your workflows against real services and keeps <strong>evidence</strong> for every step: HTTP exchanges,
        assertions with expected vs. observed values, and structured failures. When something breaks, an AI layer proposes a
        <em> hypothesis</em> — always labeled with its provider and confidence, always below the observed facts. AI output is
        validated like hand-written configuration: nothing is guessed, nothing is executed on trust.
      </p>

      <h2>Quickstart</h2>
      <Step n={1} title="Start a demo target (any HTTP service you want to watch)">
        <p className="dim small" style={{ margin: 0 }}>For a first look, use the bundled demo service:</p>
        <pre className="pre mt">{`node examples/demo-app/server.mjs
# Demo target listening on http://127.0.0.1:5176`}</pre>
      </Step>
      <Step n={2} title="Start the Cairn server">
        <pre className="pre">{`npm install && npm run build
CAIRN_SECRET_KEY="change-me-to-32+random-chars" \\
CAIRN_DATA_DIR="./data" \\
npm start
# → console at http://127.0.0.1:5175`}</pre>
        <p className="dim small" style={{ margin: 0 }}>
          <code className="mono">CAIRN_SECRET_KEY</code> encrypts the secret store (AES-256-GCM). Losing the key means losing
          stored secrets — the data directory stays intact otherwise.
        </p>
      </Step>
      <Step n={3} title="Create a project and a workflow">
        Go to <Link to="/projects">Projects</Link>, create one, then either describe what to check in plain language and press
        <strong> Draft with AI</strong> (a model drafts it; you edit everything afterward), or start from a blank editor. The
        bundled example lives at <code className="mono">examples/demo-app/demo-workflow.json</code> — it probes the demo
        service, creates an order, and verifies it appears.
      </Step>
      <Step n={4} title="Run it and read the evidence">
        Press <strong>Run workflow</strong>. The execution page shows a live step timeline; every HTTP step records its
        exchange as evidence you can open. Green means every assertion held against a real response — Cairn never
        fabricates a pass.
      </Step>
      <Step n={5} title="Watch failure intelligence handle a real breakage">
        Break the target on purpose (<code className="mono">curl http://127.0.0.1:5176/chaos</code>), run the workflow again,
        and open the failure panel: observed facts first (assertion, expected vs. observed, evidence), then an AI hypothesis
        with provider and confidence. Fix the target (<code className="mono">curl http://127.0.0.1:5176/heal</code>) and re-run.
      </Step>

      <h2>Concepts</h2>
      <div className="card">
        <table>
          <tbody>
            <tr><td className="mono">Workflow</td><td>A versioned list of steps + variables. Editing bumps the version; old executions keep pointing at the version that ran.</td></tr>
            <tr><td className="mono">Step</td><td>One action: <code className="mono">http.request</code>, <code className="mono">assert</code>, <code className="mono">browser.*</code> (if Playwright is installed), <code className="mono">delay</code>, <code className="mono">note</code>. Each has a retry count, timeout, optional condition.</td></tr>
            <tr><td className="mono">Action class</td><td>Every step kind maps to a capability class — <code className="mono">read</code>, <code className="mono">safe_write</code>, <code className="mono">network</code>, <code className="mono">authenticated</code>, <code className="mono">destructive</code> — enforced by the policy engine independently of any AI plan.</td></tr>
            <tr><td className="mono">Evidence</td><td>Immutable artifacts captured during execution: HTTP exchanges, assertion results, screenshots. Open any step's evidence from the timeline.</td></tr>
            <tr><td className="mono">Environment</td><td>A free-form label on a run (<code className="mono">staging</code>, <code className="mono">production</code>…). Dashboards can filter by project; executions keep their environment tag.</td></tr>
          </tbody>
        </table>
      </div>

      <h2>AI providers</h2>
      <div className="card">
        <p className="dim small" style={{ margin: "0 0 8px" }}>Set at server start via environment variables. With none set, Cairn uses its built-in deterministic local heuristics — the product stays fully functional offline, and every response names its provider.</p>
        <pre className="pre">{`CAIRN_AI_KIND=local                  # built-in, offline, deterministic
CAIRN_AI_KIND=openai-compatible      # OpenAI, Ollama, vLLM, OpenRouter…
CAIRN_AI_BASE_URL=http://localhost:11434/v1
CAIRN_AI_MODEL=llama3.1
CAIRN_AI_API_KEY=sk-…

CAIRN_AI_KIND=anthropic
CAIRN_AI_API_KEY=sk-ant-…`}</pre>
        <p className="dim small" style={{ margin: 0 }}>Secrets go in Settings or <code className="mono">CAIRN_AI_API_KEY</code> — never into workflows. Referenced as <code className="mono">{"{{secrets.NAME}}"}</code>.</p>
      </div>

      <h2>Troubleshooting</h2>
      <div className="card">
        <table>
          <tbody>
            <tr><td className="mono">Console loads but numbers are "—"</td><td>The server API is unreachable. Check the server process is up and that Vite dev proxy (or the static host) points at it.</td></tr>
            <tr><td className="mono">Run stays queued</td><td>The execution queue allows 2 concurrent runs; others wait. If it never starts, check the server log for engine errors.</td></tr>
            <tr><td className="mono">E_ASSERTION with expected/observed</td><td>Not an error in Cairn — the service under test returned something other than expected. Open the step's evidence to see the actual exchange.</td></tr>
            <tr><td className="mono">Workflow validation failed</td><td>The definition breaks engine rules (duplicate step ids, unknown kinds, unsafe expressions). The error names the exact field and step.</td></tr>
            <tr><td className="mono">Secret "does not exist"</td><td>Reference <code className="mono">{"{{secrets.NAME}}"}</code> must match a stored name exactly (case-sensitive) — store it first in Settings.</td></tr>
          </tbody>
        </table>
      </div>

      <p className="dim small mt">The full written guide — configuration reference, expression language, CI setup — lives in the repo at <code className="mono">docs/user-guide.md</code>.</p>
    </>
  );
}
