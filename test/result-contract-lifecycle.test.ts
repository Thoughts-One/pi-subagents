import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { resumeAgent, runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";

const validReceipt = `Claude-Subagent-Receipt: ${JSON.stringify({
  role: "planner",
  model: "claude-fable-5",
  outcome: "success",
  input_tokens: 1,
  output_tokens: 2,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  duration_ms: 3,
  failure_class: null,
  escalated: false,
  truncated: false,
})}\nPlan body.`;

function makePi(order: string[]) {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
    registerCommand: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: {
      emit: vi.fn((event: string) => order.push(`event:${event}`)),
      on: vi.fn(() => vi.fn()),
    },
    appendEntry: vi.fn(() => order.push("persist")),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, lifecycle };
}

function context(cwd: string) {
  return {
    hasUI: false,
    cwd,
    model: undefined,
    modelRegistry: { find: vi.fn(), getAll: vi.fn(() => []), getAvailable: vi.fn(() => []) },
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    sessionManager: { getSessionId: vi.fn(() => "session"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

const textOf = (result: any): string => result.content[0].text;

function planParams(patch: Record<string, unknown> = {}) {
  return { prompt: "Plan the change.", description: "Plan contract lifecycle", subagent_type: "Plan", ...patch };
}

describe("Plan result contract settlement", () => {
  let root: string;
  let agentDir: string;
  let previousCwd: string;
  let previousAgentDir: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "plan-contract-"));
    agentDir = mkdtempSync(join(tmpdir(), "plan-contract-agent-"));
    previousCwd = process.cwd();
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    mkdirSync(join(root, ".pi", "agents"), { recursive: true });
    writeFileSync(join(root, ".pi", "agents", "Plan.md"), "---\nresult_contract: plan-authority\n---\nPlan.");
    process.chdir(root);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
    rmSync(root, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  for (const runInBackground of [false, true]) {
    it(`${runInBackground ? "background" : "foreground"} completion is failed and persisted after its lifecycle callback`, async () => {
      vi.mocked(runAgent).mockResolvedValue({
        responseText: "OUTCOME: COMPLETE\nPlan body without provenance.",
        session: { dispose: vi.fn() } as any,
        aborted: false,
        steered: false,
      });
      const order: string[] = [];
      const { pi, tools, lifecycle } = makePi(order);
      subagentsExtension(pi);
      const result = await tools.get("Agent").execute("call", planParams({
        ...(runInBackground ? { run_in_background: true } : {}),
      }), undefined, undefined, context(root));
      if (runInBackground) await new Promise((resolve) => setImmediate(resolve));

      if (!runInBackground) expect(textOf(result)).toContain("Result contract violation");
      expect(pi.events.emit).toHaveBeenCalledWith("subagents:failed", expect.objectContaining({
        status: "error",
        result: "OUTCOME: COMPLETE\nPlan body without provenance.",
      }));
      expect(pi.appendEntry).toHaveBeenCalledWith("subagents:record", expect.objectContaining({
        status: "error",
        result: "OUTCOME: COMPLETE\nPlan body without provenance.",
        error: expect.stringContaining("Result contract violation"),
      }));
      expect(order.indexOf("event:subagents:failed")).toBeLessThan(order.indexOf("persist"));
      await lifecycle.get("session_shutdown")?.();
    });
  }

  it("a scheduled Plan run persists its result-contract failure", async () => {
    vi.useFakeTimers();
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "# Plan without receipt",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    });
    const order: string[] = [];
    const { pi, tools, lifecycle } = makePi(order);
    subagentsExtension(pi);
    await lifecycle.get("session_start")({}, context(root));
    await tools.get("Agent").execute("call", planParams({ schedule: "+1s" }), undefined, undefined, context(root));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(pi.events.emit).toHaveBeenCalledWith("subagents:failed", expect.objectContaining({
      type: "Plan",
      status: "error",
      result: "# Plan without receipt",
    }));
    expect(pi.appendEntry).toHaveBeenCalledWith("subagents:record", expect.objectContaining({
      status: "error",
      result: "# Plan without receipt",
    }));
    await lifecycle.get("session_shutdown")?.();
  });

  it("resume retains the raw invalid result and changes the existing record to error", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: validReceipt,
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    });
    vi.mocked(resumeAgent).mockResolvedValue({ text: "Plan body without receipt.", failure: undefined } as any);
    const order: string[] = [];
    const { pi, tools, lifecycle } = makePi(order);
    subagentsExtension(pi);
    const started = await tools.get("Agent").execute("call", planParams({ run_in_background: true }), undefined, undefined, context(root));
    const id = textOf(started).match(/Agent ID: (\S+)/)?.[1];
    expect(id).toBeTruthy();
    await new Promise((resolve) => setImmediate(resolve));
    pi.events.emit.mockClear();
    pi.appendEntry.mockClear();
    order.length = 0;

    const result = await tools.get("Agent").execute("call", planParams({ resume: id }), undefined, undefined, context(root));
    const registry = (globalThis as any)[Symbol.for("pi-subagents:manager")];
    const record = registry.getRecord(id);

    expect(textOf(result)).toContain("Result contract violation");
    expect(record).toEqual(expect.objectContaining({
      status: "error",
      result: "Plan body without receipt.",
      error: expect.stringContaining("Result contract violation"),
    }));
    expect(resumeAgent).toHaveBeenCalledTimes(1);
    expect(pi.events.emit).toHaveBeenCalledWith("subagents:failed", expect.objectContaining({
      id,
      status: "error",
      result: "Plan body without receipt.",
    }));
    expect(pi.appendEntry).toHaveBeenCalledWith("subagents:record", expect.objectContaining({
      id,
      status: "error",
      result: "Plan body without receipt.",
    }));
    expect(order.indexOf("event:subagents:failed")).toBeLessThan(order.indexOf("persist"));
    await lifecycle.get("session_shutdown")?.();
  });
});
