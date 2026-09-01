import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
    cwd,
    model: undefined,
    modelRegistry: { find: vi.fn(), getAll: vi.fn(() => []), getAvailable: vi.fn(() => []) },
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    sessionManager: { getSessionId: vi.fn(() => "session"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

const textOf = (result: any): string => result.content[0].text;

describe("audit_documents", () => {
  let root: string;
  let agentDir: string;
  let previousCwd: string;
  let previousAgentDir: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "documentation-audit-"));
    agentDir = mkdtempSync(join(tmpdir(), "documentation-audit-agent-"));
    previousCwd = process.cwd();
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    mkdirSync(join(root, ".pi", "agents"), { recursive: true });
    writeFileSync(join(root, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false }));
    writeFileSync(join(root, ".pi", "agents", "documentation-auditor.md"), "---\ndescription: Documentation Auditor\ntools: read\nextensions: false\nskills: false\n---\nAudit.");
    writeFileSync(join(root, "guide.md"), "Guide");
    process.chdir(root);
  });

  afterEach(async () => {
    process.chdir(previousCwd);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
    vi.restoreAllMocks();
  });

  function validRequest() {
    return {
      description: "Audit project documentation",
      objective: "Classify the documentation artifact.",
      manifest: [join(root, "guide.md")],
      authority_roots: [root],
      labels: [{ name: "DONE", definition: "The documented work is complete." }],
      precedence: "none",
      disposition_rules: [{ artifact_type: "guide", rule: "Keep accurate guides." }],
      reference_evidence: [{ artifact: join(root, "guide.md"), references: ["zero-hit: parent searched project basenames"] }],
    };
  }

  it("rejects every typed omission and invalid form with zero side effects", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const audit = tools.get("audit_documents");
    const missing = [
      "description", "objective", "manifest", "authority_roots", "labels", "precedence", "disposition_rules", "reference_evidence",
    ];
    const invalid = [
      { description: "two words" },
      { objective: " " },
      { manifest: ["relative.md"] },
      { authority_roots: [join(root, "guide.md")] },
      { labels: [{ name: "", definition: "definition" }] },
      { precedence: [] },
      { disposition_rules: [{ artifact_type: "", rule: "rule" }] },
      { reference_evidence: [{ artifact: join(root, "guide.md"), references: ["bad"] }] },
      { run_in_background: "true" },
      { prompt: "forbidden" },
      { model: "forbidden" },
      { resume: "forbidden" },
      { schedule: "+1h" },
      { labels: [{ name: "DONE", definition: "definition", extra: "forbidden" }] },
      { disposition_rules: [{ artifact_type: "guide", rule: "keep", extra: "forbidden" }] },
      { reference_evidence: [{ artifact: join(root, "guide.md"), references: ["zero-hit: parent searched"], extra: "forbidden" }] },
    ];
    const observedPreflightFailures = [
      { objective: "" },
      { manifest: [] },
      { authority_roots: [] },
      { labels: [] },
      { labels: [{ name: "DONE", definition: "" }] },
      { precedence: [""] },
      { disposition_rules: [] },
      { disposition_rules: [{ artifact_type: "guide", rule: "" }] },
      { reference_evidence: [] },
      { reference_evidence: [{ artifact: join(root, "guide.md"), references: [] }] },
      { reference_evidence: [{ artifact: join(root, "guide.md"), references: ["zero-hit: "] }] },
      { reference_evidence: [{ artifact: join(root, "guide.md"), references: ["relative.md:1"] }] },
      { reference_evidence: [{ artifact: join(root, "missing.md"), references: ["/tmp/missing.md:1"] }] },
    ];
    const alias = join(root, "guide-alias.md");
    symlinkSync(join(root, "guide.md"), alias);
    const allowed = join(root, "allowed");
    mkdirSync(allowed);
    const aliasesAndEscapes = [
      { manifest: [join(root, "guide.md"), alias] },
      { authority_roots: [allowed] },
    ];

    for (const field of missing) {
      const result = await audit.execute("call", { ...validRequest(), [field]: undefined }, undefined, undefined, context(root));
      expect(textOf(result), `missing ${field}`).not.toBe("");
    }
    for (const patch of [...invalid, ...observedPreflightFailures, ...aliasesAndEscapes]) {
      const result = await audit.execute("call", { ...validRequest(), ...patch }, undefined, undefined, context(root));
      expect(textOf(result), JSON.stringify(patch)).not.toBe("");
    }

    expect(runAgent).not.toHaveBeenCalled();
    expect(pi.appendEntry).not.toHaveBeenCalled();
    expect(pi.events.emit).not.toHaveBeenCalledWith("subagents:created", expect.anything());
    expect(pi.events.emit).not.toHaveBeenCalledWith("subagents:scheduled", expect.anything());
    await lifecycle.get("session_shutdown")?.();
  });

  it("retires the generic documentation-auditor route", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const result = await tools.get("Agent").execute("call", {
      description: "Audit project documentation",
      prompt: "Audit docs.",
      subagent_type: "documentation-auditor",
    }, undefined, undefined, context(root));

    expect(textOf(result)).toContain("audit_documents");
    expect(runAgent).not.toHaveBeenCalled();
    await lifecycle.get("session_shutdown")?.();
  });

  it("renders one canonical prompt and starts the unchanged role", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "OUTCOME: COMPLETE",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    });
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const result = await tools.get("audit_documents").execute("call", validRequest(), undefined, undefined, context(root));

    expect(textOf(result)).toBe("OUTCOME: COMPLETE");
    expect(runAgent).toHaveBeenCalledWith(
      expect.anything(),
      "documentation-auditor",
      expect.stringContaining("DOCUMENTATION AUDIT REQUEST"),
      expect.anything(),
    );
    expect(vi.mocked(runAgent).mock.calls[0][2]).toContain("MANIFEST:\n- ");
    expect(vi.mocked(runAgent).mock.calls[0][2]).toContain("guide.md");
    await lifecycle.get("session_shutdown")?.();
  });

  it("keeps valid background audit lifecycle behavior", async () => {
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}) as any);
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const result = await tools.get("audit_documents").execute("call", {
      ...validRequest(),
      run_in_background: true,
    }, undefined, undefined, context(root));

    expect(textOf(result)).toMatch(/^Documentation audit started in background\.\nAgent ID: /);
    expect(pi.events.emit).toHaveBeenCalledWith("subagents:created", expect.objectContaining({
      type: "documentation-auditor",
      isBackground: true,
    }));
    await lifecycle.get("session_shutdown")?.();
  });

  it("does not resume a completed typed INPUT_REQUIRED gate or mutate its record", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "OUTCOME: INPUT_REQUIRED\nNeed a complete manifest.",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    });
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const started = await tools.get("audit_documents").execute("call", {
      ...validRequest(),
      run_in_background: true,
    }, undefined, undefined, context(root));
    const id = textOf(started).match(/Agent ID: (\S+)/)?.[1];
    expect(id).toBeTruthy();
    await new Promise((resolve) => setImmediate(resolve));
    const registry = (globalThis as any)[Symbol.for("pi-subagents:manager")];
    const before = registry.getRecord(id);

    const runCalls = vi.mocked(runAgent).mock.calls.length;
    const result = await tools.get("Agent").execute("call", {
      description: "Resume typed documentation audit",
      prompt: "Continue.",
      subagent_type: "documentation-auditor",
      resume: id,
    }, undefined, undefined, context(root));

    expect(textOf(result)).toContain("INPUT_REQUIRED gate");
    expect(registry.getRecord(id)).toBe(before);
    expect(before).toEqual(expect.objectContaining({
      status: "completed",
      result: "OUTCOME: INPUT_REQUIRED\nNeed a complete manifest.",
    }));
    expect(runAgent).toHaveBeenCalledTimes(runCalls);
    await lifecycle.get("session_shutdown")?.();
  });

  it("does not resume a steered terminal INPUT_REQUIRED result", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "OUTCOME: INPUT_REQUIRED\nNeed a complete manifest.",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: true,
    });
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const started = await tools.get("audit_documents").execute("call", {
      ...validRequest(),
      run_in_background: true,
    }, undefined, undefined, context(root));
    const id = textOf(started).match(/Agent ID: (\S+)/)?.[1];
    expect(id).toBeTruthy();
    await new Promise((resolve) => setImmediate(resolve));
    const registry = (globalThis as any)[Symbol.for("pi-subagents:manager")];
    expect(registry.getRecord(id)?.status).toBe("steered");

    const result = await tools.get("Agent").execute("call", {
      description: "Resume typed documentation audit",
      prompt: "Continue.",
      subagent_type: "documentation-auditor",
      resume: id,
    }, undefined, undefined, context(root));

    expect(textOf(result)).toContain("INPUT_REQUIRED gate");
    expect(registry.getRecord(id)?.status).toBe("steered");
    await lifecycle.get("session_shutdown")?.();
  });
});
