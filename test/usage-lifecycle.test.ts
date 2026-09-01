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

const childModel = { provider: "anthropic", id: "claude-child", name: "Child" };
const usage = (input: number) => ({
  kind: "model" as const,
  model: { provider: childModel.provider, model: childModel.id },
  usage: {
    input,
    output: input + 1,
    cacheRead: input + 2,
    cacheWrite: input + 3,
    cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
  },
});

function setup() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
    registerCommand: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
  } as any;
  const ctx = {
    hasUI: false,
    cwd: process.cwd(),
    model: childModel,
    modelRegistry: {
      find: vi.fn((provider: string, id: string) => provider === childModel.provider && id === childModel.id ? childModel : undefined),
      getAll: vi.fn(() => [childModel]),
      getAvailable: vi.fn(() => [childModel]),
    },
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    sessionManager: { getSessionId: vi.fn(() => "usage-lifecycle"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
  subagentsExtension(pi);
  return { pi, tools, lifecycle, ctx };
}

function params(extra: Record<string, unknown> = {}) {
  return {
    prompt: "Run accounting check.",
    description: "Account child usage",
    subagent_type: "general-purpose",
    ...extra,
  };
}

describe("subagents:record usage settlement", () => {
  let previousCwd: string;
  let root: string;

  beforeEach(() => {
    previousCwd = process.cwd();
    root = mkdtempSync(join(tmpdir(), "usage-lifecycle-"));
    mkdirSync(join(root, ".pi"));
    writeFileSync(join(root, ".pi", "subagents.json"), JSON.stringify({ disableDefaultAgents: false }));
    process.chdir(root);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    rmSync(root, { recursive: true, force: true });
    delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
    vi.restoreAllMocks();
  });

  it.each([false, true])("persists one cumulative content-free snapshot for a %s top-level run", async (runInBackground) => {
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options: any) => {
      options.onUsage?.(usage(10));
      return { responseText: "done", session: { dispose: vi.fn() }, aborted: false, steered: false };
    });
    const { pi, tools, lifecycle, ctx } = setup();

    const result = await tools.get("Agent").execute("call", params(runInBackground ? { run_in_background: true } : {}), undefined, undefined, ctx);
    if (runInBackground) await new Promise(resolve => setImmediate(resolve));
    expect(result.content[0].text).not.toMatch(/Model|agent type|not found/i);

    expect(runAgent).toHaveBeenCalled();
    expect(pi.appendEntry).toHaveBeenCalledWith("subagents:record", expect.objectContaining({
      initialModel: { provider: "anthropic", model: "claude-child" },
      usage: {
        schemaVersion: 1,
        cumulative: true,
        models: {
          "anthropic/claude-child": expect.objectContaining({ calls: 1, input: 10, output: 11, cacheRead: 12, cacheWrite: 13 }),
        },
        unattributedTools: {},
      },
    }));
    await lifecycle.get("session_shutdown")?.();
  });

  it("persists usage accumulated before an error settlement", async () => {
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options: any) => {
      options.onUsage?.(usage(20));
      throw new Error("provider failed");
    });
    const { pi, tools, lifecycle, ctx } = setup();

    await tools.get("Agent").execute("call", params(), undefined, undefined, ctx);

    expect(pi.appendEntry).toHaveBeenCalledWith("subagents:record", expect.objectContaining({
      status: "error",
      usage: expect.objectContaining({
        models: { "anthropic/claude-child": expect.objectContaining({ calls: 1, input: 20 }) },
      }),
    }));
    await lifecycle.get("session_shutdown")?.();
  });

  it("keeps each cumulative snapshot immutable after resume settlement", async () => {
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options: any) => {
      options.onUsage?.(usage(1));
      return { responseText: "first", session: { dispose: vi.fn() }, aborted: false, steered: false };
    });
    vi.mocked(resumeAgent).mockImplementation(async (_session, _prompt, options: any) => {
      options.onUsage?.(usage(5));
      return { text: "second" };
    });
    const { pi, tools, lifecycle, ctx } = setup();

    const started = await tools.get("Agent").execute("call", params({ run_in_background: true }), undefined, undefined, ctx);
    const id = started.content[0].text.match(/Agent ID: (\S+)/)?.[1];
    await new Promise(resolve => setImmediate(resolve));
    const firstRecord = pi.appendEntry.mock.calls[0][1];

    await tools.get("Agent").execute("call", params({ resume: id }), undefined, undefined, ctx);

    const secondRecord = pi.appendEntry.mock.calls[1][1];
    expect(firstRecord.usage).toMatchObject({
      cumulative: true,
      models: { "anthropic/claude-child": expect.objectContaining({ calls: 1, input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }) },
    });
    expect(secondRecord).toEqual(expect.objectContaining({
      id,
      usage: expect.objectContaining({
        cumulative: true,
        models: { "anthropic/claude-child": expect.objectContaining({ calls: 2, input: 6, output: 8, cacheRead: 10, cacheWrite: 12 }) },
      }),
    }));
    expect(secondRecord.usage).not.toBe(firstRecord.usage);
    await lifecycle.get("session_shutdown")?.();
  });
});
