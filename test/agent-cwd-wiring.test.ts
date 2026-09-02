import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as AgentRunnerModule from "../src/agent-runner.js";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof AgentRunnerModule>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";

function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
    registerCommand: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, lifecycle };
}

function context(cwd: string) {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd,
    model: undefined,
    modelRegistry: {
      find: vi.fn(),
      getAll: vi.fn(() => []),
      getAvailable: vi.fn(() => []),
    },
    sessionManager: { getSessionId: vi.fn(() => "cwd-wiring"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

const textOf = (result: any): string => result.content[0].text;

describe("Agent cwd wiring", () => {
  let parentCwd: string;
  let targetCwd: string;
  let agentDir: string;
  let previousCwd: string;
  let previousAgentDir: string | undefined;
  let previousHome: string | undefined;

  beforeEach(() => {
    parentCwd = mkdtempSync(join(tmpdir(), "pi-agent-cwd-parent-"));
    targetCwd = mkdtempSync(join(tmpdir(), "pi-agent-cwd-target-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-agent-cwd-config-"));
    previousCwd = process.cwd();
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    previousHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    vi.mocked(runAgent).mockReset();
    mkdirSync(join(parentCwd, ".pi"), { recursive: true });
    writeFileSync(join(parentCwd, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: true }));
    process.chdir(parentCwd);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(parentCwd, { recursive: true, force: true });
    rmSync(targetCwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("exposes cwd and forwards it to a fresh run while retaining parent config", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    });
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const agent = tools.get("Agent");

    expect(agent.parameters.properties.cwd).toBeDefined();
    expect(agent.parameters.properties.resume.minLength).toBe(1);
    expect(agent.parameters.properties.schedule.minLength).toBe(1);
    await agent.execute(
      "cwd-fresh",
      {
        prompt: "inspect the target",
        description: "Inspect target repository",
        subagent_type: "general-purpose",
        cwd: targetCwd,
      },
      undefined,
      undefined,
      context(parentCwd),
    );

    expect(runAgent).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: parentCwd }),
      "general-purpose",
      "inspect the target",
      expect.objectContaining({ cwd: targetCwd, configCwd: parentCwd }),
    );
    await lifecycle.get("session_shutdown")?.({}, context(parentCwd));
  });

  it("rejects cwd for resume and scheduling rather than silently ignoring it", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const agent = tools.get("Agent");
    const common = {
      prompt: "inspect the target",
      description: "Inspect target repository",
      subagent_type: "general-purpose",
      cwd: targetCwd,
    };

    const resume = await agent.execute(
      "cwd-resume",
      { ...common, resume: "existing-agent" },
      undefined,
      undefined,
      context(parentCwd),
    );
    expect(textOf(resume)).toContain("Cannot combine `cwd` with `resume`");

    const schedule = await agent.execute(
      "cwd-schedule",
      { ...common, schedule: "+1m" },
      undefined,
      undefined,
      context(parentCwd),
    );
    expect(textOf(schedule)).toContain("Cannot combine `cwd` with `schedule`");

    const emptyResume = await agent.execute(
      "cwd-empty-resume",
      { ...common, resume: "" },
      undefined,
      undefined,
      context(parentCwd),
    );
    expect(textOf(emptyResume)).toContain("Cannot combine `cwd` with `resume`");

    const emptySchedule = await agent.execute(
      "cwd-empty-schedule",
      { ...common, schedule: "" },
      undefined,
      undefined,
      context(parentCwd),
    );
    expect(textOf(emptySchedule)).toContain("Cannot combine `cwd` with `schedule`");
    expect(runAgent).not.toHaveBeenCalled();
    await lifecycle.get("session_shutdown")?.({}, context(parentCwd));
  });
});
