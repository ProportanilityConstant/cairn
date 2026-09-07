# Workflow format

A workflow is a validated JSON document. Example:

```json
{
  "id": "demo_service_check",
  "name": "Demo service check",
  "version": 1,
  "projectId": "prj_…",
  "variables": { "baseUrl": "http://127.0.0.1:5175" },
  "steps": [
    {
      "id": "probe",
      "name": "Health probe",
      "kind": "http.request",
      "config": {
        "url": "{{vars.baseUrl}}/ping",
        "assertions": [{ "target": "body_json", "path": "status", "op": "eq", "value": "healthy" }]
      },
      "retries": 2,
      "timeoutMs": 10000,
      "condition": "vars.environment != 'dev'"
    }
  ]
}
```

## Rules

- `id`: lowercase letters/digits/underscores, unique within the workflow.
- Steps run in order. `condition` (optional) skips the step when false; the
  expression sandbox supports `vars.*`, `steps.<id>.*`, comparisons, `&& || !`,
  and arithmetic. No eval — see docs/architecture.md.
- A step failure stops the workflow unless the step sets `"onFailure": "continue"`.
- Saving a workflow bumps `version`; executions record the version they ran.

## Interpolation

Templates interpolate at run time: `{{vars.NAME}}`, `{{secrets.NAME}}`,
`{{steps.STEP_ID.field}}`. Unknown references are errors — the engine refuses
to silently substitute empty strings.

## Step kinds

`http.request`, `assert`, `delay`, `note`, and `browser.*` (`goto`, `click`,
`fill`, `select`, `wait`, `assert`, `screenshot`, `console`). Browser kinds
require Playwright; without it they fail with an actionable error. `GET
/api/step-kinds` returns the live registry with per-kind action classes.

## Failure records

```json
{
  "stepId": "check_status",
  "code": "E_ASSERTION",
  "message": "Assertion failed: body_json.status eq healthy — observed degraded",
  "assertion": { "target": "body_json.status", "op": "eq", "expected": "healthy", "observed": "degraded" }
}
```

Codes: `E_ASSERTION` (behavior), `E_TIMEOUT`, `E_HTTP` (transport), `E_POLICY`
(blocked by design), `E_VALIDATION` (bad config), `E_BROWSER`, `E_CANCELLED`.
The console renders facts first; AI hypotheses appear only when explicitly
requested, labeled with provider and confidence.
