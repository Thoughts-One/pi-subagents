import { readFileSync } from "node:fs";
import type { ResultContract } from "./types.js";

interface PlanAuthorityContract {
  schema_version: 1;
  claude_prefix: string;
  fallback_prefix: string;
  claude_receipt_keys: string[];
  fallback_receipt_keys: string[];
  fallback_receipt_template: Record<string, unknown>;
  failure_classes: string[];
  outcome_exempt_roles: string[];
}

const PLAN_AUTHORITY_CONTRACT = JSON.parse(
  readFileSync(new URL("../plan-authority-contract.json", import.meta.url), "utf8"),
) as PlanAuthorityContract;
if (PLAN_AUTHORITY_CONTRACT.schema_version !== 1) {
  throw new Error("Unsupported Plan authority contract schema.");
}
if (
  Object.keys(PLAN_AUTHORITY_CONTRACT.fallback_receipt_template).sort().join("\0")
  !== [...PLAN_AUTHORITY_CONTRACT.fallback_receipt_keys].sort().join("\0")
) {
  throw new Error("Plan fallback receipt template differs from its declared keys.");
}
const CLAUDE_RECEIPT_KEYS = PLAN_AUTHORITY_CONTRACT.claude_receipt_keys;
const FALLBACK_RECEIPT_KEYS = PLAN_AUTHORITY_CONTRACT.fallback_receipt_keys;
const CLAUDE_FAILURE_CLASSES = new Set(PLAN_AUTHORITY_CONTRACT.failure_classes);
const CLAUDE_PREFIX = PLAN_AUTHORITY_CONTRACT.claude_prefix;
const FALLBACK_PREFIX = PLAN_AUTHORITY_CONTRACT.fallback_prefix;

type Receipt = Record<string, unknown>;

/** Validate a settled result against its frontmatter-declared contract. */
export function validateResultContract(contract: ResultContract | undefined, responseText: string): string | undefined {
  if (contract === undefined) return undefined;
  if (contract === "plan-authority") return validatePlanAuthorityResult(responseText);
  return `Unknown result contract: ${contract}`;
}

/** Validate the outer provenance receipt returned by the Plan role. */
export function validatePlanAuthorityResult(responseText: string): string | undefined {
  const firstLine = responseText.split("\n", 1)[0] ?? "";
  const claude = parseReceipt(firstLine, CLAUDE_PREFIX);
  if (claude.receipt !== undefined) return validateClaudeReceipt(claude.receipt);
  const fallback = parseReceipt(firstLine, FALLBACK_PREFIX);
  if (fallback.receipt !== undefined) return validateFallbackReceipt(fallback.receipt);
  return claude.error ?? fallback.error ?? "Plan result must start with a provenance receipt.";
}

function parseReceipt(firstLine: string, prefix: string): { receipt?: Receipt; error?: string } {
  if (!firstLine.startsWith(prefix)) return {};
  try {
    const parsed: unknown = JSON.parse(firstLine.slice(prefix.length));
    if (!isRecord(parsed)) return { error: `${prefix.slice(0, -2)} must contain a JSON object.` };
    return { receipt: parsed };
  } catch {
    return { error: `${prefix.slice(0, -2)} contains malformed JSON.` };
  }
}

function validateClaudeReceipt(receipt: Receipt): string | undefined {
  const keyError = exactKeys(receipt, CLAUDE_RECEIPT_KEYS, "Claude-Subagent-Receipt");
  if (keyError) return keyError;
  if (receipt.role !== "planner") return 'Claude-Subagent-Receipt role must be "planner".';
  if (receipt.model !== "claude-fable-5") return 'Claude-Subagent-Receipt model must be "claude-fable-5".';
  if (receipt.outcome !== "success" && receipt.outcome !== "failure") {
    return 'Claude-Subagent-Receipt outcome must be "success" or "failure".';
  }
  for (const key of ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"] as const) {
    if (receipt[key] !== null && !isNonNegativeNumber(receipt[key])) {
      return `Claude-Subagent-Receipt ${key} must be a non-negative number or null.`;
    }
  }
  if (!isNonNegativeNumber(receipt.duration_ms)) return "Claude-Subagent-Receipt duration_ms must be a non-negative number.";
  if (receipt.outcome === "success" && receipt.failure_class !== null) {
    return "Claude-Subagent-Receipt success must have failure_class null.";
  }
  if (receipt.outcome === "failure" && !isAllowedFailureClass(receipt.failure_class)) {
    return "Claude-Subagent-Receipt failure_class is not an allowed authority failure.";
  }
  if (typeof receipt.escalated !== "boolean" || typeof receipt.truncated !== "boolean") {
    return "Claude-Subagent-Receipt escalated and truncated must be boolean.";
  }
  return undefined;
}

function validateFallbackReceipt(receipt: Receipt): string | undefined {
  const keyError = exactKeys(receipt, FALLBACK_RECEIPT_KEYS, "Plan-Fallback-Receipt");
  if (keyError) return keyError;
  for (const key of ["role", "authority_model", "authority_outcome", "author_model"] as const) {
    if (receipt[key] !== PLAN_AUTHORITY_CONTRACT.fallback_receipt_template[key]) {
      return `Plan-Fallback-Receipt ${key} differs from the authority contract.`;
    }
  }
  if (!isAllowedFailureClass(receipt.failure_class)) return "Plan-Fallback-Receipt failure_class is not an allowed authority failure.";
  return undefined;
}

function exactKeys(receipt: Receipt, expected: readonly string[], label: string): string | undefined {
  const keys = Object.keys(receipt).sort();
  const expectedKeys = [...expected].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    return `${label} has unknown or missing keys.`;
  }
  return undefined;
}

function isAllowedFailureClass(value: unknown): value is string {
  return typeof value === "string" && CLAUDE_FAILURE_CLASSES.has(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isRecord(value: unknown): value is Receipt {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
