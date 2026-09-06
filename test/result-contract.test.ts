import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validatePlanAuthorityResult, validateResultContract } from "../src/result-contract.js";

const authorityModel = (JSON.parse(
  readFileSync(new URL("../plan-authority-contract.json", import.meta.url), "utf8"),
) as { authority_model: string }).authority_model;

const claudeReceipt = {
  role: "planner",
  model: authorityModel,
  outcome: "success",
  input_tokens: 1,
  output_tokens: 2,
  cache_read_tokens: 3,
  cache_write_tokens: 4,
  duration_ms: 5,
  failure_class: null,
  escalated: false,
  truncated: false,
};

const fallbackReceipt = {
  role: "planner",
  authority_model: authorityModel,
  authority_outcome: "failure",
  failure_class: "process",
  author_model: "openai-codex/gpt-5.6-sol",
};

const withHeader = (header: string, receipt: object) => `${header}: ${JSON.stringify(receipt)}\nPlan body.`;

describe("Plan authority result contract", () => {
  it("accepts successful, failed, and exact truncated Claude receipts", () => {
    expect(validatePlanAuthorityResult(withHeader("Claude-Subagent-Receipt", claudeReceipt))).toBeUndefined();
    expect(validatePlanAuthorityResult(withHeader("Claude-Subagent-Receipt", {
      ...claudeReceipt,
      truncated: true,
    }))).toBeUndefined();
    expect(validatePlanAuthorityResult(withHeader("Claude-Subagent-Receipt", {
      ...claudeReceipt,
      outcome: "failure",
      failure_class: "timeout",
    }))).toBeUndefined();
  });

  it("accepts disclosed Sol fallback receipts for process and structured-output failures", () => {
    expect(validatePlanAuthorityResult(withHeader("Plan-Fallback-Receipt", fallbackReceipt))).toBeUndefined();
    expect(validatePlanAuthorityResult(withHeader("Plan-Fallback-Receipt", {
      ...fallbackReceipt,
      failure_class: "structured-output",
    }))).toBeUndefined();
  });

  it("rejects the three frozen missing-provenance results", () => {
    const frozenMissingProvenance = [
      "OUTCOME: COMPLETE\nPlan body.",
      "# Implementation Plan\n\nNo authority receipt.",
      "Plan-Fallback-Receipt: authority unavailable; Sol wrote this plan.",
    ];
    for (const result of frozenMissingProvenance) {
      expect(validatePlanAuthorityResult(result), result).toBeDefined();
    }
  });

  it("rejects non-leading, malformed, and surplus provenance", () => {
    expect(validatePlanAuthorityResult(`Plan body.\n${withHeader("Claude-Subagent-Receipt", claudeReceipt)}`)).toContain("must start");
    expect(validatePlanAuthorityResult("Claude-Subagent-Receipt: {not-json}")).toContain("malformed JSON");
    expect(validatePlanAuthorityResult(withHeader("Claude-Subagent-Receipt", { ...claudeReceipt, attempts: 1 }))).toContain("unknown or missing keys");
  });

  it("rejects incorrect authority identity and fallback class", () => {
    expect(validatePlanAuthorityResult(withHeader("Claude-Subagent-Receipt", { ...claudeReceipt, role: "other" }))).toContain("role");
    expect(validatePlanAuthorityResult(withHeader("Claude-Subagent-Receipt", { ...claudeReceipt, model: "claude-fable-5" }))).toContain("authority contract");
    expect(validatePlanAuthorityResult(withHeader("Claude-Subagent-Receipt", { ...claudeReceipt, model: "other" }))).toContain("authority contract");
    expect(validatePlanAuthorityResult(withHeader("Claude-Subagent-Receipt", { ...claudeReceipt, failure_class: "process" }))).toContain("failure_class null");
    expect(validatePlanAuthorityResult(withHeader("Plan-Fallback-Receipt", { ...fallbackReceipt, failure_class: "unknown" }))).toContain("allowed authority failure");
  });

  it("leaves agents without a contract unchanged", () => {
    expect(validateResultContract(undefined, "anything")).toBeUndefined();
  });
});
