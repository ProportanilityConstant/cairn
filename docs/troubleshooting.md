# Troubleshooting

**Server refuses to start: "CAIRN_SECRET_KEY is not set"**
Generate one: `openssl rand -base64 32`. If you change it later, stored secrets become unreadable — delete and re-add them.

**AI features say "No AI provider is configured"**
Set `CAIRN_AI_KIND` (`local` works offline with no key) and restart.

**Browser steps fail with "needs Playwright"**
`npm i playwright-core && npx playwright-core install chromium`. API steps have no such dependency.

**An execution is stuck in `running`**
It shouldn't be — the engine guarantees terminal status. If you find a path
that violates this, that's a bug worth an issue with the execution ID.

**Assertion fails but the response looks fine in curl**
Check the environment's `baseUrl` variable and your allowlist. The evidence
viewer shows the exact request Cairn sent, headers included (minus credentials).

**"Blocked request … not in the network allowlist"**
That's the policy engine doing its job. Add the host to `CAIRN_NETWORK_ALLOWLIST` deliberately.
