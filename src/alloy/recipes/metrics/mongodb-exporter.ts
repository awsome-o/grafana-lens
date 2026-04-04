import type { PipelineRecipe, ResolvedParams } from "../types.js";
import type { ExportTargets } from "../../types.js";
import { AlloyConfigBuilder, componentLabel, escapeString } from "../../config-builder.js";
import { credentialEnvVar } from "../types.js";

const recipe: PipelineRecipe = {
  name: "mongodb-exporter",
  category: "metrics",
  signal: "metrics",
  summary: "MongoDB metrics — connections, operations, replication, storage",
  dashboardTemplate: "metric-explorer",
  credentialParams: ["mongodbUri"],

  requiredParams: [
    { name: "mongodbUri", type: "string", description: "MongoDB connection URI", sensitive: true, example: "mongodb://user:pass@host:27017/admin" },
  ],

  optionalParams: [
    { name: "scrapeInterval", type: "string", description: "Scrape interval", default: "15s" },
  ],

  generateConfig(pipelineId: string, params: ResolvedParams, targets: ExportTargets, pipelineName: string): string {
    const scrapeInterval = (params.scrapeInterval as string) || "15s";
    const jobName = (params.jobName as string) || "mongodb";
    const exp = componentLabel(pipelineId, "mongodb");
    const scr = componentLabel(pipelineId, "scrape");
    const rel = componentLabel(pipelineId, "relabel");
    const wr = componentLabel(pipelineId, "write");
    const envVar = credentialEnvVar("mongodb-exporter", pipelineName, "mongodbUri");

    return new AlloyConfigBuilder()
      .addBlock(`prometheus.exporter.mongodb "${exp}" {\n  mongodb_uri = sys.env("${envVar}")\n}`)
      .addBlock(`prometheus.scrape "${scr}" {\n  targets         = prometheus.exporter.mongodb.${exp}.targets\n  forward_to      = [prometheus.relabel.${rel}.receiver]\n  job_name        = "${escapeString(jobName)}"\n  scrape_interval = "${escapeString(scrapeInterval)}"\n}`)
      .addBlock(`prometheus.relabel "${rel}" {\n  forward_to = [prometheus.remote_write.${wr}.receiver]\n  rule {\n    target_label = "job"\n    replacement  = "${escapeString(jobName)}"\n  }\n}`)
      .addBlock(`prometheus.remote_write "${wr}" {\n  endpoint {\n    url = "${escapeString(targets.prometheusRemoteWriteUrl)}"\n  }\n}`)
      .build(pipelineId, "mongodb-exporter", "mongodb");
  },

  sampleQueries(_params: ResolvedParams, jobName: string) {
    return { upCheck: `mongodb_up{job="${jobName}"}`, connections: `mongodb_ss_connections{job="${jobName}",conn_type="current"}` };
  },

  componentIds(pipelineId: string) {
    return [`prometheus.exporter.mongodb.${componentLabel(pipelineId, "mongodb")}`, `prometheus.scrape.${componentLabel(pipelineId, "scrape")}`, `prometheus.relabel.${componentLabel(pipelineId, "relabel")}`, `prometheus.remote_write.${componentLabel(pipelineId, "write")}`];
  },
};

export default recipe;
