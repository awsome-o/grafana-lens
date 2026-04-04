/**
 * alloy_pipeline — Consolidated Agent Tool
 *
 * Creates and manages Alloy data collection pipelines that continuously
 * feed metrics, logs, and traces into the LGTM stack.
 *
 * Actions: create, list, update, delete, recipes, status, diagnose
 *
 * Design rationale (from tool-design skill — consolidation principle):
 * One tool for all Alloy operations. The agent needs exactly one name to
 * remember for anything pipeline-related. This matches the grafana_check_alerts
 * pattern (8 actions, both mutation and observation in one tool).
 */

import type { AlloyClient } from "../alloy/alloy-client.js";
import { PipelineStore } from "../alloy/pipeline-store.js";
import type { ExportTargets, PipelineDefinition } from "../alloy/types.js";
import { getRecipe, listRecipes, categoryCounts } from "../alloy/recipes/catalog.js";
import { resolveParams, generateCredentialRefs } from "../alloy/recipes/types.js";
import { jsonResult, readStringParam } from "../sdk-compat.js";
import { readFile, writeFile, unlink } from "node:fs/promises";
import {
  extractComponentIds,
  inferSignalFromConfig,
  rawConfigSuggestedWorkflow,
  redactSecrets,
  queryToolForSignal,
  queryTypeForSignal,
  scanForCredentials,
} from "../alloy/pipeline-helpers.js";

type ToolDeps = {
  getClient: () => AlloyClient | null;
  getStore: () => PipelineStore | null;
  getExportTargets: () => ExportTargets;
};

export function createAlloyPipelineToolFactory(deps: ToolDeps) {
  return (_ctx: unknown) => ({
    name: "alloy_pipeline",
    label: "Alloy Pipeline",
    description: `Create and manage Alloy data collection pipelines that continuously feed metrics, logs, traces, and profiles into the LGTM stack.
WORKFLOW: Use action 'recipes' to discover pipeline templates by category. Use 'create' with recipe + params to deploy. Use raw 'config' param for custom patterns not covered by recipes.
Actions: create (deploy pipeline), list (show managed pipelines), update (change params or replace raw config), delete (remove), recipes (browse catalog), status (health check), diagnose (connectivity + drift + all pipeline health).
Categories: metrics (11 recipes — databases, Kubernetes, synthetic probing, self-monitoring), logs (10 recipes — files, Docker, syslog, Kafka, push API, GELF, Faro frontend RUM; all support optional JSON/label/metadata/tenant/match processing), traces (4 recipes — OTLP, multi-policy tail sampling, span-to-metrics RED, service graphs), infrastructure (3 recipes — Docker, Elasticsearch, Kafka), profiling (1 recipe — continuous profiling via Pyroscope).
For custom/unsupported patterns (e.g., Faro frontend RUM, Windows Event Logs): use 'config' param with raw Alloy River syntax (NOT OTel Collector YAML) + optional 'sampleQueries'. Raw config response includes exportTargets with endpoint URLs. See alloy-components reference for component snippets.
Credentials use env var references (never written to config files) — response includes envVarsRequired.
After creating, action 'status' verifies data flow. Then use grafana_query/grafana_query_logs to query, grafana_create_dashboard to visualize, grafana_create_alert to monitor.
Returns sampleQueries (ready-to-use PromQL/LogQL/TraceQL) and suggestedWorkflow with concrete next-step tool calls.`,

    parameters: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: ["create", "list", "update", "delete", "recipes", "status", "diagnose"],
          description: "Action to perform. Default: 'create'.",
        },
        recipe: {
          type: "string",
          description:
            "Recipe name for 'create'. Use action 'recipes' to see full catalog.",
        },
        params: {
          type: "object",
          description:
            "Recipe parameters. E.g., { url: 'http://myapp:8080/metrics' } for scrape-endpoint.",
        },
        config: {
          type: "string",
          description:
            "Raw Alloy River syntax for custom pipelines when no recipe fits. E.g., 'prometheus.scrape \"my_scrape\" { targets = [...] }'. Escape hatch — prefer recipes.",
        },
        name: {
          type: "string",
          description:
            "Pipeline name. Required for 'update', 'delete', 'status'. Auto-generated on 'create' if omitted.",
        },
        category: {
          type: "string",
          enum: ["metrics", "logs", "traces", "infrastructure", "profiling"],
          description: "Filter recipes by category (action 'recipes').",
        },
        signal: {
          type: "string",
          enum: ["metrics", "logs", "traces", "profiles"],
          description: "Signal type for raw-config pipelines (action 'create' with 'config'). Auto-detected from config if omitted. Recipes set this automatically.",
        },
        sampleQueries: {
          type: "object",
          description: "Sample queries for raw-config pipelines (optional). Keys are descriptive names, values are PromQL/LogQL/TraceQL strings. Recipes provide these automatically.",
        },
      },
    },

    async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
      const action = readStringParam(rawParams, "action") ?? "create";

      switch (action) {
        case "create":
          return handleCreate(rawParams, deps);
        case "list":
          return handleList(deps);
        case "update":
          return handleUpdate(rawParams, deps);
        case "delete":
          return handleDelete(rawParams, deps);
        case "recipes":
          return handleRecipes(rawParams);
        case "status":
          return handleStatus(rawParams, deps);
        case "diagnose":
          return handleDiagnose(deps);
        default:
          return jsonResult({
            error: `Unknown action '${action}'. Valid: create, list, update, delete, recipes, status, diagnose.`,
          });
      }
    },
  });
}

// ── Action Handlers ─────────────────────────────────────────────────

async function handleCreate(
  rawParams: Record<string, unknown>,
  deps: ToolDeps,
) {
  const client = deps.getClient();
  const store = deps.getStore();
  if (!client || !store) return jsonResult({ error: "Alloy pipeline service not initialized — check alloy config in plugin settings." });

  const recipeName = readStringParam(rawParams, "recipe");
  const rawConfig = readStringParam(rawParams, "config");
  const userParams = rawParams.params as Record<string, unknown> | undefined;
  let pipelineName = readStringParam(rawParams, "name");

  if (!recipeName && !rawConfig) {
    return jsonResult({
      error: "Either 'recipe' or 'config' is required for create. Use action 'recipes' to see available templates.",
    });
  }

  // ── Recipe-based creation ─────────────────────────────────────────
  if (recipeName) {
    const recipe = getRecipe(recipeName);
    if (!recipe) {
      const available = listRecipes().map((r) => r.name).join(", ");
      return jsonResult({
        error: `Unknown recipe '${recipeName}'. Available: ${available}. Use action 'recipes' for details.`,
      });
    }

    // Validate and resolve params
    let resolved;
    let paramWarnings: string[] = [];
    try {
      const result = resolveParams(recipe, userParams);
      resolved = result.params;
      paramWarnings = result.warnings;
    } catch (err) {
      return jsonResult({
        error: err instanceof Error ? err.message : String(err),
        status: "validation_error",
      });
    }

    // Generate pipeline name if not provided — auto-append suffix for uniqueness
    if (!pipelineName) {
      pipelineName = recipeName;
      if (store.get(pipelineName)) {
        let suffix = 2;
        while (store.get(`${recipeName}-${suffix}`)) suffix++;
        pipelineName = `${recipeName}-${suffix}`;
      }
    }

    // jobName defaults to pipeline name so config + sampleQueries stay in sync
    if (resolved.jobName === undefined) {
      resolved.jobName = pipelineName;
    }

    // Ensure unique name (only errors for user-provided names — auto-names are disambiguated above)
    if (store.get(pipelineName)) {
      return jsonResult({
        error: `Pipeline "${pipelineName}" already exists. Use a different name or delete the existing one with action 'delete'.`,
      });
    }

    // Check port conflicts (listener-based recipes only)
    const ports = recipe.boundPorts?.(resolved) ?? [];
    if (ports.length > 0) {
      const conflict = store.checkPortConflict(ports);
      if (conflict) {
        const portParamHint = recipe.optionalParams.find((p) => p.name === "grpcPort" || p.name === "httpPort" || p.name === "listenPort")
          ? ` Set a different port via params (e.g., grpcPort, httpPort, or listenPort).`
          : "";
        return jsonResult({
          error: `Port ${conflict.port} is already used by pipeline '${conflict.pipelineName}'.${portParamHint}`,
          status: "validation_error",
        });
      }
    }

    const pipelineId = store.generateId();
    const targets = deps.getExportTargets();

    let configContent: string;
    try {
      configContent = recipe.generateConfig(pipelineId, resolved, targets, pipelineName);
    } catch (err) {
      return jsonResult({
        error: `Failed to generate config: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // Compute shared state before reload — needed for both success and pending paths
    const credRefs = generateCredentialRefs(recipe, pipelineName, resolved);
    const envVarsRequired = credRefs.map((c) => c.envVar);
    const hasCredentials = recipe.credentialParams.length > 0;
    const sampleQueries = recipe.sampleQueries(resolved, pipelineName);
    const queryType = queryTypeForSignal(recipe.signal);
    const filePath = store.configFilePath(pipelineId, pipelineName);

    try {
      await writeFile(filePath, configContent, "utf-8");
    } catch (err) {
      return jsonResult({
        error: `Failed to write config file: ${err instanceof Error ? err.message : String(err)} — check that Alloy config directory exists and is writable.`,
      });
    }

    const reload = await client.reload();
    if (!reload.ok) {
      if (hasCredentials) {
        // Two-phase creation: credential recipes keep the file and enter "pending" state.
        // Alloy will activate this pipeline once the user sets the env vars and checks status.
        const pipeline: PipelineDefinition = {
          id: pipelineId, name: pipelineName, recipe: recipeName,
          params: redactSecrets(resolved, recipe), filePath, status: "pending",
          componentIds: recipe.componentIds(pipelineId), signal: recipe.signal,
          createdAt: Date.now(), updatedAt: Date.now(),
          configHash: PipelineStore.configHash(configContent),
          boundPorts: ports.length > 0 ? ports : undefined,
        };
        store.add(pipeline);
        await store.save();

        return jsonResult({
          status: "pending_credentials",
          name: pipelineName,
          recipe: recipeName,
          signal: recipe.signal,
          configFile: filePath.split("/").pop(),
          reloaded: false,
          envVarsRequired,
          envVarInstructions: `Pipeline config is saved but Alloy needs these env vars set before it can connect: ${envVarsRequired.join(", ")}. Set them where Alloy runs, then check with action 'status' — the pipeline will auto-activate once components are healthy.`,
          warnings: paramWarnings.length > 0 ? paramWarnings : undefined,
          sampleQueries: { [queryType]: sampleQueries },
          suggestedWorkflow: [
            { tool: "alloy_pipeline", action: "Check if pipeline activated after setting env vars", example: { action: "status", name: pipelineName } },
          ],
        });
      }

      // Non-credential recipe: rollback
      try {
        await unlink(filePath);
        await client.reload();
      } catch {
        // Best-effort rollback
      }
      return jsonResult({
        error: `Pipeline config rejected by Alloy: ${reload.error}. Pipeline rolled back — previous config restored.`,
        status: "rolled_back",
        alloyError: reload.error,
      });
    }

    const pipeline: PipelineDefinition = {
      id: pipelineId, name: pipelineName, recipe: recipeName,
      params: redactSecrets(resolved, recipe), filePath, status: "active",
      componentIds: recipe.componentIds(pipelineId), signal: recipe.signal,
      createdAt: Date.now(), updatedAt: Date.now(),
      configHash: PipelineStore.configHash(configContent),
      boundPorts: ports.length > 0 ? ports : undefined,
    };
    store.add(pipeline);
    await store.save();

    return jsonResult({
      status: "created",
      name: pipelineName,
      recipe: recipeName,
      signal: recipe.signal,
      configFile: filePath.split("/").pop(),
      reloaded: true,
      envVarsRequired,
      envVarInstructions: envVarsRequired.length > 0
        ? `Set these env vars where Alloy runs: ${envVarsRequired.join(", ")}. Then reload Alloy or restart it.`
        : undefined,
      warnings: paramWarnings.length > 0 ? paramWarnings : undefined,
      sampleQueries: { [queryType]: sampleQueries },
      suggestedWorkflow: [
        {
          tool: "alloy_pipeline",
          action: "Verify data is flowing",
          example: { action: "status", name: pipelineName },
        },
        recipe.signal === "metrics"
          ? { tool: "grafana_list_metrics", action: "Discover metrics from pipeline", example: { search: pipelineName.slice(0, 10) } }
          : recipe.signal === "logs"
            ? { tool: "grafana_query_logs", action: "Search collected logs", example: { expr: Object.values(sampleQueries)[0] } }
            : { tool: "grafana_query_traces", action: "Search collected traces", example: { query: Object.values(sampleQueries)[0] } },
        recipe.dashboardTemplate
          ? { tool: "grafana_create_dashboard", action: "Visualize collected data", example: { template: recipe.dashboardTemplate } }
          : null,
        recipe.signal === "metrics"
          ? { tool: "grafana_create_alert", action: "Alert on collected metrics", example: { expr: Object.values(sampleQueries)[0] } }
          : null,
      ].filter(Boolean),
    });
  }

  // ── Raw config creation ───────────────────────────────────────────
  if (rawConfig) {
    if (!pipelineName) {
      return jsonResult({
        error: "Pipeline 'name' is required when using raw config.",
      });
    }

    if (store.get(pipelineName)) {
      return jsonResult({
        error: `Pipeline "${pipelineName}" already exists.`,
      });
    }

    // Scan for plaintext credentials — advisory warnings, doesn't block creation
    const credentialWarnings = scanForCredentials(rawConfig);

    const pipelineId = store.generateId();
    const filePath = store.configFilePath(pipelineId, pipelineName);

    try {
      await writeFile(filePath, rawConfig, "utf-8");
    } catch (err) {
      return jsonResult({
        error: `Failed to write config file: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    const reload = await client.reload();
    if (!reload.ok) {
      try { await unlink(filePath); await client.reload(); } catch { /* rollback */ }
      return jsonResult({ error: `Config rejected by Alloy: ${reload.error}. Rolled back.`, status: "rolled_back" });
    }

    // Auto-detect signal from config if not explicitly provided
    const rawSignal = readStringParam(rawParams, "signal");
    const validSignals = ["metrics", "logs", "traces", "profiles"];
    const signal: PipelineDefinition["signal"] = rawSignal && validSignals.includes(rawSignal)
      ? rawSignal as PipelineDefinition["signal"]
      : inferSignalFromConfig(rawConfig);

    // Accept optional sample queries for raw-config pipelines
    const userSampleQueries = rawParams.sampleQueries as Record<string, string> | undefined;

    const pipeline: PipelineDefinition = {
      id: pipelineId,
      name: pipelineName,
      recipe: null,
      params: {},
      sampleQueries: userSampleQueries,
      filePath,
      status: "active",
      componentIds: extractComponentIds(rawConfig),
      signal,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      configHash: PipelineStore.configHash(rawConfig),
    };
    store.add(pipeline);
    await store.save();

    const queryType = queryTypeForSignal(signal);

    const exportTargets = deps.getExportTargets();
    return jsonResult({
      status: "created",
      name: pipelineName,
      recipe: null,
      signal,
      configFile: filePath.split("/").pop(),
      reloaded: true,
      envVarsRequired: [],
      credentialWarnings: credentialWarnings.length > 0 ? credentialWarnings : undefined,
      credentialGuidance: credentialWarnings.length > 0
        ? "This config contains plaintext credentials. Consider using a recipe instead — recipes use sys.env() so secrets never touch disk. If raw config is required, wrap sensitive values in sys.env(\"MY_VAR\")."
        : undefined,
      sampleQueries: userSampleQueries ? { [queryType]: userSampleQueries } : undefined,
      suggestedWorkflow: rawConfigSuggestedWorkflow(pipelineName, signal, userSampleQueries),
      exportTargets: {
        prometheusRemoteWriteUrl: exportTargets.prometheusRemoteWriteUrl,
        lokiWriteUrl: exportTargets.lokiWriteUrl,
        otlpEndpoint: exportTargets.otlpEndpoint,
      },
    });
  }

  // Unreachable — guard at top ensures recipeName or rawConfig is set
  return jsonResult({ error: "Either 'recipe' or 'config' is required." });
}

async function handleList(deps: ToolDeps) {
  const store = deps.getStore();
  if (!store) return jsonResult({ error: "Alloy pipeline service not initialized." });

  const pipelines = store.list();
  return jsonResult({
    pipelines: pipelines.map((p) => ({
      name: p.name,
      recipe: p.recipe,
      status: p.status,
      signal: p.signal,
      createdAt: new Date(p.createdAt).toISOString(),
    })),
    count: pipelines.length,
    limits: store.usage(),
  });
}

async function handleUpdate(rawParams: Record<string, unknown>, deps: ToolDeps) {
  const client = deps.getClient();
  const store = deps.getStore();
  if (!client || !store) return jsonResult({ error: "Alloy pipeline service not initialized." });

  const name = readStringParam(rawParams, "name");
  if (!name) return jsonResult({ error: "Pipeline 'name' is required for update." });

  const pipeline = store.get(name);
  if (!pipeline) return jsonResult({ error: `Pipeline "${name}" not found. Use action 'list' to see all pipelines.` });

  // ── Raw-config pipeline update (full config replacement) ──────────
  if (!pipeline.recipe) {
    const newConfig = readStringParam(rawParams, "config");
    if (!newConfig) {
      return jsonResult({
        error: "Raw-config pipelines require 'config' param for update (full config replacement). Recipe-based pipelines use 'params' for partial updates.",
        status: "validation_error",
      });
    }

    const filePath = pipeline.filePath;

    // Read existing config for rollback
    let previousConfig: string | null = null;
    try {
      previousConfig = await readFile(filePath, "utf-8");
    } catch { /* file may not exist */ }

    try {
      await writeFile(filePath, newConfig, "utf-8");
    } catch (err) {
      return jsonResult({ error: `Failed to write config: ${err instanceof Error ? err.message : String(err)}` });
    }

    const reload = await client.reload();
    if (!reload.ok) {
      if (previousConfig) {
        try { await writeFile(filePath, previousConfig, "utf-8"); await client.reload(); } catch { /* best-effort */ }
      }
      return jsonResult({ error: `Update rejected by Alloy: ${reload.error}. Rolled back to previous config.`, status: "rolled_back" });
    }

    // Update sample queries if provided
    const userSampleQueries = rawParams.sampleQueries as Record<string, string> | undefined;
    const updatedParams = { ...pipeline.params };
    const updatedSampleQueries = userSampleQueries ?? pipeline.sampleQueries;

    store.update(name, {
      params: updatedParams,
      configHash: PipelineStore.configHash(newConfig),
      componentIds: extractComponentIds(newConfig),
      sampleQueries: updatedSampleQueries,
    });
    await store.save();

    return jsonResult({
      status: "updated",
      name,
      recipe: null,
      sampleQueries: updatedSampleQueries ? { [pipeline.signal]: updatedSampleQueries } : undefined,
      suggestedWorkflow: [
        { tool: "alloy_pipeline", action: "Verify updated pipeline", example: { action: "status", name } },
      ],
    });
  }

  // ── Recipe-based pipeline update (param merging) ──────────────────
  const recipe = getRecipe(pipeline.recipe);
  if (!recipe) return jsonResult({ error: `Recipe "${pipeline.recipe}" no longer available.` });

  const newParams = rawParams.params as Record<string, unknown> | undefined;
  const merged = { ...pipeline.params, ...newParams };

  let resolved;
  let paramWarnings: string[] = [];
  try {
    const result = resolveParams(recipe, merged);
    resolved = result.params;
    paramWarnings = result.warnings;
  } catch (err) {
    return jsonResult({ error: err instanceof Error ? err.message : String(err), status: "validation_error" });
  }

  const targets = deps.getExportTargets();
  const configContent = recipe.generateConfig(pipeline.id, resolved, targets, name);
  const filePath = pipeline.filePath;

  // Read existing config for rollback BEFORE overwriting
  let previousConfig: string | null = null;
  try {
    previousConfig = await readFile(filePath, "utf-8");
  } catch { /* file may not exist — rollback not possible */ }

  try {
    await writeFile(filePath, configContent, "utf-8");
  } catch (err) {
    return jsonResult({ error: `Failed to write config: ${err instanceof Error ? err.message : String(err)}` });
  }

  const reload = await client.reload();
  if (!reload.ok) {
    if (previousConfig) {
      try {
        await writeFile(filePath, previousConfig, "utf-8");
        await client.reload();
      } catch { /* best-effort rollback */ }
    }
    return jsonResult({ error: `Update rejected by Alloy: ${reload.error}. Rolled back to previous config.`, status: "rolled_back" });
  }

  store.update(name, {
    params: redactSecrets(resolved, recipe),
    configHash: PipelineStore.configHash(configContent),
  });
  await store.save();

  // Regenerate sample queries with updated params
  const updatedSampleQueries = recipe.sampleQueries(resolved, name);
  const updatedQueryType = queryTypeForSignal(recipe.signal);

  return jsonResult({
    status: "updated",
    name,
    recipe: pipeline.recipe,
    warnings: paramWarnings.length > 0 ? paramWarnings : undefined,
    sampleQueries: { [updatedQueryType]: updatedSampleQueries },
    suggestedWorkflow: [
      { tool: "alloy_pipeline", action: "Verify updated pipeline", example: { action: "status", name } },
    ],
  });
}

async function handleDelete(rawParams: Record<string, unknown>, deps: ToolDeps) {
  const client = deps.getClient();
  const store = deps.getStore();
  if (!client || !store) return jsonResult({ error: "Alloy pipeline service not initialized." });

  const name = readStringParam(rawParams, "name");
  if (!name) return jsonResult({ error: "Pipeline 'name' is required for delete." });

  const pipeline = store.get(name);
  if (!pipeline) return jsonResult({ error: `Pipeline "${name}" not found.` });

  // Delete config file
  try {
    await unlink(pipeline.filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      return jsonResult({ error: `Failed to delete config file: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  // Reload to remove components
  await client.reload();

  store.remove(name);
  await store.save();

  return jsonResult({ status: "deleted", name });
}

function handleRecipes(rawParams: Record<string, unknown>) {
  const category = readStringParam(rawParams, "category") as "metrics" | "logs" | "traces" | "infrastructure" | "profiling" | undefined;
  const recipes = listRecipes(category);

  return jsonResult({
    categories: categoryCounts(),
    recipes: recipes.map((r) => ({
      name: r.name,
      category: r.category,
      signal: r.signal,
      summary: r.summary,
      requiredParams: r.requiredParams.map((p) => ({
        name: p.name,
        type: p.type,
        description: p.description,
        sensitive: p.sensitive,
        example: p.example,
      })),
      optionalParams: r.optionalParams.map((p) => ({
        name: p.name,
        type: p.type,
        default: p.default,
      })),
      hasCredentials: r.credentialParams.length > 0,
      dashboardTemplate: r.dashboardTemplate,
    })),
  });
}

async function handleStatus(rawParams: Record<string, unknown>, deps: ToolDeps) {
  const client = deps.getClient();
  const store = deps.getStore();
  if (!client || !store) return jsonResult({ error: "Alloy pipeline service not initialized." });

  const name = readStringParam(rawParams, "name");
  if (!name) return jsonResult({ error: "Pipeline 'name' is required for status. Use action 'list' to see pipeline names." });

  const pipeline = store.get(name);
  if (!pipeline) return jsonResult({ error: `Pipeline "${name}" not found.` });

  // Check component health
  if (pipeline.componentIds.length === 0) {
    return jsonResult({
      name,
      status: pipeline.status,
      recipe: pipeline.recipe,
      signal: pipeline.signal,
      components: [],
      dataVerification: null,
      remediation: pipeline.status === "drift" ? "Pipeline has drifted — try action 'delete' and recreate." : null,
    });
  }

  const health = await client.checkPipelineHealth(pipeline.componentIds);

  // Determine display status and map to valid PipelineStatus for persistence
  let displayStatus: string;
  let persistStatus: PipelineDefinition["status"] | null = null;
  let remediation: string | null = null;

  if (health.missing.length > 0) {
    displayStatus = "error";
    persistStatus = "drift";
    remediation = `${health.missing.length} component(s) not found in Alloy — the pipeline may need to be recreated. Try action 'delete' then 'create' again.`;
  } else if (health.unhealthy.length > 0) {
    displayStatus = "degraded";
    persistStatus = "drift";
    remediation = `${health.unhealthy.length} component(s) unhealthy: ${health.unhealthy.map((u) => `${u.id} (${u.message})`).join("; ")}`;
  } else {
    displayStatus = "healthy";
    persistStatus = "active";
  }

  // Update stored status if changed (only write valid PipelineStatus values)
  if (pipeline.status !== persistStatus) {
    store.update(name, { status: persistStatus, lastError: remediation ?? undefined });
    await store.save();
  }

  // Build data verification hint
  const recipe = pipeline.recipe ? getRecipe(pipeline.recipe) : null;
  let dataVerification = null;
  if (recipe) {
    const queries = recipe.sampleQueries(pipeline.params, name);
    const firstQuery = Object.values(queries)[0];
    if (firstQuery) {
      dataVerification = { hasData: displayStatus === "healthy", verifyQuery: firstQuery, tool: queryToolForSignal(recipe.signal) };
    }
  } else {
    // Raw-config pipeline — use stored sample queries if available
    const storedQueries = pipeline.sampleQueries;
    if (storedQueries) {
      const firstQuery = Object.values(storedQueries)[0];
      if (firstQuery) {
        dataVerification = { hasData: displayStatus === "healthy", verifyQuery: firstQuery, tool: queryToolForSignal(pipeline.signal) };
      }
    }
  }

  return jsonResult({
    name,
    status: displayStatus,
    recipe: pipeline.recipe,
    signal: pipeline.signal,
    components: [
      ...health.healthy.map((id) => ({ id, health: "healthy", detail: "Running" })),
      ...health.unhealthy.map((u) => ({ id: u.id, health: "unhealthy", detail: u.message })),
      ...health.missing.map((id) => ({ id, health: "missing", detail: "Not found in Alloy" })),
    ],
    dataVerification,
    remediation,
  });
}

async function handleDiagnose(deps: ToolDeps) {
  const client = deps.getClient();
  const store = deps.getStore();
  if (!client || !store) return jsonResult({ error: "Alloy pipeline service not initialized." });

  // Run connectivity check and drift detection in parallel (independent I/O)
  const [health, drift] = await Promise.all([
    client.healthy(),
    store.detectFileDrift(),
  ]);

  const alloyConnectivity = {
    reachable: health.ok || !!health.unhealthyComponents,
    healthy: health.ok,
    url: client.baseUrl,
    error: health.error,
  };

  const pipelines = store.list();
  const pipelineHealth = pipelines.map((p) => ({
    name: p.name,
    recipe: p.recipe,
    status: p.status,
    signal: p.signal,
    lastError: p.lastError,
  }));

  const driftUpdated = store.applyDriftReport(drift);
  if (driftUpdated > 0) await store.save();

  const usage = store.usage();

  return jsonResult({
    alloyConnectivity,
    managedPipelines: pipelines.length,
    pipelineHealth,
    driftDetected: drift.fileDrift,
    orphanFiles: drift.orphanFiles,
    limits: { used: usage.count, max: usage.max },
  });
}


