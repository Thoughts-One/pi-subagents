import { accessSync, closeSync, constants as fsConstants, openSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type {
  DocumentationAuditAdmission,
  DocumentationAuditRequest,
  DocumentationAuditResult,
  ReferenceEvidence,
} from "./types.js";

const MAX_ITEMS = 32;
const MAX_TEXT_LENGTH = 4_000;
const MAX_REFERENCE_HITS = 64;
const admissions = new WeakMap<object, { agentId?: string }>();

export const DOCUMENTATION_AUDIT_PARAMETERS = Type.Object({
  description: Type.String({ description: "Three to five word UI label." }),
  objective: Type.String({ description: "Non-empty documentation audit objective." }),
  manifest: Type.Array(Type.String({ description: "Exact absolute readable artifact path." }), { minItems: 1, maxItems: MAX_ITEMS }),
  authority_roots: Type.Array(Type.String({ description: "Canonical authority directory." }), { minItems: 1, maxItems: MAX_ITEMS }),
  labels: Type.Array(Type.Object({
    name: Type.String(),
    definition: Type.String(),
  }, { additionalProperties: false }), { minItems: 1, maxItems: MAX_ITEMS }),
  precedence: Type.Union([
    Type.Literal("none"),
    Type.Array(Type.String(), { minItems: 1, maxItems: MAX_ITEMS }),
  ]),
  disposition_rules: Type.Array(Type.Object({
    artifact_type: Type.String(),
    rule: Type.String(),
  }, { additionalProperties: false }), { minItems: 1, maxItems: MAX_ITEMS }),
  reference_evidence: Type.Array(Type.Object({
    artifact: Type.String(),
    references: Type.Array(Type.String(), { minItems: 1, maxItems: MAX_REFERENCE_HITS }),
  }, { additionalProperties: false }), { minItems: 1, maxItems: MAX_ITEMS }),
  run_in_background: Type.Optional(Type.Boolean({ description: "Run this valid audit in the background." })),
}, { additionalProperties: false });

/** Identify the one role protected by typed documentation-audit admission. */
export function isDocumentationAuditorType(type: string): boolean {
  return type.trim().toLowerCase() === "documentation-auditor";
}

/** Validate, canonicalize, and render the one supported documentation-audit request. */
export function prepareDocumentationAudit(request: unknown): DocumentationAuditResult {
  if (!isRecord(request)) return { error: "audit_documents requires an object." };
  if (!Value.Check(DOCUMENTATION_AUDIT_PARAMETERS, request)) {
    return { error: "audit_documents has an invalid typed shape." };
  }

  const description = requiredText(request.description, "description", 160);
  const objective = requiredText(request.objective, "objective", MAX_TEXT_LENGTH);
  const manifest = canonicalFiles(request.manifest, "manifest");
  const authorityRoots = canonicalDirectories(request.authority_roots, "authority_roots");
  const labels = namedRules(request.labels, "labels", "name", "definition");
  const precedence = precedenceRules(request.precedence);
  const dispositionRules = namedRules(request.disposition_rules, "disposition_rules", "artifact_type", "rule");
  const referenceEvidence = evidenceRules(request.reference_evidence, manifest.value, authorityRoots.value);
  const runInBackground = request.run_in_background;

  if (
    description.value === undefined
    || objective.value === undefined
    || manifest.value === undefined
    || authorityRoots.value === undefined
    || labels.value === undefined
    || precedence.value === undefined
    || dispositionRules.value === undefined
    || referenceEvidence.value === undefined
  ) {
    return { error: [description.error, objective.error, manifest.error, authorityRoots.error, labels.error, precedence.error, dispositionRules.error, referenceEvidence.error].filter(Boolean).join(" ") };
  }
  if (runInBackground !== undefined && typeof runInBackground !== "boolean") {
    return { error: "run_in_background must be boolean when provided." };
  }
  if (!description.value.split(/\s+/).every(Boolean) || !between(description.value.split(/\s+/).length, 3, 5)) {
    return { error: "description must contain 3-5 words." };
  }
  for (const artifact of manifest.value) {
    if (!authorityRoots.value.some((root) => isInside(root, artifact))) {
      return { error: `manifest artifact is outside authority_roots: ${artifact}` };
    }
  }

  const normalized: DocumentationAuditRequest = {
    description: description.value,
    objective: objective.value,
    manifest: manifest.value,
    authority_roots: authorityRoots.value,
    labels: labels.value.map((label) => ({ name: label.name, definition: label.definition })),
    precedence: precedence.value,
    disposition_rules: dispositionRules.value.map((rule) => ({ artifact_type: rule.artifact_type, rule: rule.rule })),
    reference_evidence: referenceEvidence.value,
    ...(runInBackground === undefined ? {} : { run_in_background: runInBackground }),
  };
  return {
    request: normalized,
    prompt: renderDocumentationAuditPrompt(normalized),
    admission: issueDocumentationAuditAdmission(),
  };
}

/** Issue the opaque admission only after the public request passed typed validation. */
function issueDocumentationAuditAdmission(): DocumentationAuditAdmission {
  const token = Object.freeze({});
  admissions.set(token, {});
  return { route: "audit_documents", token };
}

/** Check that a validated admission has not started another record. */
export function isUnclaimedDocumentationAuditAdmission(value: unknown): value is DocumentationAuditAdmission {
  const state = admissionState(value);
  return state !== undefined && state.agentId === undefined;
}

/** Bind one validated admission to exactly one manager record. */
export function claimDocumentationAuditAdmission(value: unknown, agentId: string): boolean {
  const state = admissionState(value);
  if (state === undefined || state.agentId !== undefined) return false;
  state.agentId = agentId;
  return true;
}

/** Validate the bound origin again before queue start or resume. */
export function isBoundDocumentationAuditAdmission(value: unknown, agentId: string): value is DocumentationAuditAdmission {
  return admissionState(value)?.agentId === agentId;
}

function admissionState(value: unknown): { agentId?: string } | undefined {
  if (!isRecord(value) || value.route !== "audit_documents" || typeof value.token !== "object" || value.token === null) {
    return undefined;
  }
  return admissions.get(value.token);
}

export function renderDocumentationAuditPrompt(request: DocumentationAuditRequest): string {
  const precedence = request.precedence === "none" ? "none" : request.precedence.map((item) => `- ${item}`).join("\n");
  return [
    "DOCUMENTATION AUDIT REQUEST",
    "",
    "OBJECTIVE:",
    request.objective,
    "",
    "MANIFEST:",
    ...request.manifest.map((path) => `- ${path}`),
    "",
    "AUTHORITY ROOTS:",
    ...request.authority_roots.map((path) => `- ${path}`),
    "",
    "LABELS:",
    ...request.labels.map((label) => `- ${label.name}: ${label.definition}`),
    "",
    "PRECEDENCE:",
    precedence,
    "",
    "DISPOSITION RULES:",
    ...request.disposition_rules.map((rule) => `- ${rule.artifact_type}: ${rule.rule}`),
    "",
    "REFERENCE EVIDENCE:",
    ...request.reference_evidence.flatMap((evidence) => [
      `- ${evidence.artifact}:`,
      ...evidence.references.map((reference) => `  - ${reference}`),
    ]),
  ].join("\n");
}

function requiredText(value: unknown, name: string, maxLength: number): { value?: string; error?: string } {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    return { error: `${name} must be non-empty text of at most ${maxLength} characters.` };
  }
  return { value: value.trim() };
}

function canonicalFiles(value: unknown, name: string): { value?: string[]; error?: string } {
  return canonicalPaths(value, name, false);
}

function canonicalDirectories(value: unknown, name: string): { value?: string[]; error?: string } {
  return canonicalPaths(value, name, true);
}

function canonicalPaths(value: unknown, name: string, directory: boolean): { value?: string[]; error?: string } {
  if (!Array.isArray(value) || !between(value.length, 1, MAX_ITEMS) || !value.every((item) => typeof item === "string")) {
    return { error: `${name} must contain 1-${MAX_ITEMS} absolute paths.` };
  }
  const canonical: string[] = [];
  for (const path of value) {
    if (!isAbsolute(path)) return { error: `${name} paths must be absolute: ${path}` };
    try {
      const resolved = realpathSync(path);
      const metadata = statSync(resolved);
      if (directory ? !metadata.isDirectory() : !metadata.isFile()) {
        return { error: `${name} path has the wrong artifact type: ${path}` };
      }
      accessSync(resolved, fsConstants.R_OK);
      canonical.push(resolved);
    } catch {
      return { error: `${name} path is unreadable: ${path}` };
    }
  }
  if (new Set(canonical).size !== canonical.length) return { error: `${name} contains duplicate aliases.` };
  return { value: canonical };
}

function namedRules(
  value: unknown,
  name: string,
  firstKey: "name" | "artifact_type",
  secondKey: "definition" | "rule",
): { value?: { [key: string]: string }[]; error?: string } {
  if (!Array.isArray(value) || !between(value.length, 1, MAX_ITEMS)) return { error: `${name} must contain 1-${MAX_ITEMS} rules.` };
  const rules: { [key: string]: string }[] = [];
  const names = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)) return { error: `${name} entries must be objects.` };
    const first = requiredText(item[firstKey], `${name}.${firstKey}`, 160);
    const second = requiredText(item[secondKey], `${name}.${secondKey}`, MAX_TEXT_LENGTH);
    if (first.value === undefined || second.value === undefined) return { error: first.error ?? second.error };
    if (names.has(first.value)) return { error: `${name} contains duplicate ${firstKey} values.` };
    names.add(first.value);
    rules.push({ [firstKey]: first.value, [secondKey]: second.value });
  }
  return { value: rules };
}

function precedenceRules(value: unknown): { value?: "none" | string[]; error?: string } {
  if (value === "none") return { value };
  if (!Array.isArray(value) || !between(value.length, 1, MAX_ITEMS) || !value.every((item) => typeof item === "string" && item.trim().length > 0 && item.length <= MAX_TEXT_LENGTH)) {
    return { error: `precedence must be "none" or an ordered list of 1-${MAX_ITEMS} authority entries.` };
  }
  const entries = value.map((item) => item.trim());
  if (new Set(entries).size !== entries.length) return { error: "precedence contains duplicate authorities." };
  return { value: entries };
}

function evidenceRules(
  value: unknown,
  manifest: string[] | undefined,
  authorityRoots: string[] | undefined,
): { value?: ReferenceEvidence[]; error?: string } {
  if (!manifest || !authorityRoots) return { error: "reference_evidence cannot be validated before manifest and authority_roots." };
  if (!Array.isArray(value) || !between(value.length, 1, MAX_ITEMS)) return { error: `reference_evidence must contain 1-${MAX_ITEMS} entries.` };
  const evidence: ReferenceEvidence[] = [];
  const artifacts = new Set<string>();
  for (const item of value) {
    if (!isRecord(item) || typeof item.artifact !== "string" || !Array.isArray(item.references)) {
      return { error: "reference_evidence entries require artifact and references." };
    }
    if (!isAbsolute(item.artifact)) {
      return { error: `reference_evidence artifact must be an absolute path: ${item.artifact}` };
    }
    let artifact: string;
    try {
      artifact = realpathSync(item.artifact);
    } catch {
      return { error: `reference_evidence artifact is unreadable: ${item.artifact}` };
    }
    if (!manifest.includes(artifact)) return { error: `reference_evidence artifact is not in manifest: ${item.artifact}` };
    if (artifacts.has(artifact)) return { error: "reference_evidence contains duplicate artifact aliases." };
    if (!between(item.references.length, 1, MAX_REFERENCE_HITS) || !item.references.every((reference) => typeof reference === "string" && reference.trim().length > 0 && reference.length <= MAX_TEXT_LENGTH)) {
      return { error: `reference_evidence references must contain 1-${MAX_REFERENCE_HITS} bounded observations.` };
    }
    const references = item.references.map((reference) => reference.trim());
    const hasOneZeroHit = references.length === 1 && references[0].startsWith("zero-hit: ");
    const canonicalHits = hasOneZeroHit ? undefined : references.map((reference) => canonicalFileLineHit(reference, authorityRoots));
    if (!hasOneZeroHit && canonicalHits?.some((reference) => reference === undefined)) {
      return { error: "reference_evidence references must be exact readable file:line hits inside authority_roots or one `zero-hit: ` observation." };
    }
    evidence.push({ artifact, references: (canonicalHits as string[] | undefined) ?? references });
    artifacts.add(artifact);
  }
  if (artifacts.size !== manifest.length) {
    return { error: "reference_evidence must cover every manifest artifact exactly once." };
  }
  return { value: evidence };
}

function canonicalFileLineHit(reference: string, authorityRoots: string[]): string | undefined {
  const match = /^(.+):(\d+)$/.exec(reference);
  if (match === null || !isAbsolute(match[1])) return undefined;
  const line = Number(match[2]);
  if (!Number.isSafeInteger(line) || line < 1) return undefined;
  try {
    const file = realpathSync(match[1]);
    if (!statSync(file).isFile() || !authorityRoots.some((root) => isInside(root, file))) return undefined;
    accessSync(file, fsConstants.R_OK);
    if (!fileHasLine(file, line)) return undefined;
    return `${file}:${line}`;
  } catch {
    return undefined;
  }
}

function fileHasLine(path: string, targetLine: number): boolean {
  const descriptor = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let line = 1;
  try {
    for (;;) {
      const bytes = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytes === 0) return false;
      for (let index = 0; index < bytes; index += 1) {
        if (line === targetLine) return true;
        if (buffer[index] === 0x0a) line += 1;
      }
    }
  } finally {
    closeSync(descriptor);
  }
}

function isInside(root: string, path: string): boolean {
  const value = relative(root, path);
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

function between(value: number, min: number, max: number): boolean {
  return value >= min && value <= max;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
