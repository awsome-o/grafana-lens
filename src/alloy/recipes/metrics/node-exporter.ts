/**
 * Recipe: node-exporter
 *
 * System metrics (CPU, memory, disk, network) via Alloy's built-in
 * Unix exporter. No external node_exporter binary needed.
 *
 * Generated Alloy pipeline:
 *   prometheus.exporter.unix → prometheus.scrape → prometheus.remote_write
 */

import type { PipelineRecipe, ResolvedParams } from "../types.js";
import type { ExportTargets } from "../../types.js";
import { AlloyConfigBuilder, componentLabel, escapeString } from "../../config-builder.js";

const recipe: PipelineRecipe = {
  name: "node-exporter",
  category: "metrics",
  signal: "metrics",
  summary: "System metrics — CPU, memory, disk, network via built-in Unix exporter",
  dashboardTemplate: "metric-explorer",
  credentialParams: [],

  requiredParams: [],

  optionalParams: [
    {
      name: "scrapeInterval",
      type: "string",
      description: "How often to collect system metrics",
      default: "15s",
    },
  ],

  generateConfig(pipelineId: string, params: ResolvedParams, targets: ExportTargets, _pipelineName: string): string {
    const scrapeInterval = (params.scrapeInterval as string) || "15s";
    const jobName = (params.jobName as string) || "node-exporter";
    const exporterLabel = componentLabel(pipelineId, "unix");
    const scrapeLabel = componentLabel(pipelineId, "scrape");
    const relabelLabel = componentLabel(pipelineId, "relabel");
    const writeLabel = componentLabel(pipelineId, "write");

    const builder = new AlloyConfigBuilder();

    builder.addBlock(`prometheus.exporter.unix "${exporterLabel}" { }`);

    builder.addBlock(`prometheus.scrape "${scrapeLabel}" {
  targets         = prometheus.exporter.unix.${exporterLabel}.targets
  forward_to      = [prometheus.relabel.${relabelLabel}.receiver]
  job_name        = "${escapeString(jobName)}"
  scrape_interval = "${escapeString(scrapeInterval)}"
}`);

    // Force job label to pipeline name (built-in exporters override job_name)
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

    return builder.build(pipelineId, "node-exporter", "node-exporter");
  },

  sampleQueries(_params: ResolvedParams, jobName: string) {
    return {
      cpuUsage: `100 - (avg by(instance) (rate(node_cpu_seconds_total{job="${jobName}",mode="idle"}[5m])) * 100)`,
      memoryUsage: `(1 - node_memory_MemAvailable_bytes{job="${jobName}"} / node_memory_MemTotal_bytes{job="${jobName}"}) * 100`,
      diskUsage: `(1 - node_filesystem_avail_bytes{job="${jobName}",mountpoint="/"} / node_filesystem_size_bytes{job="${jobName}",mountpoint="/"}) * 100`,
    };
  },

  componentIds(pipelineId: string) {
    return [
      `prometheus.exporter.unix.${componentLabel(pipelineId, "unix")}`,
      `prometheus.scrape.${componentLabel(pipelineId, "scrape")}`,
      `prometheus.relabel.${componentLabel(pipelineId, "relabel")}`,
      `prometheus.remote_write.${componentLabel(pipelineId, "write")}`,
    ];
  },
};

export default recipe;
