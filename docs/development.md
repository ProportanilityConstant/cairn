# Development

```bash
bun install        # or npm install
bunx vitest run    # 36 tests: core, engine, ai, server API
npm run build      # all packages + web console
```

## Layout
- `packages/*/test` — unit + integration tests (vitest, forks pool).
- `apps/server/test/api.test.ts` — the full API journey test: project →
  workflow → run → pass → chaos → structured failure → analysis → recovery.
- `apps/web` — React 18 + Vite. `bunx vite build` must pass; type-check with
  `bunx tsc -p apps/web/tsconfig.json`.

## Conventions
- Strict TS. `noUncheckedIndexedAccess` is on — respect it.
- Errors: `CairnError(code, message, { hint })`. Codes are part of the API surface.
- The facts/hypothesis boundary in the UI is a product principle. Don't blur it.
- Run the demo loop in README before submitting UX changes.
