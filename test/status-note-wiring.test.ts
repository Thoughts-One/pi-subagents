/**
 * status-note-wiring.test.ts — proves the status note actually reaches the
 * PARENT through the real tool handlers, not just that getStatusNote() returns
 * a string. Drives the registered `Agent` / `get_subagent_result` tools and
 * inspects the text delivered back, for a turn-limit abort and a user stop.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

vi.mock("../src/worktree.js", async () => {
  const actual = await vi.importActual<typeof import("../src/worktree.js")>("../src/worktree.js");
  return { ...actual, cleanupWorktree: vi.fn(), createWorktree: vi.fn() };
});

import { AgentManager } from "../src/agent-manager.js";
import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { cleanupWorktree, createWorktree } from "../src/worktree.js";

function makePi() {
  const tools = new Map<string, any>();
  const eventHandlers = new Map<string, any>();
  const lifecycle = new Map<string, any>();
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
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, eventHandlers, lifecycle };
}

// The RPC channels are registered on the first bound session_start (#142), so a
// test that drives them must fire it first — as a real session always does. A
// sessionId-less ctx makes startScheduler short-circuit (no filesystem touch).
async function bind(lifecycle: Map<string, any>) {
  const bindCtx = ctx();
  bindCtx.sessionManager.getSessionId = vi.fn(() => undefined);
  await lifecycle.get("session_start")({}, bindCtx);
}

function ctx() {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd: "/tmp",
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

const textOf = (r: any): string => r.content[0].text;

describe("status note reaches the parent through the real handlers", () => {
  let agentDir: string;
  let priorAgentDir: string | undefined;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "pi-status-agent-dir-"));
    priorAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    writeFileSync(join(agentDir, "agents", "general-purpose.md"), "---\ntools: read\n---\nRead.");
  });

  afterEach(() => {
    if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
    delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
    vi.restoreAllMocks();
  });

  it("foreground turn-limit abort → the Agent result flags an incomplete outcome", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "partial work so far",
      session: { dispose: vi.fn() } as any,
      aborted: true, // hard turn-limit abort
      steered: false,
    });
    const { pi, tools } = makePi();
    subagentsExtension(pi);

    const res = await tools.get("Agent").execute(
      "tc1",
      { prompt: "go", description: "d", subagent_type: "general-purpose" },
      undefined, undefined, ctx(),
    );

    const out = textOf(res);
    // Exact lead clause, not just "turn limit": a steered/aborted mix-up would
    // otherwise slip through, and they are different outcomes.
    expect(out).toContain("aborted at the turn limit");
    expect(out).toContain("partial work so far");     // partial result still delivered
    expect(out).not.toContain("STOPPED BY THE USER"); // not mislabelled as a user stop

    // The two answers a foreground parent needs: is this all of it, and is the
    // task done. The first is what #174 turned on — the parent has no agent id,
    // so it must not read "partial" as "go fetch the rest".
    expect(out).toContain("everything the agent produced is above");
    expect(out).toContain("the task is unfinished");
    // State only, never an instruction to act (see getForegroundOutcomeNote):
    // advising a fresh run to save one wasted tool call is a bet nothing here
    // can measure. And naming the tool we steer away from only raises its salience.
    expect(out).not.toContain("re-spawn");
    expect(out).not.toContain("get_subagent_result");
  });

  it("foreground worktree preservation failure retains the aborted status and partial output", async () => {
    writeFileSync(join(agentDir, "agents", "general-purpose.md"), "---\ntools: read\nisolation: worktree\n---\nRead.");
    vi.mocked(createWorktree).mockReturnValueOnce({
      path: "/tmp/pi-agent-foreground-retained", branch: "pi-agent-foreground-retained", baseSha: "base", workPath: "/tmp/pi-agent-foreground-retained",
    });
    vi.mocked(cleanupWorktree).mockReturnValueOnce({
      hasChanges: true,
      path: "/tmp/pi-agent-foreground-retained",
      error: "commit worktree changes failed: Author identity unknown",
    });
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "partial work so far",
      session: { dispose: vi.fn() } as any,
      aborted: true,
      steered: false,
    });
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);

    const result = await tools.get("Agent").execute(
      "tc-preservation",
      { prompt: "go", description: "d", subagent_type: "general-purpose" },
      undefined, undefined, ctx(),
    );

    expect(result.isError).toBe(true);
    expect(result.details.status).toBe("aborted");
    expect(textOf(result)).toContain("Agent aborted:");
    expect(textOf(result)).toContain("Worktree preservation failed");
    expect(textOf(result)).toContain("/tmp/pi-agent-foreground-retained");
    expect(textOf(result)).toContain("Partial output before the failure:\npartial work so far");
    await lifecycle.get("session_shutdown")?.();
  });

  it("foreground user-stop → tells the parent NOT to restart it unasked", async () => {
    // Pi delivers a user ESC as an abort on the tool's signal; the manager wires
    // that to abort(id) (#44), landing the record on "stopped" — deliberately
    // distinct from a turn-limit "aborted", because the correct next action is
    // the opposite one.
    let finish: (v: any) => void = () => {};
    vi.mocked(runAgent).mockReturnValue(new Promise((r) => { finish = r; }) as any);

    const { pi, tools } = makePi();
    subagentsExtension(pi);

    const parent = new AbortController();
    const call = tools.get("Agent").execute(
      "tc-stop",
      { prompt: "go", description: "d", subagent_type: "general-purpose" },
      parent.signal, undefined, ctx(),
    );

    // The manager only wires addEventListener("abort", …) and never checks
    // signal.aborted upfront (agent-manager.ts:240-243), so aborting before the
    // listener is attached would silently land on "completed" instead. Flush
    // first rather than relying on spawn() happening in execute()'s synchronous
    // prefix, which any future await in that path would quietly break.
    await new Promise((r) => setImmediate(r));
    parent.abort(); // the user hits ESC
    finish({ responseText: "partial work so far", session: { dispose: vi.fn() }, aborted: false, steered: false });

    const out = textOf(await call);
    expect(out).toContain("STOPPED BY THE USER");
    expect(out).toContain("everything the agent produced is above");
    // Same claim, same confidence, same words as the aborted case — only the
    // lead clause distinguishes them.
    expect(out).toContain("the task is unfinished");
    // State only, here most of all. Advice to re-spawn would re-run work a human
    // deliberately killed; advice to ask first presumes someone is there to ask,
    // which is false under `pi -p`, scheduled jobs, and background-driven runs.
    expect(out).not.toContain("re-spawn");
    expect(out).not.toContain("ask before");
  });

  it("hides nested records from top-level tools, registry, sessions, and lifecycle", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "nested result",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    });
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    const registry = (globalThis as any)[Symbol.for("pi-subagents:manager")];

    // External registry/RPC callers cannot mint internal ownership metadata.
    const topId = registry.spawn(pi, ctx(), "general-purpose", "top", {
      description: "top-level owner",
      isBackground: false,
      parentAgentId: "forged-parent",
      depth: 99,
      maxSubagentDepth: 99,
      configCwd: "/untrusted/config",
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(registry.getRecord(topId)).toEqual(expect.objectContaining({
      parentAgentId: undefined,
      depth: 1,
    }));

    // Internal scoped tools receive the raw owning manager through nestedRuntime.
    const rawManager = vi.mocked(runAgent).mock.lastCall![3].nestedRuntime.manager;
    pi.events.emit.mockClear();
    pi.appendEntry.mockClear();
    pi.sendMessage.mockClear();
    const id = rawManager.spawn(pi, ctx(), "general-purpose", "nested", {
      description: "nested child",
      isBackground: true,
      parentAgentId: topId,
      depth: 2,
      maxSubagentDepth: 2,
    });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(registry.getRecord(id)).toBeUndefined();
    const topLevelCtx = ctx();
    topLevelCtx.sessionManager.getBranch.mockReturnValue([{
      type: "custom",
      customType: "subagents:record",
      data: { id, status: "completed", result: "must stay hidden" },
      id: "forged-nested-outcome",
      parentId: null,
      timestamp: new Date().toISOString(),
    }]);
    for (const [name, params] of [
      ["get_subagent_result", { agent_id: id }],
      ["steer_subagent", { agent_id: id, message: "stop" }],
      ["Agent", { resume: id, prompt: "continue", description: "resume", subagent_type: "general-purpose" }],
    ] as const) {
      const result = await tools.get(name).execute("tc-nested", params, undefined, undefined, topLevelCtx);
      expect(textOf(result)).toContain("Agent not found");
      expect(textOf(result)).not.toContain("must stay hidden");
    }
    expect(topLevelCtx.sessionManager.getBranch).not.toHaveBeenCalled();
    expect(pi.events.emit).not.toHaveBeenCalledWith("subagents:started", expect.objectContaining({ id }));
    expect(pi.events.emit).not.toHaveBeenCalledWith("subagents:completed", expect.objectContaining({ id }));
    expect(pi.events.emit).not.toHaveBeenCalledWith("subagents:failed", expect.objectContaining({ id }));
    expect(pi.appendEntry).not.toHaveBeenCalledWith("subagents:record", expect.objectContaining({ id }));
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("does not notify twice when a queued foreground agent is cancelled", async () => {
    vi.mocked(runAgent).mockReturnValue(new Promise(() => {}) as any);
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    for (let index = 0; index < 4; index++) {
      await tools.get("Agent").execute(
        `tc-slot-${index}`,
        { prompt: "hold", description: `slot ${index}`, subagent_type: "general-purpose", run_in_background: true },
        undefined, undefined, ctx(),
      );
    }

    const controller = new AbortController();
    const pending = tools.get("Agent").execute(
      "tc-queued-foreground",
      { prompt: "wait", description: "queued foreground", subagent_type: "general-purpose" },
      controller.signal, undefined, ctx(),
    );
    await Promise.resolve();
    controller.abort();
    await pending;
    expect(pi.sendMessage).not.toHaveBeenCalled();

    await lifecycle.get("session_shutdown")?.();
  });

  it("top-level steer_subagent awaits delivery and emits only accepted steering", async () => {
    vi.mocked(runAgent).mockReturnValue(new Promise(() => {}) as any);
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const spawn = await tools.get("Agent").execute(
      "tc-steer-spawn",
      { prompt: "go", description: "d", subagent_type: "general-purpose", run_in_background: true },
      undefined, undefined, ctx(),
    );
    const id = textOf(spawn).match(/Agent ID: (\S+)/)?.[1];
    let release!: (result: any) => void;
    const steer = vi.spyOn(AgentManager.prototype, "steer").mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    let settled = false;
    const pending = tools.get("steer_subagent").execute(
      "tc-steer-await", { agent_id: id, message: "redirect" }, undefined, undefined, ctx(),
    ).then((result: any) => { settled = true; return result; });
    await Promise.resolve();
    expect(settled).toBe(false);
    release({ status: "rejected", reason: "delivery_failed", detail: "transport closed" });
    const rejected = await pending;
    expect(rejected.isError).toBe(true);
    expect(textOf(rejected)).toContain("Steering rejected");
    expect(textOf(rejected)).toContain("transport closed");
    expect(pi.events.emit).not.toHaveBeenCalledWith("subagents:steered", expect.anything());

    steer.mockResolvedValueOnce({ status: "queued" });
    const queued = await tools.get("steer_subagent").execute(
      "tc-steer-queued", { agent_id: id, message: "queue this" }, undefined, undefined, ctx(),
    );
    expect(queued.isError).not.toBe(true);
    expect(textOf(queued)).toContain("Steering message queued");
    expect(pi.events.emit).not.toHaveBeenCalledWith("subagents:steered", expect.anything());

    steer.mockResolvedValueOnce({ status: "accepted" });
    const accepted = await tools.get("steer_subagent").execute(
      "tc-steer-accepted", { agent_id: id, message: "accept this" }, undefined, undefined, ctx(),
    );
    expect(accepted.isError).not.toBe(true);
    expect(textOf(accepted)).toContain("Steering message accepted");
    expect(pi.events.emit).toHaveBeenCalledWith("subagents:steered", { id, message: "accept this" });

    await lifecycle.get("session_shutdown")?.();
  });

  it("background user-stop → get_subagent_result flags STOPPED BY THE USER (not completed)", async () => {
    // A background agent that never settles on its own — only a stop ends it.
    vi.mocked(runAgent).mockReturnValue(new Promise(() => {}) as any);
    const { pi, tools, eventHandlers, lifecycle } = makePi();
    subagentsExtension(pi);
    await bind(lifecycle); // register RPC channels via session_start (#142)

    const spawn = await tools.get("Agent").execute(
      "tc2",
      { prompt: "go", description: "d", subagent_type: "general-purpose", run_in_background: true },
      undefined, undefined, ctx(),
    );
    const id = textOf(spawn).match(/Agent ID: (\S+)/)?.[1];
    expect(id, "background spawn should surface an agent id").toBeTruthy();

    // The user stops it — same path the viewer's stop key uses (manager.abort).
    eventHandlers.get("subagents:rpc:stop")?.({ requestId: "r1", agentId: id });

    const res = await tools.get("get_subagent_result").execute(
      "tc3", { agent_id: id }, undefined, undefined, ctx(),
    );

    const out = textOf(res);
    expect(out).toContain("STOPPED BY THE USER");
    expect(out).toContain("the task was NOT finished");
    expect(out).not.toContain("Done"); // not surfaced as a normal completion

    // The background/retrieval path keeps getStatusNote, NOT the foreground
    // note. Its caller holds a 500-char preview and a real agent id, so
    // "everything the agent produced is above" would be a lie here. Folding the
    // two functions back together is exactly the regression this guards.
    expect(out).not.toContain("everything the agent produced is above");
  });
});
