import { beforeEach, describe, expect, it } from "vitest";
import { getAgentConfig, registerAgents } from "../src/agent-types.js";
import { buildAgentPrompt } from "../src/prompts.js";
import type { AgentConfig, EnvInfo } from "../src/types.js";

const env: EnvInfo = {
  isGitRepo: true,
  branch: "main",
  platform: "darwin",
};

const envNoGit: EnvInfo = {
  isGitRepo: false,
  branch: "",
  platform: "linux",
};

beforeEach(() => {
  registerAgents(new Map());
});

function config(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "custom",
    description: "Custom",
    builtinToolNames: [],
    extensions: true,
    skills: true,
    systemPrompt: "You are a specialized agent.",
    ...overrides,
  };
}

describe("buildAgentPrompt", () => {
  it("includes cwd and git information", () => {
    const prompt = buildAgentPrompt(config(), "/workspace", env);
    expect(prompt).toContain("/workspace");
    expect(prompt).toContain("Branch: main");
    expect(prompt).toContain("darwin");
  });

  it("handles non-git repositories", () => {
    const prompt = buildAgentPrompt(config(), "/workspace", envNoGit);
    expect(prompt).toContain("Not a git repository");
    expect(prompt).not.toContain("Branch:");
  });

  it("uses the role body without copying parent instructions", () => {
    const prompt = buildAgentPrompt(config(), "/workspace", env);
    expect(prompt).toContain("You are a specialized agent.");
    expect(prompt).not.toContain("<sub_agent_context>");
    expect(prompt).not.toContain("general-purpose coding agent");
  });

  it("keeps each built-in role prompt", () => {
    expect(buildAgentPrompt(getAgentConfig("general-purpose")!, "/workspace", env)).toContain("general-purpose coding agent");
    expect(buildAgentPrompt(getAgentConfig("Explore")!, "/workspace", env)).toContain("READ-ONLY");
    expect(buildAgentPrompt(getAgentConfig("Plan")!, "/workspace", env)).toContain("software architect");
  });

  it("injects memory and preloaded skills", () => {
    const prompt = buildAgentPrompt(config(), "/workspace", env, {
      memoryBlock: "# Agent Memory\nRemember this.",
      skillBlocks: [{ name: "api-conventions", content: "Use REST endpoints." }],
    });
    expect(prompt).toContain("# Agent Memory");
    expect(prompt).toContain("Preloaded Skill: api-conventions");
    expect(prompt).toContain("Use REST endpoints.");
  });

  it("does not add extras when none are supplied", () => {
    const prompt = buildAgentPrompt(config(), "/workspace", env);
    expect(prompt).not.toContain("Agent Memory");
    expect(prompt).not.toContain("Preloaded Skill");
  });

  it("starts with the active-agent tag", () => {
    const prompt = buildAgentPrompt(config({ name: "my-agent" }), "/workspace", env);
    expect(prompt).toMatch(/^<active_agent name="my-agent"\/>/);
    expect(prompt.indexOf('<active_agent name="my-agent"/>')).toBeLessThan(prompt.indexOf("# Environment"));
  });
});
