import type { PipelineRecipe, ResolvedParams } from "../types.js";
import type { ExportTargets } from "../../types.js";
import { AlloyConfigBuilder, componentLabel, escapeString } from "../../config-builder.js";
import { credentialEnvVar } from "../types.js";

const recipe: PipelineRecipe = {
  name: "mysql-exporter",
  category: "metrics",
  signal: "metrics",
  summary: "MySQL database metrics — connections, queries, replication, InnoDB",
  dashboardTemplate: "metric-explorer",
  credentialParams: ["connectionString"],

  requiredParams: [
    { name: "connectionString", type: "string", description: "MySQL DSN", sensitive: true, example: "user:password@tcp(host:3306)/dbname" },
  ],

  optionalParams: [
    { name: "scrapeInterval", type: "string", description: "Scrape interval", default: "15s" },
  ],

  generateConfig(pipelineId: string, params: ResolvedParams, targets: ExportTargets, pipelineName: string): string {
    const scrapeInterval = (params.scrapeInterval as string) || "15s";
    const jobName = (params.jobName as string) || "mysql";
    const exp = componentLabel(pipelineId, "mysql");
    const scr = componentLabel(pipelineId, "scrape");
    const rel = componentLabel(pipelineId, "relabel");
    const wr = componentLabel(pipelineId, "write");
    const envVar = credentialEnvVar("mysql-exporter", pipelineName, "connectionString");

    return new AlloyConfigBuilder()
      .addBlock(`prometheus.exporter.mysql "${exp}" {\n  data_source_names = [sys.env("${envVar}")]\n}`)
      .addBlock(`prometheus.scrape "${scr}" {\n  targets         = prometheus.exporter.mysql.${exp}.targets\n  forward_to      = [prometheus.relabel.${rel}.receiver]\n  job_name        = "${escapeString(jobName)}"\n  scrape_interval = "${escapeString(scrapeInterval)}"\n}`)
      .addBlock(`prometheus.relabel "${rel}" {\n  forward_to = [prometheus.remote_write.${wr}.receiver]\n  rule {\n    target_label = "job"\n    replacement  = "${escapeString(jobName)}"\n  }\n}`)
      .addBlock(`prometheus.remote_write "${wr}" {\n  endpoint {\n    url = "${escapeString(targets.prometheusRemoteWriteUrl)}"\n  }\n}`)
      .build(pipelineId, "mysql-exporter", "mysql");
  },

  sampleQueries(_params: ResolvedParams, jobName: string) {
    return { upCheck: `mysql_up{job="${jobName}"}`, queries: `rate(mysql_global_status_queries{job="${jobName}"}[5m])` };
  },

  componentIds(pipelineId: string) {
    return [`prometheus.exporter.mysql.${componentLabel(pipelineId, "mysql")}`, `prometheus.scrape.${componentLabel(pipelineId, "scrape")}`, `prometheus.relabel.${componentLabel(pipelineId, "relabel")}`, `prometheus.remote_write.${componentLabel(pipelineId, "write")}`];
  },
};

export default recipe;
