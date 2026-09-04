/**
 * isolated-provider.e2e.test.ts — reachability guard for PR #152 (issue #151).
 *
 * Isolated subagents must retain extension-registered custom providers. The
 * runner forwards the parent's ModelRuntime through `ctx.modelRegistry.runtime`,
 * which is absent from the public ModelRegistry type. The unit test guards the
 * forwarding. This test guards the private facade field against a Pi change that
 * would make the cast return undefined and silently drop provider auth.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterAll, describe, expect, it } from "vitest";

// The one method the reach scenario needs; `.runtime` itself is private (reached below).
interface ModelRuntimeLike {
  registerProvider(id: string, config: Record<string, unknown>): void;
}

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("PR #152 reach: real ModelRegistry exposes .runtime", () => {
  it("ctx.modelRegistry.runtime is reachable and is the runtime it wraps", async () => {
    // A real, configured runtime — as an extension leaves it after registerProvider.
    const dir = mkdtempSync(join(tmpdir(), "iso-prov-"));
    tmpDirs.push(dir);
    const runtime = await ModelRuntime.create({
      authPath: join(dir, "auth.json"),
      modelsPath: join(dir, "models.json"),
      allowModelNetwork: false,
    });

    // `.runtime` is private and not in the package exports — reach the compiled
    // class by file path, exactly the field the patch's cast depends on. If Pi
    // moves/renames/#privates it, THIS line fails loudly instead of the fix
    // silently no-op'ing back to the #151 bug.
    const indexUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
    const mrUrl = indexUrl.replace(/index\.js$/, "core/model-registry.js");
    const { ModelRegistry } = (await import(mrUrl)) as {
      ModelRegistry: new (rt: ModelRuntimeLike) => { runtime?: unknown };
    };

    const facade = new ModelRegistry(runtime);
    // This is the exact expression agent-runner reads (`ctx.modelRegistry.runtime`).
    expect((facade as { runtime?: unknown }).runtime).toBe(runtime);
  });
});
