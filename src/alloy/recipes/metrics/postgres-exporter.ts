/**
 * Recipe: postgres-exporter
 *
 * PostgreSQL database metrics — connections, replication, locks, queries.
 * Uses Alloy's built-in PostgreSQL exporter.
 *
 * Generated Alloy pipeline:
 *   prometheus.exporter.postgres → prometheus.scrape → prometheus.remote_write
 */

import type { PipelineRecipe, ResolvedParams } from "../types.js";
import type { ExportTargets } from "../../types.js";
import { AlloyConfigBuilder, componentLabel, escapeString } from "../../config-builder.js";
import { credentialEnvVar } from "../types.js";

const recipe: PipelineRecipe = {
  name: "postgres-exporter",
  category: "metrics",
  signal: "metrics",
  summary: "PostgreSQL database metrics — connections, replication, locks, queries",
  dashboardTemplate: "metric-explorer",
  credentialParams: ["connectionString"],

  requiredParams: [
    {
      name: "connectionString",
      type: "string",
      description: "PostgreSQL connection URI",
      sensitive: true,
      example: "postgres://user:password@host:5432/dbname",
    },
  ],

  optionalParams: [
    {
      name: "scrapeInterval",
      type: "string",
      description: "How often to collect database metrics",
      default: "15s",
    },
  ],

  generateConfig(pipelineId: string, params: ResolvedParams, targets: ExportTargets, pipelineName: string): string {
    const scrapeInterval = (params.scrapeInterval as string) || "15s";
    const jobName = (params.jobName as string) || "postgres";
    const exporterLabel = componentLabel(pipelineId, "postgres");
    const scrapeLabel = componentLabel(pipelineId, "scrape");
    const relabelLabel = componentLabel(pipelineId, "relabel");
    const writeLabel = componentLabel(pipelineId, "write");

    // Credential always goes through env var — never written to disk
    const envVar = credentialEnvVar("postgres-exporter", pipelineName, "connectionString");

    const builder = new AlloyConfigBuilder();

    builder.addBlock(`prometheus.exporter.postgres "${exporterLabel}" {
  data_source_names = [sys.env("${envVar}")]
}`);

    builder.addBlock(`prometheus.scrape "${scrapeLabel}" {
  targets         = prometheus.exporter.postgres.${exporterLabel}.targets
  forward_to      = [prometheus.relabel.${relabelLabel}.receiver]
  job_name        = "${escapeString(jobName)}"
  scrape_interval = "${escapeString(scrapeInterval)}"
}`);

    builder.addBlock(`prometheus.relabel "${relabelLabel}" {
  forward_to = [prometheus.remote_write.${writeLabel}.receiver]
  rule {
    target_label = "job"
    replacement  = "${escapeString(jobName)}"
  }
}`);

    builder.addBlock(`prometheus.remote_write "${writeLabel}" {
  endpoint {
    url = "${escapeString(targets.prometheusRemoteWriteUrl)}"
  }
}`);

    return builder.build(pipelineId, "postgres-exporter", "postgres");
  },

  sampleQueries(_params: ResolvedParams, jobName: string) {
    return {
      upCheck: `pg_up{job="${jobName}"}`,
      connections: `pg_stat_activity_count{job="${jobName}"}`,
      deadlocks: `rate(pg_stat_database_deadlocks{job="${jobName}"}[5m])`,
    };
  },

  componentIds(pipelineId: string) {
    return [
      `prometheus.exporter.postgres.${componentLabel(pipelineId, "postgres")}`,
      `prometheus.scrape.${componentLabel(pipelineId, "scrape")}`,
      `prometheus.relabel.${componentLabel(pipelineId, "relabel")}`,
      `prometheus.remote_write.${componentLabel(pipelineId, "write")}`,
    ];
  },
};

export default recipe;
