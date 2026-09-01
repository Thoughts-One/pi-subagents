import { describe, expect, it } from "vitest";
import {
  addUsage,
  assistantUsageEvent,
  createLifetimeUsage,
  getLifetimeComponents,
  getLifetimeTotal,
  getSessionContextPercent,
  getSessionTokens,
  toolResultUsageEvent,
} from "../src/usage.js";

describe("usage", () => {
  describe("getSessionTokens", () => {
    it("uses billed-token semantics, not the cache-read-inflated total", () => {
      const session = {
        getSessionStats: () => ({
          tokens: { input: 100, output: 200, cacheRead: 500_000, cacheWrite: 50, total: 500_350 } as any,
          contextUsage: { tokens: 50_300, contextWindow: 200_000, percent: 25 },
        }),
      };
      expect(getSessionTokens(session)).toBe(350);
    });

    it("returns 0 when session stats are unavailable", () => {
      expect(getSessionTokens(undefined)).toBe(0);
      const broken = { getSessionStats: () => { throw new Error("nope"); } } as any;
      expect(getSessionTokens(broken)).toBe(0);
    });
  });

  describe("getSessionContextPercent", () => {
    it("returns null when context usage is unavailable", () => {
      const session = { getSessionStats: () => ({ tokens: { input: 10, output: 20, cacheWrite: 5 } }) };
      expect(getSessionContextPercent(session)).toBeNull();
    });

    it("returns the upstream percent when available", () => {
      const session = {
        getSessionStats: () => ({
          tokens: { input: 10, output: 20, cacheWrite: 5 },
          contextUsage: { tokens: 50_000, contextWindow: 200_000, percent: 25 },
        }),
      };
      expect(getSessionContextPercent(session)).toBe(25);
    });
  });

  describe("cumulative attributed usage", () => {
    it("preserves cache components while the UI total excludes cache reads", () => {
      const lifetime = createLifetimeUsage();
      addUsage(lifetime, assistantUsageEvent({
        provider: "anthropic",
        model: "claude-child",
        usage: {
          input: 100,
          output: 20,
          cacheRead: 900,
          cacheWrite: 30,
          totalTokens: 1050,
          cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
        },
      })!);

      expect(lifetime).toEqual({
        schemaVersion: 1,
        cumulative: true,
        models: {
          "anthropic/claude-child": {
            calls: 1,
            input: 100,
            output: 20,
            cacheRead: 900,
            cacheWrite: 30,
            cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
          },
        },
        unattributedTools: {},
      });
      expect(getLifetimeComponents(lifetime).cacheRead).toBe(900);
      expect(getLifetimeTotal(lifetime)).toBe(150);
    });

    it("attributes tool usage only from details.usageModel", () => {
      const lifetime = createLifetimeUsage();
      const usage = {
        input: 5,
        output: 6,
        cacheRead: 7,
        cacheWrite: 8,
        totalTokens: 26,
        cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
      };
      const attributed = toolResultUsageEvent({
        toolName: "session_query",
        details: { usageModel: { provider: "openai", id: "gpt-5" }, usage },
      });
      const unattributed = toolResultUsageEvent({
        toolName: "Plan",
        details: { model: "openai/gpt-5", usage },
      });

      expect(attributed).toMatchObject({ kind: "model", model: { provider: "openai", model: "gpt-5" } });
      expect(unattributed).toMatchObject({ kind: "unattributedTool", toolName: "Plan" });
      addUsage(lifetime, attributed!);
      addUsage(lifetime, unattributed!);

      expect(lifetime.models["openai/gpt-5"].calls).toBe(1);
      expect(lifetime.unattributedTools.Plan).toMatchObject({ calls: 1, cacheRead: 7 });
      expect(getLifetimeTotal(lifetime)).toBe(38);
    });

    it("uses the current top-level tool result usage before the legacy details fallback", () => {
      const event = toolResultUsageEvent({
        toolName: "Plan",
        usage: {
          input: 20,
          output: 30,
          cacheRead: 40,
          cacheWrite: 50,
          totalTokens: 140,
          cost: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, total: 14 },
        },
        details: {
          usageModel: { provider: "anthropic", model: "claude-plan" },
          usage: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, totalTokens: 4 },
        },
      });

      expect(event).toMatchObject({
        kind: "model",
        model: { provider: "anthropic", model: "claude-plan" },
        usage: { input: 20, output: 30, cacheRead: 40, cacheWrite: 50 },
      });
    });
  });
});
