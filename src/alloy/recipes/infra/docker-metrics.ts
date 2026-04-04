import type { PipelineRecipe, ResolvedParams } from "../types.js";
import type { ExportTargets } from "../../types.js";
import { AlloyConfigBuilder, componentLabel, escapeString } from "../../config-builder.js";

const recipe: PipelineRecipe = {
  name: "docker-metrics",
  category: "infrastructure",
  signal: "metrics",
  summary: "Docker container resource metrics via cAdvisor — CPU, memory, network, disk per container",
  dashboardTemplate: "metric-explorer",
  credentialParams: [],

  requiredParams: [],

  optionalParams: [
    { name: "scrapeInterval", type: "string", description: "Scrape interval", default: "15s" },
  ],

  generateConfig(pipelineId: string, params: ResolvedParams, targets: ExportTargets, _pipelineName: string): string {
    const scrapeInterval = (params.scrapeInterval as string) || "15s";
    const jobName = (params.jobName as string) || "docker-metrics";
    const exp = componentLabel(pipelineId, "cadvisor");
    const scr = componentLabel(pipelineId, "scrape");
    const rel = componentLabel(pipelineId, "relabel");
    const wr = componentLabel(pipelineId, "write");

    return new AlloyConfigBuilder()
      .addBlock(`prometheus.exporter.cadvisor "${exp}" { }`)
      .addBlock(`prometheus.scrape "${scr}" {\n  targets         = prometheus.exporter.cadvisor.${exp}.targets\n  forward_to      = [prometheus.relabel.${rel}.receiver]\n  job_name        = "${escapeString(jobName)}"\n  scrape_interval = "${escapeString(scrapeInterval)}"\n}`)
      .addBlock(`prometheus.relabel "${rel}" {\n  forward_to = [prometheus.remote_write.${wr}.receiver]\n  rule {\n    target_label = "job"\n    replacement  = "${escapeString(jobName)}"\n  }\n}`)
      .addBlock(`prometheus.remote_write "${wr}" {\n  endpoint {\n    url = "${escapeString(targets.prometheusRemoteWriteUrl)}"\n  }\n}`)
      .build(pipelineId, "docker-metrics", "docker-metrics");
  },

  sampleQueries(_params: ResolvedParams, jobName: string) {
    return { cpuByContainer: `rate(container_cpu_usage_seconds_total{job="${jobName}"}[5m])`, memoryByContainer: `container_memory_usage_bytes{job="${jobName}"}` };
  },

  componentIds(pipelineId: string) {
    return [`prometheus.exporter.cadvisor.${componentLabel(pipelineId, "cadvisor")}`, `prometheus.scrape.${componentLabel(pipelineId, "scrape")}`, `prometheus.relabel.${componentLabel(pipelineId, "relabel")}`, `prometheus.remote_write.${componentLabel(pipelineId, "write")}`];
  },
};

export default recipe;
