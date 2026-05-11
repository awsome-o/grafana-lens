/**
 * Drift-guard for openclaw 2026.5+ contracts requirement (Issue #9).
 *
 * openclaw's plugin registry gates `registerTool()` on `contracts.tools` declared
 * in `openclaw.plugin.json`. This test makes sure the manifest stays in sync with
 * the tools the plugin actually registers — so a future "added a new tool, forgot
 * the manifest" PR fails CI instead of production gateway startup.
 *
 * Three asserts:
 *   (a) Set equality between manifest contracts.tools and runtime-registered names.
 *   (b) Behavioral replay of openclaw's actual contract validator — zero diagnostics.
 *   (c) Smoke test that resolveDiagnosticHooks returns a non-null onDiagnosticEvent
 *       against the locally installed openclaw — protects against Issue #9's second symptom.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import plugin from "../index.js";
import { resolveDiagnosticHooks } from "./sdk-compat.js";

// ── Replayed from openclaw/src/plugins/tool-contracts.ts at v2026.5.5 ──
// Inline copies (not imports) so this test never breaks due to openclaw
// internal refactors — we're testing our manifest against the *algorithm*
// openclaw uses, which is stable behavior even if the file path moves.

function normalizePluginToolNames(names: readonly string[] | undefined): string[] {
  const normalized = new Set<string>();
  for (const name of names ?? []) {
    const trimmed = name.trim();
    if (trimmed) normalized.add(trimmed);
  }
  return [...normalized];
}

function findUndeclaredPluginToolNames(params: {
  declaredNames: readonly string[];
  toolNames: readonly string[];
}): string[] {
  const declared = new Set(normalizePluginToolNames(params.declaredNames));
  return normalizePluginToolNames(params.toolNames).filter((name) => !declared.has(name));
}

// ── Helpers ────────────────────────────────────────────────────────

function loadManifestToolContracts(): string[] {
  const manifestPath = resolve(__dirname, "..", "openclaw.plugin.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    contracts?: { tools?: string[] };
  };
  return manifest.contracts?.tools ?? [];
}

/**
 * Drive `plugin.register(api)` against a fake api that records every
 * registerTool() factory, then run each factory to extract the runtime
 * tool name. Mirrors how openclaw's registry invokes plugins.
 *
 * Alloy is enabled here so the alloy_pipeline tool is included in the
 * runtime set — matches the manifest, which always declares it.
 */
function collectRuntimeToolNames(): string[] {
  const toolFactories: Array<(ctx: unknown) => unknown> = [];

  const fakeApi = {
    pluginConfig: {
      grafana: {
        url: "http://test.invalid:3000",
        apiKey: "glsa_test_contracts",
      },
      // Enable alloy so the conditional tool registers — keeps the test
      // covering all 18 declared names, not just the unconditional 17.
      alloy: {
        enabled: true,
        configDir: "/tmp/grafana-lens-test-alloy",
      },
      // Disable metrics so the 16 lifecycle hooks don't try to register
      // (irrelevant to contracts.tools, just noise).
      metrics: { enabled: false },
    },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    registerHttpRoute: () => {},
    registerService: () => {},
    registerTool: (factory: unknown) => {
      // openclaw accepts both factory functions and concrete tool objects;
      // our plugin always passes the factory form, but tolerate both.
      if (typeof factory === "function") {
        toolFactories.push(factory as (ctx: unknown) => unknown);
      } else if (factory && typeof factory === "object" && "name" in factory) {
        // Concrete tool — wrap so the extractor below works uniformly.
        toolFactories.push(() => factory);
      }
    },
    on: () => {},
  };

  // The plugin's register() type expects a richer OpenClawPluginApi, but at
  // runtime it only touches the fields above. Cast through unknown.
  (plugin as { register: (api: unknown) => void }).register(fakeApi);

  const names: string[] = [];
  for (const factory of toolFactories) {
    const result = factory({}) as
      | { name: string }
      | Array<{ name: string }>
      | null
      | undefined;
    if (!result) continue;
    if (Array.isArray(result)) {
      for (const t of result) if (t && typeof t.name === "string") names.push(t.name);
    } else if (typeof result.name === "string") {
      names.push(result.name);
    }
  }
  return names;
}

// ── Tests ──────────────────────────────────────────────────────────

describe("contracts.tools drift-guard (Issue #9)", () => {
  test("manifest contracts.tools exactly matches runtime-registered tool names", () => {
    const declared = new Set(loadManifestToolContracts());
    const runtime = new Set(collectRuntimeToolNames());

    // Two-sided diff so failures point at the actual delta, not just
    // "they don't match".
    const declaredButNotRegistered = [...declared].filter((n) => !runtime.has(n));
    const registeredButNotDeclared = [...runtime].filter((n) => !declared.has(n));

    expect(declaredButNotRegistered).toEqual([]);
    expect(registeredButNotDeclared).toEqual([]);
  });

  test("openclaw's contract gate algorithm emits zero diagnostics against our manifest", () => {
    // Replays openclaw/src/plugins/registry.ts:520-552 — both gates:
    //   Gate A: contracts.tools must be non-empty when registering tools
    //   Gate B: every runtime tool name must be in declaredNames
    const declared = loadManifestToolContracts();
    const runtime = collectRuntimeToolNames();
    const declaredNames = normalizePluginToolNames(declared);

    // Gate A: would emit "plugin must declare contracts.tools before registering agent tools"
    expect(declaredNames.length, "contracts.tools must be non-empty").toBeGreaterThan(0);

    // Gate B: would emit "plugin must declare contracts.tools for: <name>"
    const undeclared = findUndeclaredPluginToolNames({
      declaredNames,
      toolNames: runtime,
    });
    expect(undeclared, "every registered tool name must be in contracts.tools").toEqual([]);
  });

  test("resolveDiagnosticHooks returns a non-null onDiagnosticEvent against installed openclaw", async () => {
    // Issue #9's second symptom: "onDiagnosticEvent not available" on 2026.5.5+
    // because our old fallback chain only tried diagnostics-otel (never shipped)
    // and the root subpath. The new chain tries diagnostic-runtime first.
    const hooks = await resolveDiagnosticHooks();
    expect(hooks.onDiagnosticEvent).toBeTypeOf("function");
    // registerLogTransport is permanently removed at openclaw 2026.5.5+ — null is
    // the new normal, not a regression. We assert nothing about its value here.
  });
});
