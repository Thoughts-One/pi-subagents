import { describe, expect, it } from "vitest";
import { resolveAgentInvocationConfig, resolveJoinMode } from "../src/invocation-config.js";
import type { AgentConfig } from "../src/types.js";

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "Explore",
    description: "Explore",
    builtinToolNames: ["read"],
    extensions: false,
    skills: false,
    systemPrompt: "Test agent",
    ...overrides,
  };
}

describe("resolveAgentInvocationConfig", () => {
  it("uses role frontmatter for fixed invocation fields", () => {
    const resolved = resolveAgentInvocationConfig(
      makeConfig({
        model: "provider/config-model",
        thinking: "high",
        maxTurns: 42,
        inheritContext: true,
        runInBackground: false,
        isolated: true,
        isolation: "worktree",
      }),
      { run_in_background: true },
    );

    expect(resolved).toMatchObject({
      modelInput: "provider/config-model",
      thinking: "high",
      maxTurns: 42,
      inheritContext: true,
      runInBackground: false,
      isolated: true,
      isolation: "worktree",
    });
  });

  it("only lets callers select background execution", () => {
    const resolved = resolveAgentInvocationConfig(makeConfig(), { run_in_background: true });

    expect(resolved.modelInput).toBeUndefined();
    expect(resolved.thinking).toBeUndefined();
    expect(resolved.maxTurns).toBeUndefined();
    expect(resolved.inheritContext).toBe(false);
    expect(resolved.runInBackground).toBe(true);
    expect(resolved.isolated).toBe(false);
    expect(resolved.isolation).toBeUndefined();
  });
});

describe("resolveJoinMode", () => {
  it("returns the global default for background agents", () => {
    expect(resolveJoinMode("smart", true)).toBe("smart");
    expect(resolveJoinMode("async", true)).toBe("async");
  });

  it("ignores join mode for foreground agents", () => {
    expect(resolveJoinMode("smart", false)).toBeUndefined();
    expect(resolveJoinMode("group", false)).toBeUndefined();
  });
});
