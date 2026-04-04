/**
 * Alloy Pipeline Service
 *
 * Plugin service that manages the lifecycle of the Alloy pipeline system:
 *   - Creates AlloyClient for HTTP API communication
 *   - Creates PipelineStore for state persistence
 *   - Runs drift detection on startup
 *   - Provides getters for tools to access client and store
 *
 * Follows createMetricsCollectorService / createAlertWebhookService pattern:
 *   - Factory function returning { service, getClient, getStore }
 *   - start() initializes everything, stop() cleans up
 *   - Non-blocking startup: logs warnings if Alloy is unreachable but doesn't fail
 */

import type { OpenClawPluginService, OpenClawPluginServiceContext } from "openclaw/plugin-sdk";
import type { GrafanaLensConfig, ValidatedGrafanaLensConfig } from "../config.js";

export type AlloyConfig = NonNullable<GrafanaLensConfig["alloy"]>;
import type { ExportTargets } from "../alloy/types.js";
import { AlloyClient } from "../alloy/alloy-client.js";
import { PipelineStore } from "../alloy/pipeline-store.js";
import { deriveOtlpEndpoints } from "../config.js";

export function createAlloyService(alloyConfig: AlloyConfig, otlpConfig?: ValidatedGrafanaLensConfig["otlp"]): {
  service: OpenClawPluginService;
  getClient: () => AlloyClient | null;
  getStore: () => PipelineStore | null;
  getExportTargets: () => ExportTargets;
} {
  let client: AlloyClient | null = null;
  let store: PipelineStore | null = null;

  // Resolve export targets from existing LGTM config
  const otlpEndpoints = deriveOtlpEndpoints(otlpConfig?.endpoint);
  const exportTargets: ExportTargets = {
    prometheusRemoteWriteUrl:
      alloyConfig.lgtm?.prometheusRemoteWriteUrl ??
      "http://localhost:9009/api/prom/push",
    lokiWriteUrl:
      alloyConfig.lgtm?.lokiUrl ??
      "http://localhost:3100/loki/api/v1/push",
    otlpEndpoint:
      alloyConfig.lgtm?.otlpEndpoint ??
      otlpEndpoints.metrics.replace(/\/v1\/metrics$/, ""),
    pyroscopeWriteUrl:
      alloyConfig.lgtm?.pyroscopeUrl ?? "http://localhost:4040",
  };

  return {
    getClient: () => client,
    getStore: () => store,
    getExportTargets: () => exportTargets,

    service: {
      id: "alloy-pipeline-manager",

      async start(ctx: OpenClawPluginServiceContext) {
        const logger = ctx.logger;

        // ── Create client ──────────────────────────────────────────
        client = new AlloyClient({
          url: alloyConfig.url ?? "http://localhost:12345",
          timeout: 5_000,
        });

        // ── Create store ───────────────────────────────────────────
        if (!alloyConfig.configDir) {
          logger.warn("alloy-service: configDir is required — Alloy pipeline management disabled");
          return;
        }
        store = new PipelineStore({
          stateDir: ctx.stateDir,
          configDir: alloyConfig.configDir,
          filePrefix: alloyConfig.filePrefix ?? "lens-",
          limits: {
            maxPipelines: alloyConfig.maxPipelines ?? 20,
          },
        });

        // ── Load state ─────────────────────────────────────────────
        try {
          await store.load();
          const loaded = store.list();
          if (loaded.length > 0) {
            logger.info(
              `alloy-service: loaded ${loaded.length} managed pipeline(s)`,
            );
          }
        } catch (err) {
          logger.warn(
            `alloy-service: failed to load pipeline state — starting fresh: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }

        // ── Verify Alloy connectivity + drift detection in parallel ──
        const pipelineCount = store.list().length;
        const [healthResult, driftResult] = await Promise.allSettled([
          client.healthy(),
          pipelineCount > 0 ? store.detectFileDrift() : Promise.resolve(null),
        ]);

        // Process health check result
        if (healthResult.status === "fulfilled") {
          const health = healthResult.value;
          if (health.ok) {
            logger.info(
              `alloy-service: Alloy connection verified at ${client.baseUrl}`,
            );
          } else if (health.error) {
            logger.warn(
              `alloy-service: Alloy not reachable at ${client.baseUrl} — pipeline tools will report connectivity issues until Alloy is available`,
            );
          } else if (health.unhealthyComponents?.length) {
            logger.warn(
              `alloy-service: Alloy has ${health.unhealthyComponents.length} unhealthy component(s)`,
            );
          }
        } else {
          logger.warn(
            `alloy-service: failed to check Alloy health — ${
              healthResult.reason instanceof Error ? healthResult.reason.message : String(healthResult.reason)
            }`,
          );
        }

        // Process drift detection result
        if (driftResult.status === "fulfilled" && driftResult.value) {
          const drift = driftResult.value;
          const driftCount = store.applyDriftReport(drift);
          if (driftCount > 0) {
            logger.warn(
              `alloy-service: detected drift in ${driftCount} pipeline(s) — use alloy_pipeline action 'diagnose' for details`,
            );
            await store.save();
          }
          if (drift.orphanFiles.length > 0) {
            logger.info(
              `alloy-service: found ${drift.orphanFiles.length} orphan config file(s) in ${alloyConfig.configDir}`,
            );
          }
        } else if (driftResult.status === "rejected") {
          logger.warn(
            `alloy-service: drift detection failed — ${
              driftResult.reason instanceof Error ? driftResult.reason.message : String(driftResult.reason)
            }`,
          );
        }

        logger.info(
          `alloy-service: ready (${pipelineCount} pipelines, export targets: Mimir=${exportTargets.prometheusRemoteWriteUrl}, Loki=${exportTargets.lokiWriteUrl})`,
        );
      },

      async stop() {
        // Persist any pending state changes
        if (store) {
          try {
            await store.save();
          } catch {
            // Best-effort save on shutdown
          }
        }
        client = null;
        store = null;
      },
    },
  };
}
