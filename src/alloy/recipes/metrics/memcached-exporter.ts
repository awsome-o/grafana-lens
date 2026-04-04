import type { PipelineRecipe, ResolvedParams } from "../types.js";
import type { ExportTargets } from "../../types.js";
import { AlloyConfigBuilder, componentLabel, escapeString } from "../../config-builder.js";

const recipe: PipelineRecipe = {
  name: "memcached-exporter",
  category: "metrics",
  signal: "metrics",
  summary: "Memcached metrics — connections, memory, items, evictions",
  dashboardTemplate: "metric-explorer",
  credentialParams: [],

  requiredParams: [
    { name: "memcachedAddress", type: "string", description: "Memcached address (host:port)", example: "memcached:11211" },
  ],

  optionalParams: [
    { name: "scrapeInterval", type: "string", description: "Scrape interval", default: "15s" },
  ],

  generateConfig(pipelineId: string, params: ResolvedParams, targets: ExportTargets, _pipelineName: string): string {
    const address = params.memcachedAddress as string;
    const scrapeInterval = (params.scrapeInterval as string) || "15s";
    const jobName = (params.jobName as string) || "memcached";
    const exp = componentLabel(pipelineId, "memcached");
    const scr = componentLabel(pipelineId, "scrape");
    const rel = componentLabel(pipelineId, "relabel");
    const wr = componentLabel(pipelineId, "write");

    return new AlloyConfigBuilder()
      .addBlock(`prometheus.exporter.memcached "${exp}" {\n  address = "${escapeString(address)}"\n}`)
      .addBlock(`prometheus.scrape "${scr}" {\n  targets         = prometheus.exporter.memcached.${exp}.targets\n  forward_to      = [prometheus.relabel.${rel}.receiver]\n  job_name        = "${escapeString(jobName)}"\n  scrape_interval = "${escapeString(scrapeInterval)}"\n}`)
      .addBlock(`prometheus.relabel "${rel}" {\n  forward_to = [prometheus.remote_write.${wr}.receiver]\n  rule {\n    target_label = "job"\n    replacement  = "${escapeString(jobName)}"\n  }\n}`)
      .addBlock(`prometheus.remote_write "${wr}" {\n  endpoint {\n    url = "${escapeString(targets.prometheusRemoteWriteUrl)}"\n  }\n}`)
      .build(pipelineId, "memcached-exporter", "memcached");
  },

  sampleQueries(_params: ResolvedParams, jobName: string) {
    return {
      upCheck: `memcached_up{job="${jobName}"}`,
      memoryUsed: `memcached_current_bytes{job="${jobName}"}`,
      connections: `memcached_current_connections{job="${jobName}"}`,
    };
  },

  componentIds(pipelineId: string) {
    return [
      `prometheus.exporter.memcached.${componentLabel(pipelineId, "memcached")}`,
      `prometheus.scrape.${componentLabel(pipelineId, "scrape")}`,
      `prometheus.relabel.${componentLabel(pipelineId, "relabel")}`,
      `prometheus.remote_write.${componentLabel(pipelineId, "write")}`,
    ];
  },
};

export default recipe;
