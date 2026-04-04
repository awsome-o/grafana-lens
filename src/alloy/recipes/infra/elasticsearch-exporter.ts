import type { PipelineRecipe, ResolvedParams } from "../types.js";
import type { ExportTargets } from "../../types.js";
import { AlloyConfigBuilder, componentLabel, escapeString } from "../../config-builder.js";

const recipe: PipelineRecipe = {
  name: "elasticsearch-exporter",
  category: "infrastructure",
  signal: "metrics",
  summary: "Elasticsearch cluster metrics — health, indices, shards, JVM",
  dashboardTemplate: "metric-explorer",
  credentialParams: ["basicAuth"],

  requiredParams: [
    { name: "elasticsearchUrl", type: "string", description: "Elasticsearch HTTP URL", example: "http://elasticsearch:9200" },
  ],

  optionalParams: [
    { name: "basicAuth", type: "string", description: "Basic auth (user:password)", sensitive: true },
    { name: "scrapeInterval", type: "string", description: "Scrape interval", default: "15s" },
  ],

  generateConfig(pipelineId: string, params: ResolvedParams, targets: ExportTargets, _pipelineName: string): string {
    const esUrl = params.elasticsearchUrl as string;
    const scrapeInterval = (params.scrapeInterval as string) || "15s";
    const jobName = (params.jobName as string) || "elasticsearch";
    const exp = componentLabel(pipelineId, "es");
    const scr = componentLabel(pipelineId, "scrape");
    const rel = componentLabel(pipelineId, "relabel");
    const wr = componentLabel(pipelineId, "write");

    return new AlloyConfigBuilder()
      .addBlock(`prometheus.exporter.elasticsearch "${exp}" {\n  address = "${escapeString(esUrl)}"\n}`)
      .addBlock(`prometheus.scrape "${scr}" {\n  targets         = prometheus.exporter.elasticsearch.${exp}.targets\n  forward_to      = [prometheus.relabel.${rel}.receiver]\n  job_name        = "${escapeString(jobName)}"\n  scrape_interval = "${escapeString(scrapeInterval)}"\n}`)
      .addBlock(`prometheus.relabel "${rel}" {\n  forward_to = [prometheus.remote_write.${wr}.receiver]\n  rule {\n    target_label = "job"\n    replacement  = "${escapeString(jobName)}"\n  }\n}`)
      .addBlock(`prometheus.remote_write "${wr}" {\n  endpoint {\n    url = "${escapeString(targets.prometheusRemoteWriteUrl)}"\n  }\n}`)
      .build(pipelineId, "elasticsearch-exporter", "elasticsearch");
  },

  sampleQueries(_params: ResolvedParams, jobName: string) {
    return { clusterHealth: `elasticsearch_cluster_health_status{job="${jobName}"}`, indexCount: `elasticsearch_indices_docs_total{job="${jobName}"}` };
  },

  componentIds(pipelineId: string) {
    return [`prometheus.exporter.elasticsearch.${componentLabel(pipelineId, "es")}`, `prometheus.scrape.${componentLabel(pipelineId, "scrape")}`, `prometheus.relabel.${componentLabel(pipelineId, "relabel")}`, `prometheus.remote_write.${componentLabel(pipelineId, "write")}`];
  },
};

export default recipe;
