/**
 * Durable-result retrieval through the real get_subagent_result tool.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

vi.mock("../src/worktree.js", async () => {
  const actual = await vi.importActual<typeof import("../src/worktree.js")>("../src/worktree.js");
  return { ...actual, createWorktree: vi.fn(), cleanupWorktree: vi.fn() };
});

import { resumeAgent, runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { cleanupWorktree, createWorktree } from "../src/worktree.js";

// Fake session store: appendEntry writes custom entries; getBranch reads them back.
const branch: any[] = [];

function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const eventHandlers = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((t: any) => tools.set(t.name, t)),
    registerCommand: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: {
      emit: vi.fn(),
      on: vi.fn((event: string, handler: any) => {
        eventHandlers.set(event, handler);
        return vi.fn();
      }),
    },
    appendEntry: vi.fn((customType: string, data: unknown) => {
      branch.push({ type: "custom", customType, data, id: `e${branch.length}`, parentId: null, timestamp: new Date().toISOString() });
    }),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, lifecycle, eventHandlers };
}

function ctx() {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => [...branch]) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

let agentDir: string;
let priorAgentDir: string | undefined;

beforeEach(() => {
  branch.length = 0;
  agentDir = mkdtempSync(join(tmpdir(), "pi-c1-agent-dir-"));
  priorAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  mkdirSync(join(agentDir, "agents"), { recursive: true });
  writeFileSync(join(agentDir, "agents", "general-purpose.md"), "---\ntools: read\n---\nRead.");
  // Fake only the clock and the cleanup interval; keep setTimeout/setImmediate real.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
});

const textOf = (r: any): string => r.content[0].text;
const flush = async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

async function spawnBackground(tools: Map<string, any>, callId: string, description: string): Promise<string> {
  const spawned = await tools.get("Agent").execute(
    callId,
    { prompt: "go", description, subagent_type: "general-purpose", run_in_background: true },
    undefined, undefined, ctx(),
  );
  return /Agent ID: (\S+)/.exec(textOf(spawned))![1];
}

async function awaitBackgroundSettlement(): Promise<void> {
  await flush();
  await new Promise((resolve) => setTimeout(resolve, 350));
}

function durableEntry(data: unknown, customType = "subagents:record") {
  return {
    type: "custom",
    customType,
    data,
    id: `e${branch.length}`,
    parentId: null,
    timestamp: new Date().toISOString(),
  };
}

describe("get_subagent_result after live-record eviction", () => {
  it("returns the persisted terminal result after the ten-minute cleanup", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);

    vi.mocked(runAgent).mockResolvedValue({
      responseText: "THE-FULL-RESULT-PAYLOAD",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    } as any);

    const spawn = await tools.get("Agent").execute(
      "tc-spawn",
      { prompt: "go", description: "c1 probe agent", subagent_type: "general-purpose", run_in_background: true },
      undefined, undefined, ctx(),
    );
    const id = /Agent ID: (\S+)/.exec(textOf(spawn))![1];
    await flush();

    // Durable outcome entry was written for this agent with the full result.
    const rec = branch.find((e) => e.customType === "subagents:record" && e.data?.id === id);
    expect(rec, "outcome entry should exist").toBeTruthy();
    expect(rec.data.status).toBe("completed");
    expect(rec.data.result).toBe("THE-FULL-RESULT-PAYLOAD");

    // Parent keeps working for eleven minutes; the cleanup timer fires.
    vi.advanceTimersByTime(11 * 60_000);

    const read = await tools.get("get_subagent_result").execute("tc-read", { agent_id: id }, undefined, undefined, ctx());
    const out = textOf(read);
    expect(out).not.toContain("Agent not found");
    expect(out).toContain("THE-FULL-RESULT-PAYLOAD");

    await lifecycle.get("session_shutdown")?.();
  });

  it("uses only the active branch and preserves error partial output", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const activeBranch = [
      durableEntry({ id: "active-error", status: "completed", result: "superseded output" }),
      { type: "compaction", id: "compact", parentId: "e0", timestamp: new Date().toISOString() },
      durableEntry({ id: "active-error", status: "error", error: "preservation failed", result: "unfinished bytes" }),
    ];
    const siblingBranch = [durableEntry({ id: "sibling-only", status: "completed", result: "sibling output" })];
    const activeCtx = ctx();
    activeCtx.sessionManager.getBranch.mockReturnValue(activeBranch);

    const recovered = await tools.get("get_subagent_result").execute(
      "tc-active",
      { agent_id: "active-error" },
      undefined,
      undefined,
      activeCtx,
    );
    expect(recovered.isError).toBe(true);
    expect(textOf(recovered)).toContain("Status: error");
    expect(textOf(recovered)).toContain("Error: preservation failed");
    expect(textOf(recovered)).toContain("Partial output before the failure:\nunfinished bytes");

    // A sibling branch may carry a matching-looking outcome, but getBranch()
    // exposes only the active lineage after a resume or compaction.
    expect(siblingBranch[0].data).toEqual(expect.objectContaining({ id: "sibling-only" }));
    const excluded = await tools.get("get_subagent_result").execute(
      "tc-sibling",
      { agent_id: "sibling-only" },
      undefined,
      undefined,
      activeCtx,
    );
    expect(textOf(excluded)).toContain("Agent not found");
    const unknown = await tools.get("get_subagent_result").execute(
      "tc-unknown",
      { agent_id: "unknown-id" },
      undefined,
      undefined,
      activeCtx,
    );
    expect(textOf(unknown)).toContain("Agent not found");
    expect(activeCtx.sessionManager.getBranch).toHaveBeenCalled();

    await lifecycle.get("session_shutdown")?.();
  });

  it("does not return an older outcome after a newer resume marker", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const activeCtx = ctx();
    activeCtx.sessionManager.getBranch.mockReturnValue([
      durableEntry({ id: "resumed-id", status: "completed", result: "older success" }),
      durableEntry({ id: "resumed-id" }, "subagents:execution"),
    ]);

    const result = await tools.get("get_subagent_result").execute(
      "tc-resumed-missing",
      { agent_id: "resumed-id" },
      undefined,
      undefined,
      activeCtx,
    );
    expect(textOf(result)).toContain("no durable result exists");
    expect(textOf(result)).not.toContain("older success");

    await lifecycle.get("session_shutdown")?.();
  });

  it("rejects an invalid latest outcome instead of returning an older result", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const activeCtx = ctx();
    activeCtx.sessionManager.getBranch.mockReturnValue([
      durableEntry({ id: "same-id", status: "completed", result: "older success" }),
      durableEntry({ id: "same-id", status: "running", result: "invalid latest status" }),
    ]);

    const result = await tools.get("get_subagent_result").execute(
      "tc-invalid",
      { agent_id: "same-id" },
      undefined,
      undefined,
      activeCtx,
    );
    expect(textOf(result)).toContain("Agent result entry is invalid");
    expect(textOf(result)).not.toContain("older success");

    await lifecycle.get("session_shutdown")?.();
  });

  it("accepts stopped and aborted outcomes with optional preservation errors", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const activeCtx = ctx();
    activeCtx.sessionManager.getBranch.mockReturnValue([
      durableEntry({ id: "stopped-result", status: "stopped", result: "partial stop" }),
      durableEntry({
        id: "aborted-result",
        status: "aborted",
        error: "Worktree preservation failed: retained at /tmp/aborted-retained",
        result: "partial abort",
      }),
    ]);

    const stopped = await tools.get("get_subagent_result").execute(
      "tc-stopped",
      { agent_id: "stopped-result" },
      undefined,
      undefined,
      activeCtx,
    );
    expect(textOf(stopped)).toContain("Status: stopped");
    expect(textOf(stopped)).toContain("partial stop");

    const aborted = await tools.get("get_subagent_result").execute(
      "tc-aborted",
      { agent_id: "aborted-result" },
      undefined,
      undefined,
      activeCtx,
    );
    expect(textOf(aborted)).toContain("Status: aborted");
    expect(textOf(aborted)).toContain("/tmp/aborted-retained");
    expect(textOf(aborted)).toContain("Partial output before the failure:\npartial abort");

    await lifecycle.get("session_shutdown")?.();
  });

  it("rejects contradictory terminal outcomes without falling back to an older success", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const activeCtx = ctx();

    for (const invalid of [
      { status: "completed", error: "cannot succeed with an error" },
      { status: "steered", error: "cannot wrap up with an error" },
      { status: "error" },
    ]) {
      activeCtx.sessionManager.getBranch.mockReturnValue([
        durableEntry({ id: "contradictory", status: "completed", result: "older success" }),
        durableEntry({ id: "contradictory", result: "newer result", ...invalid }),
      ]);
      const result = await tools.get("get_subagent_result").execute(
        "tc-contradictory",
        { agent_id: "contradictory" },
        undefined,
        undefined,
        activeCtx,
      );

      expect(textOf(result)).toContain("Agent result entry is invalid");
      expect(textOf(result)).not.toContain("older success");
    }

    await lifecycle.get("session_shutdown")?.();
  });

  it("keeps a stopped result unconsumed until worktree preservation settles", async () => {
    writeFileSync(
      join(agentDir, "agents", "general-purpose.md"),
      "---\ntools: read\nisolation: worktree\n---\nRead.",
    );
    vi.mocked(createWorktree).mockReturnValueOnce({
      path: "/tmp/pi-agent-stopping", branch: "pi-agent-stopping", baseSha: "base", workPath: "/tmp/pi-agent-stopping",
    });
    let finishRun: ((value: any) => void) | undefined;
    vi.mocked(runAgent).mockImplementationOnce(() => new Promise((resolve) => { finishRun = resolve; }));
    const { pi, tools, lifecycle, eventHandlers } = makePi();
    subagentsExtension(pi);
    const bindCtx = ctx();
    bindCtx.sessionManager.getSessionId.mockReturnValue(undefined);
    await lifecycle.get("session_start")?.({}, bindCtx);

    const spawned = await tools.get("Agent").execute(
      "tc-stopping-spawn",
      { prompt: "go", description: "stop before cleanup", subagent_type: "general-purpose", run_in_background: true },
      undefined, undefined, ctx(),
    );
    const id = /Agent ID: (\S+)/.exec(textOf(spawned))![1];
    eventHandlers.get("subagents:rpc:stop")?.({ requestId: "stop-before-cleanup", agentId: id });

    const stopping = await tools.get("get_subagent_result").execute(
      "tc-stopping-read",
      { agent_id: id },
      undefined,
      undefined,
      ctx(),
    );
    expect(textOf(stopping)).toContain("Agent is stopping. Worktree preservation is still pending");
    expect(pi.sendMessage).not.toHaveBeenCalled();

    vi.mocked(cleanupWorktree).mockReturnValueOnce({
      hasChanges: true,
      path: "/tmp/pi-agent-stopping",
      error: "commit worktree changes failed: Author identity unknown",
    });
    finishRun?.({
      responseText: "STOPPED-PARTIAL-OUTPUT",
      session: { dispose: vi.fn() },
      aborted: false,
      steered: false,
    });
    await awaitBackgroundSettlement();

    expect(pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      details: expect.objectContaining({
        status: "stopped",
        error: expect.stringContaining("/tmp/pi-agent-stopping"),
        resultPreview: "STOPPED-PARTIAL-OUTPUT",
      }),
    }), expect.anything());

    await lifecycle.get("session_shutdown")?.();
  });

  it("exposes a worktree preservation failure through retrieval, outcome, and notification", async () => {
    writeFileSync(
      join(agentDir, "agents", "general-purpose.md"),
      "---\ntools: read\nisolation: worktree\n---\nRead.",
    );
    vi.mocked(createWorktree).mockReturnValueOnce({
      path: "/tmp/pi-agent-retained", branch: "pi-agent-retained", baseSha: "base", workPath: "/tmp/pi-agent-retained",
    });
    vi.mocked(cleanupWorktree).mockReturnValueOnce({
      hasChanges: true,
      path: "/tmp/pi-agent-retained",
      error: "commit worktree changes failed: Author identity unknown",
    });
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "CHILD-PARTIAL-OUTPUT",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    } as any);
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);

    const id = await spawnBackground(tools, "tc-preservation-spawn", "preserve worktree");
    await awaitBackgroundSettlement();

    const retrieved = await tools.get("get_subagent_result").execute(
      "tc-preservation-read",
      { agent_id: id },
      undefined,
      undefined,
      ctx(),
    );
    expect(textOf(retrieved)).toContain("Worktree preservation failed");
    expect(textOf(retrieved)).toContain("Partial output before the failure:\nCHILD-PARTIAL-OUTPUT");

    const outcome = branch.find((entry) => entry.customType === "subagents:record" && entry.data?.id === id);
    expect(outcome?.data).toEqual(expect.objectContaining({
      status: "error",
      error: expect.stringContaining("/tmp/pi-agent-retained"),
      result: "CHILD-PARTIAL-OUTPUT",
    }));
    expect(pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      details: expect.objectContaining({
        error: expect.stringContaining("Worktree preservation failed"),
        resultPreview: "CHILD-PARTIAL-OUTPUT",
      }),
    }), expect.anything());

    await lifecycle.get("session_shutdown")?.();
  });

  it("does not resurrect an older durable result when resumed-result persistence fails", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "OLDER-DURABLE-RESULT",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    } as any);
    vi.mocked(resumeAgent).mockResolvedValue({ text: "NEW-LIVE-ONLY-RESULT" } as any);
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);

    const id = await spawnBackground(tools, "tc-resume-spawn", "resumed persistence");
    await awaitBackgroundSettlement();
    pi.appendEntry.mockImplementation((customType: string, data: any) => {
      if (customType === "subagents:record" && data.result === "NEW-LIVE-ONLY-RESULT") {
        throw new Error("resumed result storage unavailable");
      }
      branch.push({ type: "custom", customType, data, id: `e${branch.length}`, parentId: null, timestamp: new Date().toISOString() });
    });

    const resumed = await tools.get("Agent").execute(
      "tc-resume",
      { resume: id, prompt: "continue", description: "resume persistence", subagent_type: "general-purpose" },
      undefined, undefined, ctx(),
    );
    expect(textOf(resumed)).toContain("NEW-LIVE-ONLY-RESULT");
    expect(textOf(resumed)).toContain("Persistence: failed — resumed result storage unavailable; result is live-only");
    expect(branch).toContainEqual(expect.objectContaining({
      customType: "subagents:execution",
      data: { id },
    }));

    vi.advanceTimersByTime(11 * 60_000);
    const evicted = await tools.get("get_subagent_result").execute(
      "tc-resume-evicted", { agent_id: id }, undefined, undefined, ctx(),
    );
    expect(textOf(evicted)).toContain("no durable result exists");
    expect(textOf(evicted)).not.toContain("OLDER-DURABLE-RESULT");

    await lifecycle.get("session_shutdown")?.();
  });

  it("persists a stopped fresh foreground call that is already aborted", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const controller = new AbortController();
    controller.abort();

    await tools.get("Agent").execute(
      "tc-pre-aborted-fresh",
      { prompt: "go", description: "pre-aborted fresh", subagent_type: "general-purpose" },
      controller.signal, undefined, ctx(),
    );
    expect(branch.at(-1)).toEqual(expect.objectContaining({
      customType: "subagents:record",
      data: expect.objectContaining({ status: "stopped" }),
    }));
    expect(pi.sendMessage).not.toHaveBeenCalled();

    await lifecycle.get("session_shutdown")?.();
  });

  it("persists a stopped outcome when a resume is cancelled before starting", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "OLDER-DURABLE-RESULT",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    } as any);
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);

    const id = await spawnBackground(tools, "tc-cancelled-resume-spawn", "cancelled resume");
    await awaitBackgroundSettlement();
    pi.sendMessage.mockClear();
    const controller = new AbortController();
    controller.abort();
    await tools.get("Agent").execute(
      "tc-cancelled-resume",
      { resume: id, prompt: "continue", description: "cancel resume", subagent_type: "general-purpose" },
      controller.signal, undefined, ctx(),
    );
    expect(branch.slice(-2).map(({ customType }) => customType)).toEqual([
      "subagents:execution",
      "subagents:record",
    ]);
    expect(branch.at(-1)?.data).toEqual(expect.objectContaining({ id, status: "stopped" }));
    expect(pi.sendMessage).not.toHaveBeenCalled();

    vi.advanceTimersByTime(11 * 60_000);
    const evicted = await tools.get("get_subagent_result").execute(
      "tc-cancelled-resume-evicted", { agent_id: id }, undefined, undefined, ctx(),
    );
    expect(textOf(evicted)).toContain("Status: stopped");
    expect(textOf(evicted)).not.toContain("OLDER-DURABLE-RESULT");

    await lifecycle.get("session_shutdown")?.();
  });

  it("surfaces appendEntry failures only while the result remains live", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "LIVE-ONLY-RESULT",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    } as any);
    const { pi, tools, lifecycle } = makePi();
    pi.appendEntry.mockImplementation(() => { throw new Error("session storage unavailable"); });
    subagentsExtension(pi);

    const foreground = await tools.get("Agent").execute(
      "tc-persistence-foreground",
      { prompt: "go", description: "foreground persistence", subagent_type: "general-purpose" },
      undefined, undefined, ctx(),
    );
    expect(textOf(foreground)).toContain("Persistence: failed — session storage unavailable; result is live-only");

    const id = await spawnBackground(tools, "tc-persistence-background", "background persistence");
    await awaitBackgroundSettlement();

    expect(pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      details: expect.objectContaining({
        persistenceFailure: "session storage unavailable",
      }),
    }), expect.anything());
    const notification = pi.sendMessage.mock.calls.at(-1)?.[0];
    const renderer = pi.registerMessageRenderer.mock.calls.find(([name]: any[]) => name === "subagent-notification")?.[1];
    const component = renderer(notification, { expanded: false }, {
      fg: (_role: string, text: string) => text,
      bold: (text: string) => text,
    });
    expect(component.render(120).join("\n")).toContain(
      "Persistence failed: session storage unavailable; result is live-only",
    );

    const live = await tools.get("get_subagent_result").execute(
      "tc-persistence-live", { agent_id: id }, undefined, undefined, ctx(),
    );
    expect(textOf(live)).toContain("Persistence: failed — session storage unavailable; result is live-only");

    vi.advanceTimersByTime(11 * 60_000);
    const evicted = await tools.get("get_subagent_result").execute(
      "tc-persistence-evicted", { agent_id: id }, undefined, undefined, ctx(),
    );
    expect(textOf(evicted)).toContain("Agent not found");

    await lifecycle.get("session_shutdown")?.();
  });

  it("supplies a visible detail when appendEntry throws an empty Error", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "LIVE-ONLY-RESULT",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    } as any);
    const { pi, tools, lifecycle } = makePi();
    pi.appendEntry.mockImplementation(() => { throw new Error(""); });
    subagentsExtension(pi);

    const result = await tools.get("Agent").execute(
      "tc-empty-persistence-error",
      { prompt: "go", description: "empty persistence error", subagent_type: "general-purpose" },
      undefined, undefined, ctx(),
    );
    expect(textOf(result)).toContain("Persistence: failed — unknown persistence failure; result is live-only");

    await lifecycle.get("session_shutdown")?.();
  });

  it("keeps retained live-record retrieval on its existing path", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "LIVE-RESULT",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    } as any);

    const spawned = await tools.get("Agent").execute(
      "tc-live-spawn",
      { prompt: "go", description: "live control", subagent_type: "general-purpose", run_in_background: true },
      undefined,
      undefined,
      ctx(),
    );
    const id = /Agent ID: (\S+)/.exec(textOf(spawned))![1];
    await flush();

    const liveCtx = ctx();
    const result = await tools.get("get_subagent_result").execute(
      "tc-live-read",
      { agent_id: id },
      undefined,
      undefined,
      liveCtx,
    );
    expect(textOf(result)).toContain("LIVE-RESULT");
    expect(liveCtx.sessionManager.getBranch).not.toHaveBeenCalled();

    await lifecycle.get("session_shutdown")?.();
  });
});
