import type { PipelineRecipe, ResolvedParams } from "../types.js";
import type { ExportTargets } from "../../types.js";
import { AlloyConfigBuilder, componentLabel, escapeString } from "../../config-builder.js";
import { credentialEnvVar } from "../types.js";

const recipe: PipelineRecipe = {
  name: "redis-exporter",
  category: "metrics",
  signal: "metrics",
  summary: "Redis metrics — memory, connections, commands, keyspace",
  dashboardTemplate: "metric-explorer",
  credentialParams: ["password"],

  requiredParams: [
    { name: "redisUrl", type: "string", description: "Redis connection URL", example: "redis://localhost:6379" },
  ],

  optionalParams: [
    { name: "password", type: "string", description: "Redis password", sensitive: true },
    { name: "scrapeInterval", type: "string", description: "Scrape interval", default: "15s" },
  ],

  generateConfig(pipelineId: string, params: ResolvedParams, targets: ExportTargets, pipelineName: string): string {
    const redisUrl = params.redisUrl as string;
    const scrapeInterval = (params.scrapeInterval as string) || "15s";
    const jobName = (params.jobName as string) || "redis";
    const password = params.password as string | undefined;
    const exp = componentLabel(pipelineId, "redis");
    const scr = componentLabel(pipelineId, "scrape");
    const rel = componentLabel(pipelineId, "relabel");
    const wr = componentLabel(pipelineId, "write");

    let exporterBlock = `prometheus.exporter.redis "${exp}" {\n  redis_addr = "${escapeString(redisUrl)}"`;
    if (password) {
      const envVar = credentialEnvVar("redis-exporter", pipelineName, "password");
      exporterBlock += `\n  redis_password = sys.env("${envVar}")`;
    }
    exporterBlock += "\n}";

    return new AlloyConfigBuilder()
      .addBlock(exporterBlock)
      .addBlock(`prometheus.scrape "${scr}" {\n  targets         = prometheus.exporter.redis.${exp}.targets\n  forward_to      = [prometheus.relabel.${rel}.receiver]\n  job_name        = "${escapeString(jobName)}"\n  scrape_interval = "${escapeString(scrapeInterval)}"\n}`)
      .addBlock(`prometheus.relabel "${rel}" {\n  forward_to = [prometheus.remote_write.${wr}.receiver]\n  rule {\n    target_label = "job"\n    replacement  = "${escapeString(jobName)}"\n  }\n}`)
      .addBlock(`prometheus.remote_write "${wr}" {\n  endpoint {\n    url = "${escapeString(targets.prometheusRemoteWriteUrl)}"\n  }\n}`)
      .build(pipelineId, "redis-exporter", "redis");
  },

  sampleQueries(_params: ResolvedParams, jobName: string) {
    return { upCheck: `redis_up{job="${jobName}"}`, memoryUsed: `redis_memory_used_bytes{job="${jobName}"}`, connectedClients: `redis_connected_clients{job="${jobName}"}` };
  },

  componentIds(pipelineId: string) {
    return [`prometheus.exporter.redis.${componentLabel(pipelineId, "redis")}`, `prometheus.scrape.${componentLabel(pipelineId, "scrape")}`, `prometheus.relabel.${componentLabel(pipelineId, "relabel")}`, `prometheus.remote_write.${componentLabel(pipelineId, "write")}`];
  },
};

export default recipe;
