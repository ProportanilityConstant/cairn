import { CairnError, type ActionClass, type EvidenceType, type RunContext, type StepRunner } from "@cairn/core";

/**
 * Browser runner backed by Playwright. Playwright is an optional peer
 * dependency: install it separately (`npm i playwright-core` + a browser
 * download) and the browser step kinds light up; without it, browser steps
 * fail with an actionable error explaining exactly what to install.
 *
 * Sessions: steps sharing a `session` id reuse one browser context for the
 * duration of an execution, so logins persist across steps. Sessions are
 * torn down when the execution ends.
 */

type PlaywrightModule = {
  chromium: { launch(o: { headless: boolean }): Promise<PlaywrightBrowser> };
};
interface PlaywrightBrowser {
  newContext(): Promise<PlaywrightContext>;
  close(): Promise<void>;
}
interface PlaywrightContext {
  newPage(): Promise<PlaywrightPage>;
  close(): Promise<void>;
}
interface PlaywrightPage {
  goto(url: string, o: { waitUntil: string; signal: AbortSignal; timeout: number }): Promise<unknown>;
  click(selector: string, o: { timeout: number; signal: AbortSignal }): Promise<void>;
  fill(selector: string, value: string, o: { timeout: number; signal: AbortSignal }): Promise<void>;
  selectOption(selector: string, value: string, o: { timeout: number; signal: AbortSignal }): Promise<void>;
  waitForSelector(selector: string, o: { state: string; timeout: number; signal: AbortSignal }): Promise<unknown>;
  screenshot(o: { fullPage: boolean; type: "png" }): Promise<Buffer>;
  url(): string;
  title(): Promise<string>;
  on(ev: "console", cb: (m: { type(): string; text(): string }) => void): void;
  on(ev: "pageerror", cb: (e: Error) => void): void;
  close(): Promise<void>;
}

export interface BrowserRunnerOptions {
  headless: boolean;
}

export class BrowserRunner implements StepRunner {
  readonly kind: string;
  readonly actionClass: ActionClass;
  private readonly action: string;
  private pw: PlaywrightModule | null | undefined;
  private browsers = new Map<string, { browser: PlaywrightBrowser; pages: Map<string, PlaywrightPage> }>();
  private readonly headless: boolean;
  /** Console/page errors captured per session for evidence. */
  private readonly consoleLog = new Map<string, string[]>();

  constructor(action: string, actionClass: ActionClass, opts: BrowserRunnerOptions) {
    this.action = action;
    this.kind = `browser.${action}`;
    this.actionClass = actionClass;
    this.headless = opts.headless;
  }

  private async loadPlaywright(): Promise<PlaywrightModule | null> {
    if (this.pw !== undefined) return this.pw;
    try {
      // Computed specifier: keeps TypeScript from erroring on an optional dep.
      const spec = ["playwright", "core"].join("-");
      this.pw = (await import(spec)) as unknown as PlaywrightModule;
    } catch {
      this.pw = null;
    }
    return this.pw;
  }

  validate(_config: unknown) {
    return { ok: true as const };
  }

  private async getPage(session: string, ctx: RunContext): Promise<PlaywrightPage> {
    const pw = await this.loadPlaywright();
    if (!pw) {
      throw new CairnError("E_BROWSER", `The "${this.kind}" step needs Playwright, which is not installed in this deployment`, {
        hint: "Run: npm i playwright-core && npx playwright-core install chromium — or use API steps, which have no extra dependencies.",
      });
    }
    let entry = this.browsers.get(session);
    if (!entry) {
      try {
        const browser = await pw.chromium.launch({ headless: this.headless });
        entry = { browser, pages: new Map() };
        this.browsers.set(session, entry);
        ctx.logger("info", `Browser session "${session}" started (chromium, headless=${this.headless})`);
      } catch (e) {
        throw new CairnError("E_BROWSER", `Failed to launch a Chromium browser: ${e instanceof Error ? e.message : String(e)}`, { hint: "Install a browser with: npx playwright-core install chromium" });
      }
    }
    let page = entry.pages.get(session);
    if (!page) {
      const context = await entry.browser.newContext();
      page = await context.newPage();
      entry.pages.set(session, page);
      const log = this.consoleLog.get(session) ?? [];
      this.consoleLog.set(session, log);
      page.on("console", (m) => {
        if (log.length < 500) log.push(`[${m.type()}] ${m.text()}`);
      });
      page.on("pageerror", (e) => {
        if (log.length < 500) log.push(`[pageerror] ${e.message}`);
      });
    }
    return page;
  }

  async run(rawConfig: Record<string, unknown>, ctx: RunContext): Promise<Record<string, unknown>> {
    const session = String(rawConfig.session ?? "default");
    const timeoutMs = typeof rawConfig.timeoutMs === "number" ? rawConfig.timeoutMs : 30_000;
    const page = await this.getPage(session, ctx);
    try {
      switch (this.action) {
        case "goto": {
          await page.goto(String(rawConfig.url), { waitUntil: String(rawConfig.waitUntil ?? "load"), signal: ctx.signal, timeout: timeoutMs });
          return { url: page.url(), title: await page.title() };
        }
        case "click": {
          await page.click(String(rawConfig.selector), { timeout: timeoutMs, signal: ctx.signal });
          return { clicked: String(rawConfig.selector) };
        }
        case "fill": {
          let value = String(rawConfig.value ?? "");
          if (rawConfig.secretRef) value = ctx.variables[`__secret:${String(rawConfig.secretRef)}`] ?? "";
          await page.fill(String(rawConfig.selector), value, { timeout: timeoutMs, signal: ctx.signal });
          return { filled: String(rawConfig.selector) };
        }
        case "select": {
          await page.selectOption(String(rawConfig.selector), String(rawConfig.value), { timeout: timeoutMs, signal: ctx.signal });
          return { selected: String(rawConfig.value) };
        }
        case "wait": {
          await page.waitForSelector(String(rawConfig.selector), { state: String(rawConfig.state ?? "visible"), timeout: typeof rawConfig.timeoutMs === "number" ? rawConfig.timeoutMs : timeoutMs, signal: ctx.signal });
          return { wait: String(rawConfig.selector) };
        }
        case "assert": {
          const selector = String(rawConfig.selector);
          const state = String(rawConfig.state);
          if (state === "text") {
            await page.waitForSelector(selector, { state: "visible", timeout: timeoutMs, signal: ctx.signal });
            const content = await pageText(page, selector);
            const expected = String(rawConfig.text ?? "");
            if (!content.includes(expected)) {
              throw new CairnError("E_ASSERTION", `Assertion failed: text of "${selector}" should contain ${JSON.stringify(expected)} — observed ${JSON.stringify(content.slice(0, 300))}`);
            }
            return { text: content };
          }
          await page.waitForSelector(selector, { state: state === "visible" ? "visible" : "hidden", timeout: timeoutMs, signal: ctx.signal });
          return { selector, state };
        }
        case "screenshot": {
          const shot = await page.screenshot({ fullPage: Boolean(rawConfig.fullPage), type: "png" });
          const id = ctx.emitEvidence({ type: "screenshot" as EvidenceType, contentType: "image/png", encoding: "base64", data: shot.toString("base64"), label: "Screenshot" });
          return { evidenceId: id, url: page.url() };
        }
        case "console": {
          const log = this.consoleLog.get(session) ?? [];
          const level = String(rawConfig.level ?? "error");
          const filtered = log.filter((l) => level === "info" ? true : l.startsWith(`[${level}`) || l.startsWith("[pageerror]"));
          const id = ctx.emitEvidence({ type: "log", contentType: "text/plain", encoding: "utf8", data: filtered.join("\n") || "(no matching console entries)", label: `Console log (${level}+)` });
          return { evidenceId: id, entries: filtered.length };
        }
        default:
          throw new CairnError("E_INTERNAL", `Unhandled browser action "${this.action}"`);
      }
    } catch (e) {
      if (e instanceof CairnError) throw e;
      if (ctx.signal.aborted) throw new CairnError("E_CANCELLED", "Execution cancelled during a browser step");
      const msg = e instanceof Error ? e.message : String(e);
      if (/Timeout.*exceeded/i.test(msg)) {
        throw new CairnError("E_TIMEOUT", `Browser step timed out after ${timeoutMs}ms: ${msg}`, { hint: "Verify the selector exists and the page has settled, or raise the step timeout." });
      }
      throw new CairnError("E_BROWSER", `Browser step failed: ${msg}`);
    }
  }

  /** Tear down all sessions. Called by the engine in a finally block. */
  async dispose(): Promise<void> {
    for (const [, entry] of this.browsers) {
      for (const [, page] of entry.pages) {
        try { await page.close(); } catch { /* already gone */ }
      }
      try { await entry.browser.close(); } catch { /* already gone */ }
    }
    this.browsers.clear();
    this.consoleLog.clear();
  }
}

async function pageText(page: PlaywrightPage, selector: string): Promise<string> {
  // textContent via locator API exposed through waitForSelector result is not
  // in the minimal interface; use evaluate-style through fill's return path.
  // Playwright pages expose textContent directly at runtime.
  const p = page as unknown as { textContent(s: string): Promise<string | null> };
  return (await p.textContent(selector)) ?? "";
}
