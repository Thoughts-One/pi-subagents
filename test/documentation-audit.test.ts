import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareDocumentationAudit } from "../src/documentation-audit.js";

const invalidFields = [
  "description",
  "objective",
  "manifest",
  "authority_roots",
  "labels",
  "precedence",
  "disposition_rules",
  "reference_evidence",
] as const;

describe("documentation audit request preparation", () => {
  let root: string;
  let artifact: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "documentation-audit-core-"));
    artifact = join(root, "guide.md");
    writeFileSync(artifact, "Guide");
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function validRequest() {
    return {
      description: "Audit project documentation",
      objective: "Classify the documentation artifact.",
      manifest: [artifact],
      authority_roots: [root],
      labels: [{ name: "DONE", definition: "The documented work is complete." }],
      precedence: "none",
      disposition_rules: [{ artifact_type: "guide", rule: "Keep accurate guides." }],
      reference_evidence: [{ artifact, references: [`${artifact}:1`] }],
    };
  }

  it("rejects omission and invalidity of every typed field", () => {
    for (const field of invalidFields) {
      const request = { ...validRequest(), [field]: undefined };
      expect(prepareDocumentationAudit(request), `omitted ${field}`).toHaveProperty("error");
    }
    const invalid = [
      { description: "too short" },
      { objective: " " },
      { manifest: ["relative.md"] },
      { authority_roots: [artifact] },
      { labels: [{ name: "", definition: "definition" }] },
      { precedence: [] },
      { disposition_rules: [{ artifact_type: "", rule: "rule" }] },
      { reference_evidence: [{ artifact, references: ["not-a-hit"] }] },
      { run_in_background: "true" },
    ];
    for (const patch of invalid) {
      expect(prepareDocumentationAudit({ ...validRequest(), ...patch }), JSON.stringify(patch)).toHaveProperty("error");
    }
  });

  it("canonicalizes one valid request into a deterministic prompt", () => {
    const prepared = prepareDocumentationAudit(validRequest());

    expect(prepared).toHaveProperty("request");
    if ("error" in prepared) throw new Error(prepared.error);
    expect(prepared.prompt).toMatch(/^DOCUMENTATION AUDIT REQUEST\n\nOBJECTIVE:/);
    expect(prepared.prompt).toContain("REFERENCE EVIDENCE:");
  });

  it("rejects aliases and root escapes before child creation", () => {
    const alias = join(root, "guide-alias.md");
    symlinkSync(artifact, alias);
    const duplicate = validRequest();
    duplicate.manifest = [artifact, alias];
    expect(prepareDocumentationAudit(duplicate)).toHaveProperty("error");

    const allowed = join(root, "allowed");
    mkdirSync(allowed);
    const escaped = validRequest();
    escaped.authority_roots = [allowed];
    expect(prepareDocumentationAudit(escaped)).toHaveProperty("error");
  });

  it("requires exact readable evidence for every manifest artifact", () => {
    const second = join(root, "second.md");
    writeFileSync(second, "Second");
    const request = validRequest();
    request.manifest = [artifact, second];
    request.reference_evidence = [{ artifact, references: [`${artifact}:1`] }];
    expect(prepareDocumentationAudit(request)).toEqual(expect.objectContaining({
      error: expect.stringContaining("cover every manifest artifact"),
    }));

    request.manifest = [artifact];
    request.reference_evidence = [{ artifact, references: [join(root, "missing.md:1")] }];
    expect(prepareDocumentationAudit(request)).toHaveProperty("error");

    request.reference_evidence = [{ artifact, references: [`${artifact}:2`] }];
    expect(prepareDocumentationAudit(request)).toHaveProperty("error");
  });

  it.skipIf(process.platform === "win32" || !existsSync("/dev/null"))("rejects non-regular manifest artifacts", () => {
    const request = validRequest();
    request.manifest = ["/dev/null"];
    request.authority_roots = ["/dev"];
    request.reference_evidence = [{ artifact: "/dev/null", references: ["zero-hit: device fixture"] }];
    expect(prepareDocumentationAudit(request)).toHaveProperty("error");
  });
});
