/**
 * Action policy. Every step kind declares an action class; the execution
 * engine enforces limits *independently of the AI layer*. An LLM cannot talk
 * its way past this file.
 */
export type PolicyConfig = {
  requireExplicitAllow: import("./types.js").ActionClass[];
  networkAllowlist?: string[];
  maxNetworkRequests: number;
};

export const defaultPolicy: PolicyConfig = {
  requireExplicitAllow: ["destructive"],
  maxNetworkRequests: 500,
};

export function domainAllowed(allowlist: string[] | undefined, url: string): boolean {
  if (!allowlist || allowlist.length === 0) return true;
  let host: string;
  try { host = new URL(url).hostname; } catch { return false; }
  return allowlist.some((pattern) =>
    pattern.startsWith("*.") ? host.endsWith(pattern.slice(1)) : host === pattern
  );
}
