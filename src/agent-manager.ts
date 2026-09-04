/**
 * agent-manager.ts — Tracks agents, background execution, resume support.
 *
 * Top-level agents are subject to a configurable concurrency limit (default: 4).
 * Excess agents are queued and auto-started as running agents complete.
 * Nested children bypass the queue so a parent cannot deadlock waiting for its child.
 */

import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resumeAgent, runAgent, type ToolActivity } from "./agent-runner.js";
import { agentConfigCanWrite, getAgentConfig } from "./agent-types.js";
import {
  claimDocumentationAuditAdmission,
  isBoundDocumentationAuditAdmission,
  isDocumentationAuditorType,
  isUnclaimedDocumentationAuditAdmission,
} from "./documentation-audit.js";
import { resolveModel } from "./model-resolver.js";
import { validateResultContract } from "./result-contract.js";
import type { AgentInvocation, AgentRecord, DocumentationAuditAdmission, IsolationMode, ModelAuthority, SubagentType, ThinkingLevel } from "./types.js";
import { type AttributedUsageEvent, addUsage, createLifetimeUsage } from "./usage.js";
import { cleanupWorktree, createWorktree, pruneWorktrees, } from "./worktree.js";

export type OnAgentComplete = (record: AgentRecord) => void;
export type OnAgentStart = (record: AgentRecord) => void;
export type OnAgentCompact = (record: AgentRecord, info: CompactionInfo) => void;
export type CompactionInfo = { reason: "manual" | "threshold" | "overflow"; tokensBefore: number };

/** Default max concurrent top-level agents. */
const DEFAULT_MAX_CONCURRENT = 4;

/**
 * Validate a caller-supplied SpawnOptions.cwd. `undefined`/`null` mean "unset"
 * (parent cwd). Anything else must be an absolute path to an existing
 * directory — curated errors instead of TypeErrors from path/fs internals
 * (RPC callers send arbitrary JSON: null, numbers, file paths).
 */
function assertFreshDocumentationAuditAdmission(
  type: SubagentType,
  admission: DocumentationAuditAdmission | undefined,
): void {
  if (isDocumentationAuditorType(type) && !isUnclaimedDocumentationAuditAdmission(admission)) {
    throw new Error("documentation-auditor can only be started or resumed through audit_documents.");
  }
}

function assertBoundDocumentationAuditAdmission(record: AgentRecord): void {
  if (isDocumentationAuditorType(record.type) && !isBoundDocumentationAuditAdmission(record.documentationAuditAdmission, record.id)) {
    throw new Error("documentation-auditor can only be started or resumed through audit_documents.");
  }
}

function assertDocumentationAuditResume(record: AgentRecord): void {
  assertBoundDocumentationAuditAdmission(record);
  if (
    isDocumentationAuditorType(record.type)
    && record.result?.split(/\r?\n/, 1)[0] === "OUTCOME: INPUT_REQUIRED"
  ) {
    throw new Error("documentation-auditor completed an INPUT_REQUIRED gate and cannot be resumed.");
  }
}

function resultContractViolation(
  contract: AgentRecord["resultContract"],
  responseText: string,
  failure: string | undefined,
): string | undefined {
  const violation = validateResultContract(contract, responseText);
  if (!violation) return undefined;
  return `Result contract violation: ${violation}${failure ? ` Runner failure: ${failure}` : ""}`;
}

function assertValidSpawnCwd(cwd: unknown): asserts cwd is string | undefined | null {
  if (cwd == null) return;
  if (typeof cwd !== "string" || !isAbsolute(cwd)) {
    throw new Error(`SpawnOptions.cwd must be an absolute path: "${String(cwd)}"`);
  }
  let isDirectory = false;
  try {
    isDirectory = statSync(cwd).isDirectory();
  } catch {
    throw new Error(`SpawnOptions.cwd does not exist: "${cwd}"`);
  }
  if (!isDirectory) {
    throw new Error(`SpawnOptions.cwd is not a directory: "${cwd}"`);
  }
}

/** Whether a record occupies one of the `maxConcurrent` top-level slots. */
function occupiesPoolSlot(record: Pick<AgentRecord, "parentAgentId">): boolean {
  return record.parentAgentId === undefined;
}

interface SpawnArgs {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  type: SubagentType;
  prompt: string;
  options: SpawnOptions;
}

interface QueueEntry {
  id: string;
  start: () => void;
  signal?: AbortSignal;
}

interface SpawnOptions {
  description: string;
  model?: Model<any>;
  /** Registry-specific frontmatter authority, including an explicit unpinned result. */
  modelAuthority?: ModelAuthority;
  maxTurns?: number;
  isolated?: boolean;
  inheritContext?: boolean;
  thinkingLevel?: ThinkingLevel;
  isBackground?: boolean;
  /** Isolation mode — "worktree" creates a temp git worktree for the agent. */
  isolation?: IsolationMode;
  /**
   * Working directory for the agent (absolute path). Default: parent session
   * cwd. The agent's tools operate here, but .pi config (extensions, skills,
   * settings, memory) still loads from the parent session's project — the
   * target directory's `.pi` extensions never execute. With isolation:
   * "worktree", the worktree is created FROM this directory and the result
   * branch lands in that repo.
   */
  cwd?: string;
  /** Resolved invocation snapshot captured for UI display. */
  invocation?: AgentInvocation;
  /** Parent abort signal — when aborted, the subagent is also stopped. */
  signal?: AbortSignal;
  /** Called on tool start/end with activity info (for streaming progress to UI). */
  onToolActivity?: (activity: ToolActivity) => void;
  /** Called on streaming text deltas from the assistant response. */
  onTextDelta?: (delta: string, fullText: string) => void;
  /** Called when the agent session is created (for accessing session stats). */
  onSessionCreated?: (session: AgentSession) => void;
  /** Called at the end of each agentic turn with the cumulative count. */
  onTurnEnd?: (turnCount: number) => void;
  /** Called for each attributed assistant, tool-result, or compaction usage event. */
  onUsage?: (event: AttributedUsageEvent) => void;
  /** Called when the session successfully compacts. */
  onCompaction?: (info: CompactionInfo) => void;
  /** Nesting depth: top-level subagent = 1. */
  depth?: number;
  /** Parent agent ID for ownership-scoped nested controls. */
  parentAgentId?: string;
  /** Effective inherited nesting cap for this branch. */
  maxSubagentDepth?: number;
  /** Config-discovery root inherited by nested launches when it differs from the working directory. */
  configCwd?: string;
  /** Opaque admission issued only by audit_documents after typed validation. */
  documentationAuditAdmission?: DocumentationAuditAdmission;
  /** Registry-resolved mutation class. Nested callers use their branch-local registry. */
  writeClass?: boolean;
}

export class AgentManager {
  private agents = new Map<string, AgentRecord>();
  private cleanupInterval: ReturnType<typeof setInterval>;
  private onComplete?: OnAgentComplete;
  private onStart?: OnAgentStart;
  private onCompact?: OnAgentCompact;
  private maxConcurrent: number;
  /** Base repos worktrees were created from — so dispose() can prune them all,
   *  not just the parent repo (caller-supplied cwd can target other repos). */
  private worktreeRepos = new Set<string>();

  /** Queue of top-level fresh or resumed executions waiting for a slot. */
  private queue: QueueEntry[] = [];
  /** Every execution that has started and has not settled. */
  private activeExecutions = new Set<string>();
  /** Top-level executions that currently own a concurrency slot. */
  private runningTopLevel = new Set<string>();
  /** Resolves the stable completion promise created before an execution can queue. */
  private completionResolvers = new Map<string, (result: string) => void>();
  /** Abort listeners attached while an execution waits in the queue. */
  private queuedAbortCleanups = new Map<string, () => void>();
  /** One reserved writer per immediate parent session, including queued writers. */
  private writerOwners = new Map<string | undefined, string>();
  private persistSessionDefault = true;
  private sessionDirDefault: string | undefined;

  constructor(
    onComplete?: OnAgentComplete,
    maxConcurrent = DEFAULT_MAX_CONCURRENT,
    onStart?: OnAgentStart,
    onCompact?: OnAgentCompact,
  ) {
    this.onComplete = onComplete;
    this.onStart = onStart;
    this.onCompact = onCompact;
    this.maxConcurrent = maxConcurrent;
    // Cleanup completed agents after 10 minutes (but keep sessions for resume)
    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
    this.cleanupInterval.unref();
  }

  /** Update the max concurrent top-level agents limit. */
  setMaxConcurrent(n: number) {
    this.maxConcurrent = Math.max(1, n);
    this.drainQueue();
  }

  getMaxConcurrent(): number {
    return this.maxConcurrent;
  }

  setPersistSessionDefault(value: boolean): void {
    this.persistSessionDefault = value;
  }

  getPersistSessionDefault(): boolean {
    return this.persistSessionDefault;
  }

  setSessionDirDefault(value: string | undefined): void {
    this.sessionDirDefault = value;
  }

  getSessionDirDefault(): string | undefined {
    return this.sessionDirDefault;
  }

  private createCompletion(record: AgentRecord): void {
    let settle!: (result: string) => void;
    record.promise = new Promise<string>((resolve) => { settle = resolve; });
    this.completionResolvers.set(record.id, settle);
  }

  private settleCompletion(id: string, result = ""): void {
    this.completionResolvers.get(id)?.(result);
    this.completionResolvers.delete(id);
  }

  private writerOwner(parentAgentId: string | undefined): AgentRecord | undefined {
    const id = this.writerOwners.get(parentAgentId);
    return id === undefined ? undefined : this.agents.get(id);
  }

  private reserveWriter(
    record: Pick<AgentRecord, "id" | "isWriteClass" | "parentAgentId">,
    operation: "start" | "resume" = "start",
  ): void {
    if (!record.isWriteClass) return;
    const owner = this.writerOwner(record.parentAgentId);
    if (owner) {
      throw new Error(`Cannot ${operation} write-class agent while "${owner.description}" is active.`);
    }
    this.writerOwners.set(record.parentAgentId, record.id);
  }

  private releaseWriter(record: Pick<AgentRecord, "id" | "isWriteClass" | "parentAgentId">): void {
    if (record.isWriteClass && this.writerOwners.get(record.parentAgentId) === record.id) {
      this.writerOwners.delete(record.parentAgentId);
    }
  }

  private armQueuedAbort(entry: QueueEntry): void {
    if (!entry.signal) return;
    const onAbort = () => this.abort(entry.id);
    entry.signal.addEventListener("abort", onAbort, { once: true });
    this.queuedAbortCleanups.set(entry.id, () => entry.signal?.removeEventListener("abort", onAbort));
  }

  private disarmQueuedAbort(id: string): void {
    this.queuedAbortCleanups.get(id)?.();
    this.queuedAbortCleanups.delete(id);
  }

  private finishExecution(record: AgentRecord): void {
    this.activeExecutions.delete(record.id);
    this.runningTopLevel.delete(record.id);
    this.releaseWriter(record);
    this.drainQueue();
  }

  /** Add usage to its owning record and every visible ancestor. */
  private accumulateUsage(record: AgentRecord, event: AttributedUsageEvent): void {
    for (let current: AgentRecord | undefined = record; current !== undefined; ) {
      addUsage(current.lifetimeUsage, event);
      current = current.parentAgentId === undefined ? undefined : this.agents.get(current.parentAgentId);
    }
  }

  /**
   * Spawn an agent and return its ID immediately (for background use).
   * If the concurrency limit is reached, the agent is queued.
   */
  spawn(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: SpawnOptions,
  ): string {
    // Validate before the queue branch — a queued spawn should fail at the
    // call, not minutes later at drain. Throw (not warn): programmatic callers
    // can fix and retry; the RPC layer converts throws into error envelopes.
    assertFreshDocumentationAuditAdmission(type, options.documentationAuditAdmission);
    assertValidSpawnCwd(options.cwd);
    // Reject an unavailable configured pin before creating a record, queueing,
    // or creating a worktree. Callers carrying a nested registry provide its
    // authority explicitly; external callers resolve against the global registry.
    const modelAuthority: ModelAuthority = options.modelAuthority ?? { configuredModel: getAgentConfig(type)?.model };
    const resolvedModel = modelAuthority.configuredModel
      ? resolveModel(modelAuthority.configuredModel, ctx.modelRegistry)
      : options.model ?? ctx.model;
    if (typeof resolvedModel === "string") throw new Error(resolvedModel);
    const resolvedOptions: SpawnOptions = { ...options, model: resolvedModel, modelAuthority };

    const writeClass = options.writeClass ?? agentConfigCanWrite(getAgentConfig(type));
    const activeWriter = writeClass ? this.writerOwner(options.parentAgentId) : undefined;
    if (activeWriter) {
      throw new Error(`Cannot start write-class agent while "${activeWriter.description}" is active.`);
    }

    const id = randomUUID().slice(0, 17);
    if (isDocumentationAuditorType(type) && !claimDocumentationAuditAdmission(options.documentationAuditAdmission, id)) {
      throw new Error("documentation-auditor admission was already used.");
    }
    const abortController = new AbortController();
    const record: AgentRecord = {
      id,
      type,
      description: options.description,
      status: "queued",
      toolUses: 0,
      startedAt: Date.now(),
      abortController,
      lifetimeUsage: createLifetimeUsage(),
      initialModel: resolvedModel ? { provider: resolvedModel.provider, model: resolvedModel.id } : undefined,
      compactionCount: 0,
      // Raw tri-state (not coerced to a boolean): true = background, false =
      // foreground (has an inline tool-result surface), undefined = caller never
      // declared it (e.g. a cross-extension RPC spawn). The widget's background-
      // only filter excludes only explicit `false`, so undefined agents — which
      // have no inline surface — stay visible instead of vanishing.
      isBackground: options.isBackground,
      invocation: options.invocation,
      depth: options.depth ?? 1,
      parentAgentId: options.parentAgentId,
      maxSubagentDepth: options.maxSubagentDepth,
      documentationAuditAdmission: options.documentationAuditAdmission,
      resultContract: getAgentConfig(type)?.resultContract,
      isWriteClass: writeClass,
    };
    this.agents.set(id, record);
    this.createCompletion(record);
    this.reserveWriter(record);

    if (options.signal?.aborted) {
      record.status = "stopped";
      record.completedAt = Date.now();
      this.releaseWriter(record);
      this.settleCompletion(id);
      return id;
    }

    const args: SpawnArgs = { pi, ctx, type, prompt, options: resolvedOptions };
    const entry: QueueEntry = {
      id,
      signal: options.signal,
      start: () => this.startAgent(id, record, args),
    };

    if (occupiesPoolSlot(record) && this.runningTopLevel.size >= this.maxConcurrent) {
      record.status = "queued";
      this.queue.push(entry);
      this.armQueuedAbort(entry);
      return id;
    }

    // startAgent can throw (e.g. strict worktree-isolation failure) — clean
    // up the record and writer reservation so callers see the direct error.
    try {
      entry.start();
    } catch (err) {
      this.agents.delete(id);
      this.activeExecutions.delete(id);
      this.runningTopLevel.delete(id);
      this.releaseWriter(record);
      this.completionResolvers.delete(id);
      throw err;
    }
    return id;
  }

  /** Actually start an agent (called immediately or from queue drain). */
  private startAgent(id: string, record: AgentRecord, { pi, ctx, type, prompt, options }: SpawnArgs) {
    this.disarmQueuedAbort(id);
    if (options.signal?.aborted) {
      record.status = "stopped";
      record.completedAt = Date.now();
      this.releaseWriter(record);
      this.settleCompletion(id);
      return;
    }
    // Re-validate a caller-supplied cwd: queued spawns can start minutes after
    // spawn()'s check, and the directory may be gone by then (TOCTOU). Same
    // curated errors; drainQueue parks a throw on the record as an error.
    assertBoundDocumentationAuditAdmission(record);
    assertValidSpawnCwd(options.cwd);
    // Single resolution point for the caller-supplied cwd — the worktree base
    // repo and both cleanup calls below MUST agree on this value forever.
    const customCwd = options.cwd ?? undefined; // null (RPC "unset") → undefined
    const baseCwd = customCwd ?? ctx.cwd;

    // Worktree isolation: try to create a temporary git worktree. Strict —
    // fail loud if not possible (no silent fallback to main tree). Done
    // BEFORE state mutation so a throw doesn't leave the record half-running.
    let worktreeCwd: string | undefined;
    if (options.isolation === "worktree") {
      const wt = createWorktree(baseCwd, id);
      if (!wt) {
        throw new Error(
          'Cannot run with isolation: "worktree" — not a git repo, no commits yet, or `git worktree add` failed. ' +
          'Initialize git and commit at least once, or omit `isolation`.',
        );
      }
      record.worktree = wt;
      // workPath preserves subdirectory scoping for caller-supplied cwds: a
      // cwd deep in a monorepo maps to the same subdir inside the copy, not
      // the copied repo's root. Plain worktree spawns keep the historical
      // behavior (agent at the copy's root) — moving them to workPath would
      // also move .pi config discovery when the parent session sits in a repo
      // subdirectory, silently dropping extensions/skills.
      worktreeCwd = customCwd !== undefined ? wt.workPath : wt.path;
      this.worktreeRepos.add(baseCwd);
    }

    record.status = "running";
    record.startedAt = Date.now();
    this.activeExecutions.add(id);
    if (occupiesPoolSlot(record)) this.runningTopLevel.add(id);
    this.onStart?.(record);

    // Wire parent abort signal to stop the subagent when the parent is interrupted
    let detachParentSignal: (() => void) | undefined;
    if (options.signal) {
      const onParentAbort = () => this.abort(id);
      options.signal.addEventListener("abort", onParentAbort, { once: true });
      detachParentSignal = () => options.signal!.removeEventListener("abort", onParentAbort);
    }
    const detach = () => { detachParentSignal?.(); detachParentSignal = undefined; };

    const execution = runAgent(ctx, type, prompt, {
      pi,
      agentId: id,
      model: options.model,
      modelAuthority: options.modelAuthority,
      maxTurns: options.maxTurns,
      isolated: options.isolated,
      inheritContext: options.inheritContext,
      thinkingLevel: options.thinkingLevel,
      persistSessionDefault: this.persistSessionDefault,
      sessionDirDefault: this.sessionDirDefault,
      // Worktree wins for the working dir (the agent must run in the copy —
      // which, with a custom cwd, was created from that target). Config stays
      // with the parent project when a caller-supplied cwd is in play; it must
      // stay undefined otherwise so plain worktree runs keep resolving config
      // (incl. relative extension paths and memory) inside the worktree copy.
      cwd: worktreeCwd ?? customCwd,
      configCwd: options.configCwd ?? (customCwd !== undefined ? ctx.cwd : undefined),
      signal: record.abortController!.signal,
      onToolActivity: (activity) => {
        if (activity.type === "end") record.toolUses++;
        options.onToolActivity?.(activity);
      },
      onTurnEnd: options.onTurnEnd,
      onTextDelta: options.onTextDelta,
      onUsage: (event) => {
        this.accumulateUsage(record, event);
        options.onUsage?.(event);
      },
      onCompaction: (info) => {
        record.compactionCount++;
        this.onCompact?.(record, info);
        options.onCompaction?.(info);
      },
      nestedRuntime: {
        manager: this,
        parentAgentId: id,
        depth: record.depth ?? 1,
        maxSubagentDepth: record.maxSubagentDepth,
      },
      onSessionCreated: (session) => {
        record.session = session;
        record.sessionFile = session.sessionFile;
        // Flush any steers that arrived before the session was ready
        if (record.pendingSteers?.length) {
          for (const msg of record.pendingSteers) {
            session.steer(msg).catch(() => {});
          }
          record.pendingSteers = undefined;
        }
        options.onSessionCreated?.(session);
      },
    })
      .then(({ responseText, session, aborted, steered, failure }) => {
        const contractError = resultContractViolation(record.resultContract, responseText, failure);
        // A declared result contract is authoritative: an invalid outer result
        // is a package error even if the runner also reports another terminal state.
        if (contractError) {
          record.status = "error";
          record.error = contractError;
        // Don't overwrite status if externally stopped via abort().
        } else if (record.status !== "stopped") {
          // Precedence: a hard abort keeps "aborted"; then a failed final turn
          // (provider error that pi resolved instead of rejecting, #144) is an
          // honest "error" — not a completion with an empty or stale result.
          if (aborted) {
            record.status = "aborted";
          } else if (failure) {
            record.status = "error";
            record.error = failure;
          } else {
            record.status = steered ? "steered" : "completed";
          }
        }
        record.result = responseText;
        record.session = session;
        record.sessionFile = session.sessionFile;
        record.completedAt ??= Date.now();

        detach();

        // Clean up worktree if used
        if (record.worktree) {
          const wtResult = cleanupWorktree(baseCwd, record.worktree, options.description);
          record.worktreeResult = wtResult;
          if (wtResult.hasChanges && wtResult.branch) {
            // With a caller-supplied cwd the branch lives in THAT repo, not the
            // parent session's — say so, or the orchestrator merges in the wrong repo.
            const repoNote = customCwd !== undefined ? ` in \`${baseCwd}\`` : "";
            record.result = (record.result ?? "") +
              `\n\n---\nChanges saved to branch \`${wtResult.branch}\`${repoNote}. Merge with: \`git merge ${wtResult.branch}\`${customCwd !== undefined ? ` (run in \`${baseCwd}\`)` : ""}`;
          }
        }

        this.abortOwnedChildren(id);

        // Fire onComplete for foreground agents too — lifecycle symmetry.
        // Mark resultConsumed so the callback skips notifications (result returned inline).
        if (!options.isBackground) record.resultConsumed = true;
        try { this.onComplete?.(record); } catch { /* ignore completion side-effect errors */ }
        this.finishExecution(record);
        return responseText;
      })
      .catch((err) => {
        // Don't overwrite status if externally stopped via abort()
        if (record.status !== "stopped") {
          record.status = "error";
        }
        record.error = err instanceof Error ? err.message : String(err);
        record.completedAt ??= Date.now();

        detach();

        // Best-effort worktree cleanup on error
        if (record.worktree) {
          try {
            const wtResult = cleanupWorktree(baseCwd, record.worktree, options.description);
            record.worktreeResult = wtResult;
          } catch { /* ignore cleanup errors */ }
        }

        this.abortOwnedChildren(id);

        // Fire onComplete for foreground agents too — lifecycle symmetry.
        // Mark resultConsumed so the callback skips notifications (result returned inline).
        if (!options.isBackground) record.resultConsumed = true;
        try { this.onComplete?.(record); } catch { /* ignore completion side-effect errors */ }
        this.finishExecution(record);
        return "";
      });

    void execution.then(
      (result) => this.settleCompletion(id, result),
      () => this.settleCompletion(id),
    );
  }

  /**
   * Stop the nested children a settled parent owns. Nested records are hidden
   * from the UI and only their owner can consume them, so a child outliving its
   * parent would burn tokens unseen with no way to reach it. Grandchildren are
   * covered transitively — each abort lands in that child's own settle path.
   */
  private abortOwnedChildren(parentId: string): void {
    for (const [id, record] of this.agents) {
      if (record.parentAgentId === parentId) this.abort(id);
    }
  }

  /** Start queued executions up to the concurrency limit. */
  private drainQueue() {
    while (this.queue.length > 0 && this.runningTopLevel.size < this.maxConcurrent) {
      const next = this.queue.shift()!;
      const record = this.agents.get(next.id);
      if (!record || record.status !== "queued") continue;
      try {
        next.start();
      } catch (err) {
        this.disarmQueuedAbort(next.id);
        this.activeExecutions.delete(next.id);
        this.runningTopLevel.delete(next.id);
        record.status = "error";
        record.error = err instanceof Error ? err.message : String(err);
        record.completedAt = Date.now();
        this.releaseWriter(record);
        this.settleCompletion(next.id);
        try { this.onComplete?.(record); } catch { /* ignore completion side-effect errors */ }
      }
    }
  }

  /**
   * Spawn an agent and wait for completion (foreground use).
   * Foreground agents queue when the top-level concurrency limit is reached.
   * Returns { id, record } so callers can access the agent ID.
   */
  async spawnAndWait(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: Omit<SpawnOptions, "isBackground">,
  ): Promise<{ id: string; record: AgentRecord }> {
    const id = this.spawn(pi, ctx, type, prompt, { ...options, isBackground: false });
    const record = this.agents.get(id)!;
    await record.promise;
    return { id, record };
  }

  private startResume(record: AgentRecord, prompt: string, signal?: AbortSignal): void {
    this.disarmQueuedAbort(record.id);
    if (signal?.aborted) {
      record.status = "stopped";
      record.completedAt = Date.now();
      this.releaseWriter(record);
      this.settleCompletion(record.id);
      return;
    }

    record.status = "running";
    record.startedAt = Date.now();
    this.activeExecutions.add(record.id);
    if (occupiesPoolSlot(record)) this.runningTopLevel.add(record.id);

    let detachSignal: (() => void) | undefined;
    if (signal) {
      const onAbort = () => this.abort(record.id);
      signal.addEventListener("abort", onAbort, { once: true });
      detachSignal = () => signal.removeEventListener("abort", onAbort);
    }

    const execution = (async () => {
      try {
        const { text, failure } = await resumeAgent(record.session!, prompt, {
          onToolActivity: (activity) => {
            if (activity.type === "end") record.toolUses++;
          },
          onUsage: (event) => {
            this.accumulateUsage(record, event);
          },
          onCompaction: (info) => {
            record.compactionCount++;
            this.onCompact?.(record, info);
          },
          signal: record.abortController?.signal,
        });
        const contractError = resultContractViolation(record.resultContract, text, failure);
        if (record.status !== "stopped") {
          record.status = failure || contractError ? "error" : "completed";
          if (contractError) record.error = contractError;
          else if (failure) record.error = failure;
        }
        record.result = text;
        record.completedAt ??= Date.now();
      } catch (err) {
        if (record.status !== "stopped") {
          record.status = "error";
          record.error = err instanceof Error ? err.message : String(err);
        }
        record.completedAt ??= Date.now();
      }

      detachSignal?.();
      this.abortOwnedChildren(record.id);
      record.resultConsumed = true;
      try { this.onComplete?.(record); } catch { /* ignore completion side-effect errors */ }
      this.finishExecution(record);
      return record.result ?? "";
    })();

    void execution.then(
      (result) => this.settleCompletion(record.id, result),
      () => this.settleCompletion(record.id),
    );
  }

  /** Resume an existing agent session through the writer and concurrency gates. */
  async resume(
    id: string,
    prompt: string,
    signal?: AbortSignal,
  ): Promise<AgentRecord | undefined> {
    const record = this.agents.get(id);
    if (!record?.session) return undefined;
    assertDocumentationAuditResume(record);
    if (record.status === "running" || record.status === "queued" || this.activeExecutions.has(id)) {
      throw new Error(`Agent "${id}" already has an active execution.`);
    }
    const activeWriter = record.isWriteClass ? this.writerOwner(record.parentAgentId) : undefined;
    if (activeWriter) {
      throw new Error(`Cannot resume write-class agent while "${activeWriter.description}" is active.`);
    }

    record.completedAt = undefined;
    record.result = undefined;
    record.error = undefined;
    record.resultConsumed = undefined;
    record.abortController = new AbortController();
    record.status = "queued";
    this.createCompletion(record);
    this.reserveWriter(record, "resume");

    if (signal?.aborted) {
      record.status = "stopped";
      record.completedAt = Date.now();
      this.releaseWriter(record);
      this.settleCompletion(record.id);
      return record;
    }

    const entry: QueueEntry = {
      id,
      signal,
      start: () => this.startResume(record, prompt, signal),
    };
    if (occupiesPoolSlot(record) && this.runningTopLevel.size >= this.maxConcurrent) {
      this.queue.push(entry);
      this.armQueuedAbort(entry);
    } else {
      entry.start();
    }

    await record.promise;
    return record;
  }

  /**
   * Send a steering message to an agent from the UI (mirrors the steer_subagent
   * tool). A live session delivers it now — it interrupts the agent after its
   * current tool execution and appears as a user message. If the session isn't
   * ready yet, the message is queued on `pendingSteers` and flushed when the
   * session is created. Returns false if the agent can't accept steering
   * (unknown id, or no longer running/queued).
   */
  steer(id: string, message: string): boolean {
    const record = this.agents.get(id);
    if (!record) return false;
    if (record.status !== "running" && record.status !== "queued") return false;
    if (record.session) {
      record.session.steer(message).catch(() => {});
    } else {
      if (!record.pendingSteers) record.pendingSteers = [];
      record.pendingSteers.push(message);
    }
    return true;
  }

  getRecord(id: string): AgentRecord | undefined {
    return this.agents.get(id);
  }

  listAgents(): AgentRecord[] {
    return [...this.agents.values()].sort(
      (a, b) => b.startedAt - a.startedAt,
    );
  }

  abort(id: string): boolean {
    const record = this.agents.get(id);
    if (!record) return false;

    // Remove from queue if queued
    if (record.status === "queued") {
      this.queue = this.queue.filter(q => q.id !== id);
      this.disarmQueuedAbort(id);
      record.status = "stopped";
      record.completedAt = Date.now();
      this.releaseWriter(record);
      this.settleCompletion(id);
      return true;
    }

    if (record.status !== "running") return false;
    record.abortController?.abort();
    record.status = "stopped";
    record.completedAt = Date.now();
    return true;
  }

  /** Dispose a record's session and remove it from the map. */
  private removeRecord(id: string, record: AgentRecord): void {
    record.session?.dispose?.();
    record.session = undefined;
    this.agents.delete(id);
  }

  private cleanup() {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [id, record] of this.agents) {
      if (record.status === "running" || record.status === "queued" || this.activeExecutions.has(id)) continue;
      if ((record.completedAt ?? 0) >= cutoff) continue;
      this.removeRecord(id, record);
    }
  }

  /**
   * Remove all completed/stopped/errored records immediately.
   * Called on session start/switch so tasks from a prior session don't persist.
   * Pass skipUnconsumed=true to preserve records the LLM hasn't read yet
   * (resultConsumed=false) — they will be evicted by the 10-minute cleanup timer instead.
   */
  clearCompleted(skipUnconsumed = false): void {
    for (const [id, record] of this.agents) {
      if (record.status === "running" || record.status === "queued" || this.activeExecutions.has(id)) continue;
      if (skipUnconsumed && !record.resultConsumed) continue;
      this.removeRecord(id, record);
    }
  }

  /** Whether any agents are still running or queued. */
  hasRunning(): boolean {
    return [...this.agents.values()].some(
      (record) => record.status === "running" || record.status === "queued",
    );
  }

  /** Abort all running and queued agents immediately. */
  abortAll(): number {
    let count = 0;
    // Clear queued agents first
    for (const queued of this.queue) {
      const record = this.agents.get(queued.id);
      if (record) {
        this.disarmQueuedAbort(queued.id);
        record.status = "stopped";
        record.completedAt = Date.now();
        this.releaseWriter(record);
        this.settleCompletion(queued.id);
        count++;
      }
    }
    this.queue = [];
    // Abort running agents
    for (const record of this.agents.values()) {
      if (record.status === "running") {
        record.abortController?.abort();
        record.status = "stopped";
        record.completedAt = Date.now();
        count++;
      }
    }
    return count;
  }

  /** Wait for all running and queued agents to complete (including queued ones). */
  async waitForAll(): Promise<void> {
    // Loop because drainQueue respects the concurrency limit — as running
    // agents finish they start queued ones, which need awaiting too.
    while (true) {
      this.drainQueue();
      const pending = [...this.agents.values()]
        .filter((record) => record.status === "running" || record.status === "queued")
        .map(r => r.promise)
        .filter(Boolean);
      if (pending.length === 0) break;
      await Promise.allSettled(pending);
    }
  }

  dispose() {
    clearInterval(this.cleanupInterval);
    // Clear queue
    this.queue = [];
    for (const cleanup of this.queuedAbortCleanups.values()) cleanup();
    this.queuedAbortCleanups.clear();
    for (const id of this.completionResolvers.keys()) this.settleCompletion(id);
    this.writerOwners.clear();
    this.activeExecutions.clear();
    this.runningTopLevel.clear();
    for (const record of this.agents.values()) {
      record.session?.dispose();
    }
    this.agents.clear();
    // Prune any orphaned git worktrees (crash recovery)
    try { pruneWorktrees(process.cwd()); } catch { /* ignore */ }
    // Also prune repos that caller-supplied cwds created worktrees in — a clean
    // exit with in-flight agents would otherwise leave stale registrations there.
    for (const repo of this.worktreeRepos) {
      try { pruneWorktrees(repo); } catch { /* ignore */ }
    }
  }
}
