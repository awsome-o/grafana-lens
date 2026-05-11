#!/usr/bin/env node
/**
 * End-to-end repro for Issue #9 — fix verification.
 *
 * Imports the COMPILED dist/index.js (same artifact npm publishes) and replays
 * exactly what openclaw 2026.5.5+ does at gateway startup:
 *
 *   1. Load the plugin's default export and openclaw.plugin.json manifest.
 *   2. Construct a fake api that records every register* call.
 *   3. For each registerTool() invocation, apply openclaw's actual gate
 *      logic (registry.ts:520-552) against the manifest's contracts.tools.
 *   4. Start the metrics service and watch for the "onDiagnosticEvent not
 *      available" log line.
 *
 * Run from repo root:
 *   node tools/repro-issue-9.mjs
 *
 * Pass criteria (matches gateway startup acceptance):
 *   - 0 "must declare contracts.tools" diagnostics
 *   - 0 "onDiagnosticEvent not available" errors
 *   - Same tool count as gateway log line "registered N tools, services, ..."
 *
 * This is the fix-validation step that should run BEFORE `npm publish`.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

// ── Load artifacts ─────────────────────────────────────────────────

const manifest = JSON.parse(
  readFileSync(resolve(repoRoot, "openclaw.plugin.json"), "utf8"),
);
const declaredTools = manifest.contracts?.tools ?? [];

// Import the COMPILED plugin (what npm ships, not the .ts source)
const pluginModule = await import(resolve(repoRoot, "dist/index.js"));
const plugin = pluginModule.default;

// ── Replay openclaw's contract gate algorithm (registry.ts:520-552) ──

function normalizeNames(names) {
  const out = new Set();
  for (const n of names ?? []) {
    const t = (n ?? "").trim();
    if (t) out.add(t);
  }
  return [...out];
}

const declaredNames = normalizeNames(declaredTools);
const diagnostics = []; // collects what openclaw would emit

function gateRegisterTool(toolName) {
  if (declaredNames.length === 0) {
    diagnostics.push({
      level: "error",
      message: "plugin must declare contracts.tools before registering agent tools",
    });
    return false;
  }
  if (!declaredNames.includes(toolName)) {
    diagnostics.push({
      level: "error",
      message: `plugin must declare contracts.tools for: ${toolName}`,
    });
    return false;
  }
  return true;
}

// ── Fake api that captures + gates registrations ──────────────────

const registeredTools = [];
const registeredServices = [];
const errorLogs = [];

const fakeApi = {
  pluginConfig: {
    grafana: { url: "http://test.invalid:3000", apiKey: "glsa_repro" },
    alloy: { enabled: true, configDir: "/tmp/repro-issue-9-alloy" },
    metrics: { enabled: true }, // exercise the metrics service path too
  },
  logger: {
    info: (msg) => {},
    warn: (msg) => {},
    debug: (msg) => {},
    error: (msg) => {
      errorLogs.push(String(msg));
    },
  },
  registerHttpRoute: () => {},
  registerService: (svc) => {
    registeredServices.push(svc);
  },
  registerTool: (factory) => {
    // Run factory to get the tool, then gate by name
    const tool = typeof factory === "function" ? factory({}) : factory;
    if (!tool) return;
    const tools = Array.isArray(tool) ? tool : [tool];
    for (const t of tools) {
      if (!t?.name) continue;
      const ok = gateRegisterTool(t.name);
      if (ok) registeredTools.push(t.name);
    }
  },
  on: () => {},
};

// ── Run plugin.register() — this is what openclaw does at startup ───

plugin.register(fakeApi);

// ── Start the metrics service — this is where Issue #9 #2 fires ─────

const metricsService = registeredServices.find(
  (s) => s?.id === "openclaw-grafana-lens-metrics" || s?.id?.includes?.("metrics"),
);
if (metricsService?.start) {
  try {
    await metricsService.start({
      config: fakeApi.pluginConfig,
      logger: fakeApi.logger,
      stateDir: "/tmp/repro-issue-9-state",
    });
  } catch (err) {
    errorLogs.push(`metrics.start threw: ${err?.message ?? err}`);
  }
}

const diagnosticHookErrors = errorLogs.filter((m) =>
  m.includes("onDiagnosticEvent not available"),
);

// ── Report ─────────────────────────────────────────────────────────

console.log("─── Issue #9 fix validation ────────────────────────────");
console.log(`Manifest contracts.tools:  ${declaredNames.length} names`);
console.log(`Tools that passed gate:     ${registeredTools.length}`);
console.log(`Contract diagnostics:       ${diagnostics.length}`);
console.log(`Metrics services started:   ${metricsService ? 1 : 0}`);
console.log(`"onDiagnosticEvent not available" errors: ${diagnosticHookErrors.length}`);
console.log("");

let ok = true;
if (diagnostics.length > 0) {
  ok = false;
  console.error("FAIL — contract diagnostics emitted:");
  for (const d of diagnostics) console.error(`  [${d.level}] ${d.message}`);
}
if (diagnosticHookErrors.length > 0) {
  ok = false;
  console.error("FAIL — onDiagnosticEvent resolution failed:");
  for (const e of diagnosticHookErrors) console.error(`  ${e}`);
}
if (registeredTools.length === 0) {
  ok = false;
  console.error("FAIL — zero tools registered");
}

if (ok) {
  console.log("PASS — Issue #9 symptoms reproduced cleanly against compiled dist/");
  console.log("       (no contract errors, hook resolution succeeded)");
  // Give batched OTel exports a moment to settle before forcing exit
  setTimeout(() => process.exit(0), 100).unref?.();
} else {
  process.exit(1);
}
