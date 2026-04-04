/**
 * Recipe Catalog — Central Registry
 *
 * Maps recipe names to implementations. This is the lookup table the
 * alloy_pipeline tool uses to match user intent to a pipeline template.
 *
 * The catalog is organized by signal type (metrics, logs, traces) and
 * category (metrics, logs, traces, infrastructure).
 */

import type { PipelineRecipe } from "./types.js";

// ── Import all recipes ──────────────────────────────────────────────

// Metrics (11)
import scrapeEndpoint from "./metrics/scrape-endpoint.js";
import nodeExporter from "./metrics/node-exporter.js";
import postgresExporter from "./metrics/postgres-exporter.js";
import mysqlExporter from "./metrics/mysql-exporter.js";
import redisExporter from "./metrics/redis-exporter.js";
import mongodbExporter from "./metrics/mongodb-exporter.js";
import kubernetesPods from "./metrics/kubernetes-pods.js";
import kubernetesServices from "./metrics/kubernetes-services.js";
import blackboxExporter from "./metrics/blackbox-exporter.js";
import memcachedExporter from "./metrics/memcached-exporter.js";
import selfMonitoring from "./metrics/self-monitoring.js";

// Logs (10)
import dockerLogs from "./logs/docker-logs.js";
import fileLogs from "./logs/file-logs.js";
import syslog from "./logs/syslog.js";
import kubernetesLogs from "./logs/kubernetes-logs.js";
import journalLogs from "./logs/journal-logs.js";
import lokiPushApi from "./logs/loki-push-api.js";
import kafkaLogs from "./logs/kafka-logs.js";
import secretFilterLogs from "./logs/secret-filter-logs.js";
import faroFrontend from "./logs/faro-frontend.js";
import gelfLogs from "./logs/gelf-logs.js";

// Traces (4)
import otlpReceiver from "./traces/otlp-receiver.js";
import applicationTraces from "./traces/application-traces.js";
import spanMetrics from "./traces/span-metrics.js";
import serviceGraph from "./traces/service-graph.js";

// Infrastructure (3)
import dockerMetrics from "./infra/docker-metrics.js";
import elasticsearchExporter from "./infra/elasticsearch-exporter.js";
import kafkaExporter from "./infra/kafka-exporter.js";

// Profiling (1)
import continuousProfiling from "./infra/continuous-profiling.js";

// ── Build catalog ───────────────────────────────────────────────────

const ALL_RECIPES: PipelineRecipe[] = [
  // Metrics (11)
  scrapeEndpoint,
  nodeExporter,
  postgresExporter,
  mysqlExporter,
  redisExporter,
  mongodbExporter,
  kubernetesPods,
  kubernetesServices,
  blackboxExporter,
  memcachedExporter,
  selfMonitoring,
  // Logs (10)
  dockerLogs,
  fileLogs,
  syslog,
  kubernetesLogs,
  journalLogs,
  lokiPushApi,
  kafkaLogs,
  secretFilterLogs,
  faroFrontend,
  gelfLogs,
  // Traces (4)
  otlpReceiver,
  applicationTraces,
  spanMetrics,
  serviceGraph,
  // Infrastructure (3)
  dockerMetrics,
  elasticsearchExporter,
  kafkaExporter,
  // Profiling (1)
  continuousProfiling,
];

const BY_NAME = new Map<string, PipelineRecipe>();
for (const recipe of ALL_RECIPES) {
  BY_NAME.set(recipe.name, recipe);
}

// ── Public API ──────────────────────────────────────────────────────

/** Get a recipe by name. Returns undefined if not found. */
export function getRecipe(name: string): PipelineRecipe | undefined {
  return BY_NAME.get(name);
}

/** List all recipes, optionally filtered by category. */
export function listRecipes(
  category?: "metrics" | "logs" | "traces" | "infrastructure" | "profiling",
): PipelineRecipe[] {
  if (category) {
    return ALL_RECIPES.filter((r) => r.category === category);
  }
  return [...ALL_RECIPES];
}

/** Get category counts for the recipes action response. */
export function categoryCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const recipe of ALL_RECIPES) {
    counts[recipe.category] = (counts[recipe.category] ?? 0) + 1;
  }
  return counts;
}

/** Total number of available recipes. */
export const RECIPE_COUNT = ALL_RECIPES.length;
