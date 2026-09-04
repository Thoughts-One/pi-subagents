/**
 * schedule.ts — `SubagentScheduler`: timer-driven dispatcher of scheduled subagents.
 *
 * Mirrors the engine shape of pi-cron-schedule/src/scheduler.ts:
 *   - two-Map split (jobs = croner Cron, intervals = setInterval/setTimeout)
 *   - addJob/removeJob/updateJob/scheduleJob/unscheduleJob/executeJob
 *   - static parsers for cron / "+10m" / "5m" / ISO formats
 *
 * Differences vs pi-cron-schedule:
 *   - Persistence is via ScheduleStore (PID-locked, session-scoped, atomic).
 *   - `executeJob` calls `manager.spawn(...)` instead of dispatching a user
 *     message, so scheduled runs share the normal lifecycle and queue.
 *   - Result delivery is implicit: spawn → background completion → existing
 *     `subagent-notification` followUp path. No new delivery code.
 */

import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Cron } from "croner";
import { nanoid } from "nanoid";
import type { AgentManager } from "./agent-manager.js";
import { getAgentConfig, resolveSpawnType } from "./agent-types.js";
import { isDocumentationAuditorType } from "./documentation-audit.js";
import { resolveAgentInvocationConfig } from "./invocation-config.js";
import { resolveModel } from "./model-resolver.js";
import type { ScheduleStore } from "./schedule-store.js";
import type { ModelAuthority, ScheduledSubagent, SubagentType } from "./types.js";

/** Event emitted on `pi.events` for cross-extension consumers. */
export type ScheduleChangeEvent =
  | { type: "added"; job: ScheduledSubagent }
  | { type: "removed"; jobId: string }
  | { type: "updated"; job: ScheduledSubagent }
  | { type: "fired"; jobId: string; agentId: string; name: string }
  | { type: "error"; jobId: string; error: string };

/** Params accepted at job creation — ID, timestamps, and state are derived. */
class DocumentationAuditScheduleError extends Error {}

function assertSchedulableType(type: SubagentType): void {
  const dispatch = resolveSpawnType(type);
  const effectiveType = dispatch.ok ? dispatch.type : type;
  if (isDocumentationAuditorType(type) || isDocumentationAuditorType(effectiveType)) {
    throw new DocumentationAuditScheduleError("documentation-auditor can only be started through audit_documents.");
  }
}

export interface NewJobInput {
  name: string;
  description: string;
  schedule: string;
  subagent_type: SubagentType;
  prompt: string;
}

export class SubagentScheduler {
  private jobs = new Map<string, Cron>();
  private intervals = new Map<string, NodeJS.Timeout>();
  private store: ScheduleStore | undefined;
  private pi: ExtensionAPI | undefined;
  private ctx: ExtensionContext | undefined;
  private manager: AgentManager | undefined;

  /** Start the scheduler: bind to a session's store and arm enabled jobs. */
  start(pi: ExtensionAPI, ctx: ExtensionContext, manager: AgentManager, store: ScheduleStore): void {
    this.pi = pi;
    this.ctx = ctx;
    this.manager = manager;
    this.store = store;

    for (const job of store.list()) {
      if (!job.enabled) continue;
      try {
        assertSchedulableType(job.subagent_type);
        this.scheduleJob(job);
      } catch (error) {
        store.update(job.id, { enabled: false, lastStatus: "error" });
        this.emit({
          type: "error",
          jobId: job.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /** Stop all timers; drop refs. Safe to call repeatedly. */
  stop(): void {
    for (const cron of this.jobs.values()) cron.stop();
    this.jobs.clear();
    for (const t of this.intervals.values()) clearTimeout(t);
    this.intervals.clear();
    this.store = undefined;
    this.pi = undefined;
    this.ctx = undefined;
    this.manager = undefined;
  }

  /** True if start() has bound a store and the scheduler is active. */
  isActive(): boolean {
    return this.store !== undefined;
  }

  list(): ScheduledSubagent[] {
    return this.store?.list() ?? [];
  }

  /**
   * Build a `ScheduledSubagent` from user input. Validates the schedule
   * format and tags `scheduleType`. Throws on invalid input.
   */
  buildJob(input: NewJobInput): ScheduledSubagent {
    assertSchedulableType(input.subagent_type);
    const detected = SubagentScheduler.detectSchedule(input.schedule);
    return {
      id: nanoid(10),
      name: input.name,
      description: input.description,
      schedule: detected.normalized,
      scheduleType: detected.type,
      intervalMs: detected.intervalMs,
      subagent_type: input.subagent_type,
      prompt: input.prompt,
      enabled: true,
      createdAt: new Date().toISOString(),
      runCount: 0,
    };
  }

  /** Add a job, persist, and arm if enabled. Returns the stored job. */
  addJob(input: NewJobInput): ScheduledSubagent {
    const store = this.requireStore();
    if (store.hasName(input.name)) {
      throw new Error(`A scheduled job named "${input.name}" already exists.`);
    }
    const job = this.buildJob(input);
    store.add(job);
    if (job.enabled) this.scheduleJob(job);
    this.emit({ type: "added", job });
    return job;
  }

  removeJob(id: string): boolean {
    const store = this.requireStore();
    if (!store.get(id)) return false;
    this.unscheduleJob(id);
    const ok = store.remove(id);
    if (ok) this.emit({ type: "removed", jobId: id });
    return ok;
  }

  /** Toggle / mutate a job. Re-arms based on the new `enabled` state. */
  updateJob(id: string, patch: Partial<ScheduledSubagent>): ScheduledSubagent | undefined {
    const store = this.requireStore();
    const current = store.get(id);
    if (!current) return undefined;
    const isPureDisable = Object.keys(patch).length === 1 && patch.enabled === false;
    if (!isPureDisable) assertSchedulableType(patch.subagent_type ?? current.subagent_type);
    const updated = store.update(id, patch);
    if (!updated) return undefined;
    this.unscheduleJob(id);
    if (updated.enabled) this.scheduleJob(updated);
    this.emit({ type: "updated", job: updated });
    return updated;
  }

  /** Next-run time as ISO, or undefined if not currently armed. */
  getNextRun(jobId: string): string | undefined {
    const cron = this.jobs.get(jobId);
    if (cron) return cron.nextRun()?.toISOString();
    const job = this.store?.get(jobId);
    if (!job?.enabled) return undefined;
    if (job.scheduleType === "once") return job.schedule;
    if (job.scheduleType === "interval" && job.intervalMs) {
      // Before the first fire there's no `lastRun`, so fall back to "now" —
      // accurate at create time (setInterval was just armed) and within
      // intervalMs of correct in any pre-first-fire view.
      const base = job.lastRun ? new Date(job.lastRun).getTime() : Date.now();
      return new Date(base + job.intervalMs).toISOString();
    }
    return undefined;
  }

  // ── Scheduling primitives ────────────────────────────────────────────

  private scheduleJob(job: ScheduledSubagent): void {
    assertSchedulableType(job.subagent_type);
    const store = this.store;
    if (!store) return;
    try {
      if (job.scheduleType === "interval" && job.intervalMs) {
        const t = setInterval(() => this.executeJob(job.id), job.intervalMs);
        this.intervals.set(job.id, t);
      } else if (job.scheduleType === "once") {
        const target = new Date(job.schedule).getTime();
        const delay = target - Date.now();
        if (delay > 0) {
          const t = setTimeout(() => {
            this.executeJob(job.id);
            // Auto-disable one-shots after they fire (mirrors pi-cron-schedule)
            store.update(job.id, { enabled: false });
            const updated = store.get(job.id);
            if (updated) this.emit({ type: "updated", job: updated });
          }, delay);
          this.intervals.set(job.id, t);
        } else {
          // Past timestamp — disable, mark error, never fire
          store.update(job.id, { enabled: false, lastStatus: "error" });
          this.emit({ type: "error", jobId: job.id, error: `Scheduled time ${job.schedule} is in the past` });
        }
      } else {
        const cron = new Cron(job.schedule, () => this.executeJob(job.id));
        this.jobs.set(job.id, cron);
      }
    } catch (err) {
      this.emit({ type: "error", jobId: job.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  private unscheduleJob(id: string): void {
    const cron = this.jobs.get(id);
    if (cron) {
      cron.stop();
      this.jobs.delete(id);
    }
    const t = this.intervals.get(id);
    if (t) {
      clearTimeout(t);
      clearInterval(t);
      this.intervals.delete(id);
    }
  }

  /**
   * Fire a job: persist running state, spawn (bypassing the concurrency
   * queue), persist completion. Fire-and-forget: the timer tick returns
   * immediately so other jobs keep firing.
   */
  private executeJob(id: string): void {
    const store = this.store;
    const pi = this.pi;
    const ctx = this.ctx;
    const manager = this.manager;
    if (!store || !pi || !ctx || !manager) return;
    const job = store.get(id);
    if (!job?.enabled) return;

    // Resolve dispatch and model authority before marking the job running or
    // spawning. A pin may have become unavailable since scheduling, and must
    // never silently become an unpinned run.
    let dispatch: ReturnType<typeof resolveSpawnType>;
    let modelAuthority: ModelAuthority;
    let invocation: ReturnType<typeof resolveAgentInvocationConfig>;
    let resolvedModel: Model<any> | undefined;
    try {
      // Re-resolve at fire time against the registry as it stands. This does not
      // reload from disk (the scheduler has no reason to rebuild process-global
      // state from a timer), so it catches changes that went through /agents or
      // an Agent call — not a file deleted directly from a shell.
      dispatch = resolveSpawnType(job.subagent_type);
      if (!dispatch.ok) throw new Error(dispatch.message);
      assertSchedulableType(job.subagent_type);
      const config = getAgentConfig(dispatch.type);
      invocation = resolveAgentInvocationConfig(config, { run_in_background: true });
      modelAuthority = { configuredModel: config?.model };
      if (invocation.modelInput) {
        const resolved = resolveModel(invocation.modelInput, ctx.modelRegistry);
        if (typeof resolved === "string") throw new Error(resolved);
        resolvedModel = resolved;
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      if (err instanceof DocumentationAuditScheduleError) {
        this.unscheduleJob(id);
        store.update(id, { enabled: false, lastRun: new Date().toISOString(), lastStatus: "error" });
      } else {
        store.update(id, { lastRun: new Date().toISOString(), lastStatus: "error" });
      }
      this.emit({ type: "error", jobId: id, error });
      return;
    }

    store.update(id, { lastStatus: "running" });

    let agentId: string;
    try {
      agentId = manager.spawn(pi, ctx, dispatch.type, job.prompt, {
        description: job.description,
        isBackground: true,
        model: resolvedModel,
        modelAuthority,
        maxTurns: invocation.maxTurns,
        isolated: invocation.isolated,
        inheritContext: invocation.inheritContext,
        thinkingLevel: invocation.thinking,
        isolation: invocation.isolation,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      store.update(id, { lastRun: new Date().toISOString(), lastStatus: "error" });
      this.emit({ type: "error", jobId: id, error });
      return;
    }

    this.emit({ type: "fired", jobId: id, agentId, name: job.name });

    const record = manager.getRecord(agentId);
    const finalize = (status: "success" | "error") => {
      const next = this.getNextRun(id);
      const current = store.get(id);
      store.update(id, {
        lastRun: new Date().toISOString(),
        lastStatus: status,
        runCount: (current?.runCount ?? 0) + 1,
        nextRun: next,
      });
    };

    // AgentManager's promise resolves either way (its .catch returns ""), so we
    // can't infer success/failure from the promise — read record.status instead.
    // Terminal states: completed/steered = success; error/aborted/stopped = error.
    if (record?.promise) {
      record.promise
        .then(() => {
          const r = manager.getRecord(agentId);
          const failed = r?.status === "error" || r?.status === "aborted" || r?.status === "stopped";
          finalize(failed ? "error" : "success");
        })
        .catch(() => finalize("error"));
    } else {
      // Spawn returned without a promise (defensive — every started record sets one).
      finalize("success");
    }
  }

  private emit(event: ScheduleChangeEvent): void {
    if (this.pi) this.pi.events.emit("subagents:scheduled", event);
  }

  private requireStore(): ScheduleStore {
    if (!this.store) throw new Error("Scheduler not started — no active session.");
    return this.store;
  }

  // ── Format detection / parsers (statics — pure) ──────────────────────

  /**
   * Sniff a schedule string and tag its type. Throws on invalid input.
   * Order matters: relative ("+10m") and interval ("5m") both match digit+unit;
   * relative requires the leading "+" to disambiguate.
   */
  static detectSchedule(s: string): { type: "cron" | "once" | "interval"; intervalMs?: number; normalized: string } {
    const trimmed = s.trim();
    // "+10m" — relative one-shot
    const rel = SubagentScheduler.parseRelativeTime(trimmed);
    if (rel !== null) return { type: "once", normalized: rel };
    // "5m" — interval
    const ivl = SubagentScheduler.parseInterval(trimmed);
    if (ivl !== null) return { type: "interval", intervalMs: ivl, normalized: trimmed };
    // ISO timestamp — one-shot. Reject past timestamps upfront so we never
    // create a dead-on-arrival record (scheduleJob's safety net still catches
    // micro-races from `+0s`-style relatives).
    if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
      const d = new Date(trimmed);
      if (!Number.isNaN(d.getTime())) {
        if (d.getTime() <= Date.now()) {
          throw new Error(`Scheduled time ${d.toISOString()} is in the past.`);
        }
        return { type: "once", normalized: d.toISOString() };
      }
    }
    // Cron — 6-field
    const cronCheck = SubagentScheduler.validateCronExpression(trimmed);
    if (cronCheck.valid) return { type: "cron", normalized: trimmed };
    throw new Error(
      `Invalid schedule "${s}". Use 6-field cron (e.g. "0 0 9 * * 1" — 9am every Monday), interval ("5m"/"1h"), or one-shot ("+10m" / ISO).`
    );
  }

  /** 6-field cron — 'second minute hour dom month dow'. */
  static validateCronExpression(expr: string): { valid: boolean; error?: string } {
    const fields = expr.trim().split(/\s+/);
    if (fields.length !== 6) {
      return {
        valid: false,
        error: `Cron must have 6 fields (second minute hour dom month dow), got ${fields.length}. Example: "0 0 9 * * 1" for 9am every Monday.`,
      };
    }
    try {
      // Croner validates by construction.
      new Cron(expr, () => {});
      return { valid: true };
    } catch (e) {
      return { valid: false, error: e instanceof Error ? e.message : "Invalid cron expression" };
    }
  }

  /** "+10s"/"+5m"/"+1h"/"+2d" → ISO timestamp. */
  static parseRelativeTime(s: string): string | null {
    const m = s.match(/^\+(\d+)(s|m|h|d)$/);
    if (!m) return null;
    const ms = parseInt(m[1], 10) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s" | "m" | "h" | "d"];
    return new Date(Date.now() + ms).toISOString();
  }

  /** "10s"/"5m"/"1h"/"2d" → milliseconds. */
  static parseInterval(s: string): number | null {
    const m = s.match(/^(\d+)(s|m|h|d)$/);
    if (!m) return null;
    return parseInt(m[1], 10) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s" | "m" | "h" | "d"];
  }
}
