export { ExecutionEngine, type EngineOptions, type RunOptions, type RunOutput, type EvidenceSink } from "./engine.js";
export { HttpRunner } from "./runners/http.js";
export { AssertRunner, DelayRunner, NoteRunner } from "./runners/basic.js";
export { BrowserRunner, type BrowserRunnerOptions } from "./runners/browser.js";
import { type StepRunner } from "@cairn/core";
import { HttpRunner } from "./runners/http.js";
import { AssertRunner, DelayRunner, NoteRunner } from "./runners/basic.js";
import { BrowserRunner } from "./runners/browser.js";
import type { PolicyConfig } from "@cairn/core";

/**
 * The standard runner registry. Browser runners are always registered — they
 * degrade to actionable errors when Playwright is not installed.
 */
export function createRunnerRegistry(policy: PolicyConfig, opts?: { headless?: boolean }): Record<string, StepRunner> {
  const http = new HttpRunner({ networkAllowlist: policy.networkAllowlist, maxNetworkRequests: policy.maxNetworkRequests });
  const runners: Record<string, StepRunner> = {
    "http.request": http,
    "assert": new AssertRunner(),
    "delay": new DelayRunner(),
    "note": new NoteRunner(),
  };
  const browserOpts = { headless: opts?.headless ?? true };
  for (const [action, cls] of [
    ["goto", "network"], ["click", "safe_write"], ["fill", "safe_write"], ["select", "safe_write"],
    ["wait", "read"], ["assert", "read"], ["screenshot", "read"], ["console", "read"],
  ] as const) {
    runners[`browser.${action}`] = new BrowserRunner(action, cls, browserOpts);
  }
  return runners;
}
