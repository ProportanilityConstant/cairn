# Cairn User Guide

Everything you need to go from install to daily use — written so you never hit an unexplained error. For architecture internals see [architecture.md](architecture.md); for every configuration variable see [configuration.md](configuration.md).

---

## 1. What Cairn is

Cairn is an evidence-first automation and QA platform. It runs **workflows** — ordered steps like HTTP requests, assertions, delays, and browser checks — against real services and stores **evidence** for every step: the actual HTTP exchanges, assertion results with expected vs. observed values, and screenshots when browser steps are used.

The AI layer (optional) does two jobs: drafting workflows from plain-language intent, and proposing a **hypothesis** when a run fails. Both are strictly bounded:

- AI-drafted workflows pass through the exact same validation as hand-written ones. Invalid steps are dropped, never executed.
- Failure analysis is always rendered *below* the observed facts and always labeled with its provider and confidence. A hypothesis is never shown as truth.

With no AI provider configured, Cairn uses a built-in deterministic local-heuristics provider. Nothing leaves your machine, and every response names its provider.

---

## 2. Install

Requirements: Node.js 20+ or Bun 1.1+ (the repo develops on either), npm.

```bash
git clone https://github.com/<your-org>/cairn.git
cd cairn
npm install
npm run build        # type-checks and builds all packages + apps
npm run test         # runs the full test suite
```

Or with Docker:

```bash
docker compose up --build
# console at http://127.0.0.1:5175
```

---

## 3. Start the server

```bash
CAIRN_SECRET_KEY="0123456789abcdef0123456789abcdef" \
CAIRN_DATA_DIR="./data" \
npm start
```

The boot banner tells you everything you need:

```
   /\      cairn v0.1.0 — evidence-first automation & QA
  /  \     console   http://127.0.0.1:5175
 / /\ \    data       /path/to/data
/_/  \_\   ai          local heuristics (built-in, offline)
```

Open the console URL. First run shows an intentionally empty overview — every number in Cairn is computed from stored executions, so there are no placeholder values.

### Environment variables that matter

| Variable | Purpose |
|---|---|
| `CAIRN_SECRET_KEY` | Encrypts the secret store (AES-256-GCM). Required in production. Losing it means losing stored secrets, nothing else. |
| `CAIRN_DATA_DIR` | Where the SQLite database and evidence live. Defaults to `./data`. |
| `CAIRN_PORT` / `CAIRN_HOST` | Server bind address. Default `5175` on all interfaces. |
| `CAIRN_AI_KIND` | `local` (default), `openai-compatible`, or `anthropic`. |
| `CAIRN_AI_API_KEY` / `CAIRN_AI_BASE_URL` / `CAIRN_AI_MODEL` | Provider settings when using a remote model. |
| `CAIRN_API_TOKEN` | If set, all non-GET API calls require `Authorization: Bearer <token>`. |

---

## 4. Your first workflow (five minutes)

1. **Bring up something to test.** The repo ships a demo service: `node examples/demo-app/server.mjs` → `http://127.0.0.1:5176`. Any HTTP service works.
2. **Create a project** in *Projects*. A project groups workflows, executions, and secrets.
3. **Create a workflow.** Two ways:
   - *Draft with AI* — describe the check in plain language ("check that GET /ping returns 200 with a JSON body containing status ok"). The drafted workflow is fully editable.
   - *Blank workflow* — a single HTTP step you build out. Edit the raw JSON at the bottom of the workflow page; it is validated server-side with the engine's own rules, and the error names the exact field if you get something wrong.
4. **Run it** with the *Run workflow* button. The execution page shows a live step timeline; completed steps link to their evidence.
5. **Break it on purpose.** Hit the demo target's `curl http://127.0.0.1:5176/chaos`, run the workflow again, and read the failure panel: observed facts on top, AI hypothesis below. Then `curl http://127.0.0.1:5176/heal` and re-run — that loop is the core of the product.

You can also import the bundled example: the JSON in `examples/demo-app/demo-workflow.json` is a complete workflow definition.

---

## 5. Writing workflows

A workflow definition:

```json
{
  "id": "demo_service_check",
  "name": "Demo service check",
  "version": 1,
  "projectId": "prj_…",
  "variables": { "baseUrl": "http://127.0.0.1:5176" },
  "steps": [
    {
      "id": "probe",
      "name": "Health probe",
      "kind": "http.request",
      "config": {
        "url": "{{baseUrl}}/ping",
        "assertions": [{ "target": "status", "op": "eq", "value": 200 }]
      }
    }
  ]
}
```

### Step kinds

| Kind | Action class | What it does |
|---|---|---|
| `http.request` | `network` | Performs an HTTP call, captures the full exchange as evidence, runs assertions on `status`, `body_json.*` (dotted paths), `headers.*`, response time. |
| `assert` | `read` | Pure assertion over prior step outputs and variables. |
| `browser.open` / `browser.assert` / `browser.close` | `read` / `read` / `read` | Playwright checks (text visible, element present, URL/title). Requires Playwright installed; the steps validate and fail with a clear error if it is not. |
| `delay` | `read` | Waits a fixed duration. |
| `note` | `read` | Writes a note into the execution record. |

### Common step options

- `retries: 2` — retry on failure with a short backoff.
- `timeoutMs: 5000` — per-step timeout; timing out is a terminal, structured failure (`E_TIMEOUT`), never a hang.
- `condition: "steps.probe.ok == true"` — run the step only when the expression is true.
- `allow: ["read", "network"]` — restrict the action classes a step may use; the policy engine enforces this independently of any AI-drafted plan.

### Expressions

Conditions and assertion values support a small, safe expression language: dotted identifiers (`steps.probe.status`), literals, comparisons, and boolean logic. There is **no `eval`** — the parser is hand-written and rejects anything it does not understand with `E_VALIDATION` naming the exact problem.

### Secrets

Store them in *Settings* (or via `PUT /api/secrets/NAME`). Reference as `{{secrets.NAME}}` in config values or via `authRef` for authenticated requests. They are encrypted at rest, masked in every log and API response, and never returned after creation.

---

## 6. Reading executions and failure intelligence

Every execution has:

- **Status** — one of `queued → preparing → running → passed | failed | cancelled | timed_out`. The engine guarantees a terminal status on every path, including engine-level crashes (which surface as a structured `E_INTERNAL` execution, never a zombie run).
- **Step timeline** — per-step status, duration, attempts, and the specific error code + message.
- **Evidence** — open any step's HTTP exchange: real request/response, headers, timing. Screenshots for browser steps.
- **Failure panel** (on failure) —
  1. *Observed facts*: the failing assertion with expected vs. observed, error code, engine hint.
  2. *Hypothesis*: AI analysis labeled `provider · confidence`, with a suggested investigation list, ending in the reminder that it is an inference, not a fact.

Press *Analyze failure* to generate the hypothesis. Without a remote provider it uses the local heuristics — the provider name in the response tells you which one answered, always.

---

## 7. Using AI providers

```bash
# OpenAI-compatible (OpenAI, Ollama, vLLM, OpenRouter, LM Studio…)
CAIRN_AI_KIND=openai-compatible
CAIRN_AI_BASE_URL=http://localhost:11434/v1
CAIRN_AI_MODEL=llama3.1
CAIRN_AI_API_KEY=sk-…

# Anthropic
CAIRN_AI_KIND=anthropic
CAIRN_AI_API_KEY=sk-ant-…
```

- Workflow drafting: every completion is schema-validated with one repair round-trip; steps with unknown kinds are dropped from the plan before anything is stored.
- Failure analysis: the model receives the structured failure record and evidence summaries — never your secrets.
- No data is sent to any provider you have not configured yourself.

---

## 8. Troubleshooting

| Symptom | What it means | What to do |
|---|---|---|
| Stats show `—` | Console cannot reach the API | Check the server process and the port in the boot banner. |
| Run stuck in `queued` | Concurrency is 2; others wait their turn | If nothing moves for minutes, check server logs for engine errors. |
| `E_ASSERTION — expected X, observed Y` | Not a Cairn error — the service answered differently | Open the step's evidence and compare with the documented contract. |
| `E_VALIDATION` on save | The JSON breaks engine rules | The message names the step and field; fix and re-save. |
| `E_TIMEOUT` | Step exceeded its `timeoutMs` | Raise the timeout or fix the slow dependency; the exchange evidence shows how far it got. |
| Secret "not found" at runtime | `{{secrets.NAME}}` name mismatch | Names are case-sensitive; store it first in Settings. |
| Browser steps fail instantly | Playwright not installed | `npm i playwright` + `npx playwright install chromium`, or remove browser steps. |
| `E_UNAUTHORIZED` | `CAIRN_API_TOKEN` is set | Send `Authorization: Bearer <token>` on non-GET calls. |

---

## 9. Running it for real

- **Backups**: stop the server and copy `CAIRN_DATA_DIR`. It is a single SQLite file plus evidence blobs.
- **Upgrades**: `git pull && npm install && npm run build`. The store migrates automatically; never delete the data directory between versions.
- **CI**: `npm run test` is hermetic (36 tests, no network). Docker builds are covered by the shipped GitHub Actions workflows.
- **Secret key rotation**: decrypt-and-re-encrypt is manual by design — export secrets, delete them, rotate `CAIRN_SECRET_KEY`, re-enter them.

Questions the guide did not answer: check `docs/architecture.md` for internals or open an issue on the repo.
