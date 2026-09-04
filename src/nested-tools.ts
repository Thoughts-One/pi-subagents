import type { Model } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { abortable } from "./abortable.js";
import {
  agentConfigCanWrite,
  buildAgentRegistry,
  getAgentConfigIn,
  getAvailableTypesIn,
  resolveEnabledTypeIn,
  resolveTypeIn,
} from "./agent-types.js";
import { loadCustomAgents } from "./custom-agents.js";
import { isDocumentationAuditorType } from "./documentation-audit.js";
import { resolveAgentInvocationConfig } from "./invocation-config.js";
import { resolveModel } from "./model-resolver.js";
import { checkModelScope } from "./model-scope.js";
import { getForegroundOutcomeNote, getStatusNote, partialOutputSuffix } from "./status-note.js";
import type {
  AgentConfig,
  AgentInvocation,
  AgentRecord,
  IsolationMode,
  ModelAuthority,
  ThinkingLevel,
} from "./types.js";

/**
 * Hard ceiling on nesting for every branch: main session = 0, its subagents = 1,
 * their children = 2. `0`/`1` disables nesting entirely. Set from
 * `subagents.json` (`maxSubagentDepth`). Read when a subagent session is built,
 * so a change applies to sessions started after it.
 */
let maxSubagentDepth = 2;

export function getMaxSubagentDepth(): number { return maxSubagentDepth; }
export function setMaxSubagentDepth(n: number): void { maxSubagentDepth = Math.max(0, Math.floor(n)); }

const NESTED_TOOL_NAMES = ["Agent", "get_subagent_result", "steer_subagent"] as const;

interface NestedSpawnOptions {
  description: string;
  model?: Model<any>;
  modelAuthority?: ModelAuthority;
  maxTurns?: number;
  isolated?: boolean;
  inheritContext?: boolean;
  thinkingLevel?: ThinkingLevel;
  isBackground?: boolean;
  isolation?: IsolationMode;
  invocation?: AgentInvocation;
  signal?: AbortSignal;
  onSessionCreated?: (session: AgentSession) => void;
  depth: number;
  parentAgentId: string;
  maxSubagentDepth: number;
  configCwd?: string;
  writeClass?: boolean;
}

export interface NestedAgentManager {
  spawn(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: string,
    prompt: string,
    options: NestedSpawnOptions,
  ): string;
  spawnAndWait(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: string,
    prompt: string,
    options: Omit<NestedSpawnOptions, "isBackground">,
  ): Promise<{ id: string; record: AgentRecord }>;
  getRecord(id: string): AgentRecord | undefined;
  resume(id: string, prompt: string, signal?: AbortSignal): Promise<AgentRecord | undefined>;
}

export interface NestedToolContext {
  manager: NestedAgentManager;
  pi: ExtensionAPI;
  parentAgentId: string;
  depth: number;
  maxSubagentDepth: number;
  /** "all" = any enabled agent; string[] = only those types. Never empty. */
  allowedSubagents: "all" | string[];
  /** Root used for agent/config discovery; may differ from the agent's working directory. */
  configCwd: string;
}

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], isError, details: {} };
}

function ownsRecord(record: AgentRecord | undefined, parentAgentId: string): record is AgentRecord {
  return record?.parentAgentId === parentAgentId;
}

/**
 * How the caller received this record, which decides the outcome wording.
 *
 *   - "inline": a foreground spawn or a resume. The full output is in this very
 *     result and no agent id was handed back, so the note must say there is
 *     nothing left to fetch — otherwise the parent invents an id, calls
 *     `get_subagent_result`, and hits "not owned by this parent" (#174, the same
 *     trap the top-level foreground path fell into).
 *   - "fetched": `get_subagent_result` on a background child. The parent holds a
 *     valid id and can poll again, so the background wording applies.
 */
type ResultPosition = "inline" | "fetched";

function formatRecord(record: AgentRecord, position: ResultPosition): string {
  if (record.status === "error") {
    return `Agent failed: ${record.error ?? "unknown error"}${partialOutputSuffix(record)}`;
  }
  if (record.status === "queued" || record.status === "running") {
    return `Agent ${record.id} is ${record.status}.`;
  }
  // A truncated run must not read as a finished one. The top-level path carries
  // this in its result headline; a nested result has no headline, so the note
  // leads — appended, it would look like part of the child's own output.
  const text = record.result?.trim() || record.error?.trim() || "No output.";
  const note = position === "inline"
    ? getForegroundOutcomeNote(record.status)
    : getStatusNote(record.status);
  const sessionFile = record.sessionFile ? `\n\nSession file: ${record.sessionFile}` : "";
  return (note ? `Nested agent${note}.\n\n${text}` : text) + sessionFile;
}

/** Build child-safe orchestration tools scoped to one parent agent instance. */
export function createNestedSubagentTools(context: NestedToolContext): ToolDefinition[] {
  // Agents resolve from a registry built for THIS branch's config root (under
  // worktree isolation, the copy). Never via registerAgents — that is
  // process-global state shared with the main session and every other agent.
  const loadRegistry = () => buildAgentRegistry(loadCustomAgents(context.configCwd));
  const allowedTypesIn = (registry: Map<string, AgentConfig>): Set<string> | undefined =>
    context.allowedSubagents === "all"
      ? undefined
      : new Set(context.allowedSubagents.map(name => resolveTypeIn(registry, name) ?? name));
  const availableIn = (registry: Map<string, AgentConfig>): string[] => {
    const allowed = allowedTypesIn(registry);
    return getAvailableTypesIn(registry).filter(name => allowed === undefined || allowed.has(name));
  };

  const agentTool = defineTool({
    name: NESTED_TOOL_NAMES[0],
    label: "Agent",
    description:
      "Launch a child-safe nested subagent for bounded delegated work. " +
      "Only use agent types allowed by this parent agent; nesting is depth-limited.",
    parameters: Type.Object({
      prompt: Type.String({ description: "Self-contained task for the nested agent." }),
      description: Type.String({ description: "Short 3-5 word task description." }),
      subagent_type: Type.String({ description: `Allowed nested agent type. Available: ${availableIn(loadRegistry()).join(", ") || "none"}.` }),
      run_in_background: Type.Optional(Type.Boolean()),
      resume: Type.Optional(Type.String({ description: "Resume a nested agent owned by this parent." })),
    }),
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
      if (params.resume) {
        const existing = context.manager.getRecord(params.resume);
        if (!ownsRecord(existing, context.parentAgentId)) {
          return textResult(`Nested agent not found or not owned by this parent: "${params.resume}".`, true);
        }
        const resumed = await context.manager.resume(params.resume, params.prompt, signal);
        return resumed
          ? textResult(formatRecord(resumed, "inline"), resumed.status === "error")
          : textResult(`Failed to resume nested agent "${params.resume}".`, true);
      }

      if (context.depth >= context.maxSubagentDepth) {
        return textResult(
          `Nested subagent call blocked (depth=${context.depth}, max=${context.maxSubagentDepth}). Complete the task directly.`,
          true,
        );
      }

      // Reloaded per call so new agent files are picked up without a restart.
      const registry = loadRegistry();
      const rawType = params.subagent_type;
      if (isDocumentationAuditorType(rawType)) {
        return textResult("documentation-auditor can only be started through audit_documents.", true);
      }
      // Strict resolve, never the fallback policy: a project-level
      // `fallbackSubagent` must not hand a nested caller an agent its allowlist
      // never named. The list stays allowlist-filtered so a typo can't enumerate
      // agents this parent may not reach.
      const resolvedType = resolveEnabledTypeIn(registry, rawType);
      if (resolvedType === undefined) {
        return textResult(
          `Unknown or disabled nested agent type: "${rawType}". Allowed: ${availableIn(registry).join(", ") || "none"}.`,
          true,
        );
      }
      const allowed = allowedTypesIn(registry);
      if (allowed !== undefined && !allowed.has(resolvedType)) {
        return textResult(
          `Nested agent type "${resolvedType}" is not allowed for this parent. Allowed: ${[...allowed].join(", ")}.`,
          true,
        );
      }

      const config = getAgentConfigIn(registry, resolvedType);
      const modelAuthority: ModelAuthority = { configuredModel: config?.model };
      const invocation = resolveAgentInvocationConfig(config, params);
      let model = ctx.model;
      if (invocation.modelInput) {
        const resolvedModel = resolveModel(invocation.modelInput, ctx.modelRegistry);
        if (typeof resolvedModel === "string") {
          return textResult(resolvedModel, true);
        } else {
          model = resolvedModel;
        }
      }

      // Same scopeModels policy as the top-level Agent tool — a nested spawn
      // must not escape the allowlist. A "warn" verdict proceeds silently:
      // child sessions have no UI surface to toast to.
      const scopeVerdict = checkModelScope({
        model,
        cwd: context.configCwd,
        modelRegistry: ctx.modelRegistry,
        callerSupplied: false,
        agentLabel: config?.displayName ?? resolvedType,
        modelInput: invocation.modelInput,
      });
      if (scopeVerdict.kind === "error") return textResult(scopeVerdict.message, true);

      const childDepth = context.depth + 1;
      const options: NestedSpawnOptions = {
        description: params.description,
        model,
        modelAuthority,
        maxTurns: invocation.maxTurns,
        isolated: invocation.isolated,
        inheritContext: invocation.inheritContext,
        thinkingLevel: invocation.thinking,
        isolation: invocation.isolation,
        invocation: {
          thinking: invocation.thinking,
          maxTurns: invocation.maxTurns,
          isolated: invocation.isolated,
          inheritContext: invocation.inheritContext,
          runInBackground: invocation.runInBackground,
          isolation: invocation.isolation,
        },
        depth: childDepth,
        parentAgentId: context.parentAgentId,
        maxSubagentDepth: context.maxSubagentDepth,
        configCwd: context.configCwd,
        writeClass: agentConfigCanWrite(config),
      };

      // `ctx` is forwarded to the manager unmodified, never captured at tool-build
      // time: each AgentSession builds its own ExtensionRunner from that session's
      // cwd/sessionManager/modelRegistry, so this is the CHILD's context. Capturing
      // one earlier would silently give a grandchild the wrong worktree base, the
      // wrong conversation under inherit_context, and the wrong inherited model.
      //
      // spawn() throws on strict worktree-isolation failure and cwd validation —
      // report it as a tool error, like the top-level Agent tool does, instead of
      // letting it escape into the child's turn.
      try {
        if (invocation.runInBackground) {
          const id = context.manager.spawn(context.pi, ctx, resolvedType, params.prompt, {
            ...options,
            isBackground: true,
          });
          return textResult(`Nested agent started in background. Agent ID: ${id}`);
        }

        const { record } = await context.manager.spawnAndWait(
          context.pi,
          ctx,
          resolvedType,
          params.prompt,
          { ...options, signal },
        );
        return textResult(formatRecord(record, "inline"), record.status === "error");
      } catch (err) {
        return textResult(err instanceof Error ? err.message : String(err), true);
      }
    },
  });

  const resultTool = defineTool({
    name: NESTED_TOOL_NAMES[1],
    label: "Get Nested Agent Result",
    description: "Check or wait for a background nested agent owned by this parent.",
    parameters: Type.Object({
      agent_id: Type.String(),
      wait: Type.Optional(Type.Boolean()),
    }),
    execute: async (_toolCallId, params, signal) => {
      const record = context.manager.getRecord(params.agent_id);
      if (!ownsRecord(record, context.parentAgentId)) {
        return textResult(`Nested agent not found or not owned by this parent: "${params.agent_id}".`, true);
      }
      // Cancellation stops only this wait. The child keeps running. The record
      // promise exists before queue admission, so one await covers both states.
      if (params.wait && (record.status === "queued" || record.status === "running") && record.promise) {
        await abortable(record.promise, signal);
      }
      return textResult(formatRecord(record, "fetched"), record.status === "error");
    },
  });

  const steerTool = defineTool({
    name: NESTED_TOOL_NAMES[2],
    label: "Steer Nested Agent",
    description: "Send guidance to a running nested agent owned by this parent.",
    parameters: Type.Object({
      agent_id: Type.String(),
      message: Type.String(),
    }),
    execute: async (_toolCallId, params) => {
      const record = context.manager.getRecord(params.agent_id);
      if (!ownsRecord(record, context.parentAgentId) || record.status !== "running") {
        return textResult(`Running nested agent not found or not owned by this parent: "${params.agent_id}".`, true);
      }
      // Session not ready yet — queue the steer. The manager flushes pending
      // steers when the session is created (same contract as the top-level tool).
      if (!record.session) {
        if (!record.pendingSteers) record.pendingSteers = [];
        record.pendingSteers.push(params.message);
        return textResult(`Steering message queued for nested agent ${params.agent_id}.`);
      }
      try {
        await record.session.steer(params.message);
      } catch (err) {
        return textResult(`Failed to steer nested agent: ${err instanceof Error ? err.message : String(err)}`, true);
      }
      return textResult(`Steering message sent to nested agent ${params.agent_id}.`);
    },
  });

  return [agentTool, resultTool, steerTool];
}
