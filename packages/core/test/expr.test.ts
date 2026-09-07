import { describe, expect, it } from "vitest";
import { compileCondition, evaluateExpression } from "../src/expr.js";

describe("expression evaluator", () => {
  const scope = { passed: true, failed: false, count: 3, name: "login", status: 200 };

  it("evaluates booleans, comparisons and logic", () => {
    expect(evaluateExpression("passed && !failed", scope)).toBe(true);
    expect(evaluateExpression("count > 2 && count <= 3", scope)).toBe(true);
    expect(evaluateExpression("name == 'login'", scope)).toBe(true);
    expect(evaluateExpression("status != 200 || count == 3", scope)).toBe(true);
    expect(evaluateExpression("count + 1 == 4", scope)).toBe(true);
  });

  it("compiled conditions are reusable", () => {
    const c = compileCondition("count >= 3");
    expect(c(scope)).toBe(true);
    expect(c({ count: 2 })).toBe(false);
  });

  it("rejects unknown identifiers instead of returning undefined", () => {
    expect(() => evaluateExpression("nope == 1", scope)).toThrow(/Unknown identifier/);
  });

  it("rejects malformed expressions", () => {
    expect(() => evaluateExpression("count > )", scope)).toThrow();
    expect(() => evaluateExpression("count &&", scope)).toThrow();
  });
});
