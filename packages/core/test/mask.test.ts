import { describe, expect, it } from "vitest";
import { createMasker } from "../src/mask.js";

describe("masker", () => {
  const m = createMasker(["s3cr3t-token"]);

  it("redacts known secret values in strings", () => {
    expect(m.redact("Authorization: Bearer s3cr3t-token")).toBe("Authorization: Bearer ••••••••");
  });

  it("scrubs secret-named keys in deep structures", () => {
    const out = m.scrub({ headers: { Authorization: "x", Accept: "y" }, password: "p", nested: { apiKey: "k" }, data: "s3cr3t-token" });
    expect(out).toEqual({ headers: { Authorization: "••••••••", Accept: "y" }, password: "••••••••", nested: { apiKey: "••••••••" }, data: "••••••••" });
  });
});
