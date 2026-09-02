/** usage.ts — Attributed token usage, durable snapshots, and session-stat readers. */

import type { AssistantMessage, ToolResultMessage, Usage } from "@earendil-works/pi-ai";

/** A concrete provider/model identity. */
export interface UsageModelIdentity {
  provider: string;
  model: string;
}

/** Provider-reported usage and cost components for one model call. */
export interface UsageComponents {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

/** Cumulative usage for one attributed model or one explicitly unattributed tool. */
export interface UsageBucket extends UsageComponents {
  calls: number;
}

/**
 * Content-free cumulative accounting state. `models` is keyed by
 * `provider/model`; `unattributedTools` keeps a tool's usage visible when its
 * result supplies no explicit model identity.
 */
export interface LifetimeUsage {
  schemaVersion: 1;
  cumulative: true;
  models: Record<string, UsageBucket>;
  unattributedTools: Record<string, UsageBucket>;
}

export type AttributedUsageEvent =
  | { kind: "model"; model: UsageModelIdentity; usage: UsageComponents }
  | { kind: "unattributedTool"; toolName: string; usage: UsageComponents };

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function usageComponents(usage: Partial<Usage> | undefined): UsageComponents | undefined {
  if (!usage) return undefined;
  return {
    input: number(usage.input),
    output: number(usage.output),
    cacheRead: number(usage.cacheRead),
    cacheWrite: number(usage.cacheWrite),
    cost: {
      input: number(usage.cost?.input),
      output: number(usage.cost?.output),
      cacheRead: number(usage.cost?.cacheRead),
      cacheWrite: number(usage.cost?.cacheWrite),
      total: number(usage.cost?.total),
    },
  };
}

function emptyBucket(): UsageBucket {
  return {
    calls: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** Create a durable, cumulative usage accumulator. */
export function createLifetimeUsage(): LifetimeUsage {
  return {
    schemaVersion: 1,
    cumulative: true,
    models: Object.create(null) as Record<string, UsageBucket>,
    unattributedTools: Object.create(null) as Record<string, UsageBucket>,
  };
}

/** Convert an assistant response into an attributed usage event. */
export function assistantUsageEvent(message: Pick<AssistantMessage, "provider" | "model" | "usage">): AttributedUsageEvent | undefined {
  const usage = usageComponents(message.usage);
  if (!usage) return undefined;
  return {
    kind: "model",
    model: { provider: message.provider, model: message.model },
    usage,
  };
}

function explicitToolModel(details: unknown): UsageModelIdentity | undefined {
  if (!details || typeof details !== "object") return undefined;
  const usageModel = (details as { usageModel?: unknown }).usageModel;
  if (!usageModel || typeof usageModel !== "object") return undefined;
  const identity = usageModel as { provider?: unknown; id?: unknown; model?: unknown };
  const model = typeof identity.id === "string" ? identity.id : identity.model;
  if (
    typeof identity.provider === "string" && identity.provider.length > 0
    && typeof model === "string" && model.length > 0
  ) {
    return { provider: identity.provider, model };
  }
  return undefined;
}

/**
 * Convert a usage-bearing tool result into an event. Pi 0.84 puts usage at the
 * message top level. Older runtimes put it in details.usage. Attribution accepts
 * only details.usageModel with a provider plus model or id; missing or unknown
 * identities remain in that tool's unattributed bucket.
 */
export function toolResultUsageEvent(
  message: Pick<ToolResultMessage, "toolName" | "details"> & { usage?: Partial<Usage> },
): AttributedUsageEvent | undefined {
  const detailsUsage = message.details && typeof message.details === "object"
    ? (message.details as { usage?: Partial<Usage> }).usage
    : undefined;
  const usage = usageComponents(message.usage !== undefined ? message.usage : detailsUsage);
  if (!usage) return undefined;
  const model = explicitToolModel(message.details);
  return model
    ? { kind: "model", model, usage }
    : { kind: "unattributedTool", toolName: message.toolName, usage };
}

/** Add one attributed usage event into its cumulative bucket. */
export function addUsage(into: LifetimeUsage, event: AttributedUsageEvent): void {
  const buckets = event.kind === "model" ? into.models : into.unattributedTools;
  const key = event.kind === "model" ? `${event.model.provider}/${event.model.model}` : event.toolName;
  let bucket = buckets[key];
  if (!bucket) {
    bucket = emptyBucket();
    buckets[key] = bucket;
  }
  bucket.calls++;
  bucket.input += event.usage.input;
  bucket.output += event.usage.output;
  bucket.cacheRead += event.usage.cacheRead;
  bucket.cacheWrite += event.usage.cacheWrite;
  bucket.cost.input += event.usage.cost.input;
  bucket.cost.output += event.usage.cost.output;
  bucket.cost.cacheRead += event.usage.cost.cacheRead;
  bucket.cost.cacheWrite += event.usage.cost.cacheWrite;
  bucket.cost.total += event.usage.cost.total;
}

/** Aggregate content-free cumulative components across all buckets. */
export function getLifetimeComponents(usage?: LifetimeUsage): UsageComponents {
  const total: UsageComponents = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  if (!usage) return total;
  for (const bucket of Object.values(usage.models).concat(Object.values(usage.unattributedTools))) {
    total.input += bucket.input;
    total.output += bucket.output;
    total.cacheRead += bucket.cacheRead;
    total.cacheWrite += bucket.cacheWrite;
    total.cost.input += bucket.cost.input;
    total.cost.output += bucket.cost.output;
    total.cost.cacheRead += bucket.cost.cacheRead;
    total.cost.cacheWrite += bucket.cost.cacheWrite;
    total.cost.total += bucket.cost.total;
  }
  return total;
}

/** Sum the existing UI total: input + output + cache write, never cache read. */
export function getLifetimeTotal(usage?: LifetimeUsage): number {
  const total = getLifetimeComponents(usage);
  return total.input + total.output + total.cacheWrite;
}

/** Create an independent durable snapshot of the mutable usage accumulator. */
export function snapshotLifetimeUsage(usage: LifetimeUsage): LifetimeUsage {
  return structuredClone(usage);
}

/** Minimal shape we read from upstream `getSessionStats()`. */
export type SessionStatsLike = {
  tokens: { input: number; output: number; cacheWrite: number };
  contextUsage?: { percent: number | null };
};
export type SessionLike = { getSessionStats(): SessionStatsLike };

/**
 * Session-scoped token count: input + output + cacheWrite as reported by
 * upstream `getSessionStats()` for the current session window.
 */
export function getSessionTokens(session: SessionLike | undefined): number {
  if (!session) return 0;
  try {
    const t = session.getSessionStats().tokens;
    return t.input + t.output + t.cacheWrite;
  } catch { return 0; }
}

/** Context-window utilization (0–100), or null when unavailable. */
export function getSessionContextPercent(session: SessionLike | undefined): number | null {
  if (!session) return null;
  try { return session.getSessionStats().contextUsage?.percent ?? null; }
  catch { return null; }
}
