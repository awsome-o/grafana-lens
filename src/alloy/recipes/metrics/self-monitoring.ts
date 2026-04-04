import type { PipelineRecipe, ResolvedParams } from "../types.js";
import type { ExportTargets } from "../../types.js";
import { AlloyConfigBuilder, componentLabel, escapeString } from "../../config-builder.js";

const recipe: PipelineRecipe = {
  name: "self-monitoring",
  category: "metrics",
  signal: "metrics",
  summary: "Monitor Alloy itself — component health, evaluation latency, resource usage",
  dashboardTemplate: "metric-explorer",
  credentialParams: [],

  requiredParams: [],

  optionalParams: [
    { name: "scrapeInterval", type: "string", description: "Scrape interval", default: "15s" },
  ],

  generateConfig(pipelineId: string, params: ResolvedParams, targets: ExportTargets, _pipelineName: string): string {
    const scrapeInterval = (params.scrapeInterval as string) || "15s";
    const jobName = (params.jobName as string) || "integrations/alloy";
    const exp = componentLabel(pipelineId, "self");
    const disc = componentLabel(pipelineId, "relabel");
    const scr = componentLabel(pipelineId, "scrape");
    const rel = componentLabel(pipelineId, "relabel_job");
    const wr = componentLabel(pipelineId, "write");

    return new AlloyConfigBuilder()
      .addBlock(`prometheus.exporter.self "${exp}" {}`)
      .addBlock(`discovery.relabel "${disc}" {\n  targets = prometheus.exporter.self.${exp}.targets\n  rule {\n    target_label = "instance"\n    replacement  = constants.hostname\n  }\n}`)
      .addBlock(`prometheus.scrape "${scr}" {\n  targets         = discovery.relabel.${disc}.output\n  forward_to      = [prometheus.relabel.${rel}.receiver]\n  job_name        = "${escapeString(jobName)}"\n  scrape_interval = "${escapeString(scrapeInterval)}"\n}`)
      .addBlock(`prometheus.relabel "${rel}" {\n  forward_to = [prometheus.remote_write.${wr}.receiver]\n  rule {\n    target_label = "job"\n    replacement  = "${escapeString(jobName)}"\n  }\n}`)
      .addBlock(`prometheus.remote_write "${wr}" {\n  endpoint {\n    url = "${escapeString(targets.prometheusRemoteWriteUrl)}"\n  }\n}`)
      .build(pipelineId, "self-monitoring", "alloy-self");
  },

  sampleQueries(_params: ResolvedParams, jobName: string) {
    return {
      buildInfo: `alloy_build_info{job="${jobName}"}`,
      slowEvaluations: `rate(alloy_component_evaluation_slow_seconds_count{job="${jobName}"}[5m])`,
      runningComponents: `alloy_component_controller_running_components{job="${jobName}"}`,
    };
  },

  componentIds(pipelineId: string) {
    return [
      `prometheus.exporter.self.${componentLabel(pipelineId, "self")}`,
      `discovery.relabel.${componentLabel(pipelineId, "relabel")}`,
      `prometheus.scrape.${componentLabel(pipelineId, "scrape")}`,
      `prometheus.relabel.${componentLabel(pipelineId, "relabel_job")}`,
      `prometheus.remote_write.${componentLabel(pipelineId, "write")}`,
    ];
  },
};

export default recipe;
