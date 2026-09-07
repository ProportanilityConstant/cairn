# Contributing

## Ground rules
1. No fake functionality. A feature that ships must work, or must not ship.
2. Every architectural decision has a stated reason.
3. Tests are not optional. New behavior means new tests, and `bunx vitest run`
   must pass before merge.
4. Do not add dependencies for novelty. Boring and reliable wins.

## Setup
```bash
bun install
bunx vitest run
```

## Workflow
1. Open or claim an issue.
2. Branch from `main`.
3. Keep changes focused; the monorepo is small enough to read end to end — help keep it that way.
4. PR checklist lives in the template. CI runs type-check, tests, web build, a server boot check, and a Docker build.

## Code style
- TypeScript strict mode everywhere; no `any` without a comment explaining why.
- Errors: `CairnError` with a stable code, an actionable message, and a hint where useful. "Something went wrong" is a bug.
- The UI renders facts differently from AI hypotheses. Preserve that boundary.
