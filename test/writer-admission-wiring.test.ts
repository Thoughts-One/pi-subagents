import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
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
    modelRegistry: { find: vi.fn(), getAll: vi.fn(() => []), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "writer-admission"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

const textOf = (result: any): string => result.content[0].text;

describe("write-class Agent admission", () => {
  let cwd: string;
  let agentDir: string;
  let previousCwd: string;
  let previousAgentDir: string | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "pi-writer-admission-cwd-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-writer-admission-agent-"));
    previousCwd = process.cwd();
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false }));
    writeFileSync(
      join(agentDir, "agents", "writer.md"),
      "---\ndescription: Writes files\ntools: read, edit\nrun_in_background: false\n---\n\nMake the requested change.\n",
    );
    process.chdir(cwd);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("runs one of two concurrent foreground writers and rejects the other", async () => {
    let finish!: (value: any) => void;
    vi.mocked(runAgent).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const agent = tools.get("Agent");
    const run = (description: string) => agent.execute(
      `call-${description}`,
      { prompt: "change one file", description, subagent_type: "writer" },
      undefined,
      undefined,
      context(cwd),
    );

    const first = run("first writer");
    const second = await run("second writer");

    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(textOf(second)).toContain('Cannot start write-class agent while "first writer" is active.');

    finish({
      responseText: "OUTCOME: COMPLETE",
      session: { dispose: vi.fn(), sessionFile: join(agentDir, "first.jsonl") },
      aborted: false,
      steered: false,
    });
    expect(textOf(await first)).toContain("OUTCOME: COMPLETE");

    await lifecycle.get("session_shutdown")?.({}, context(cwd));
  });
});
