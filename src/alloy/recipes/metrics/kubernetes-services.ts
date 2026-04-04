import type { PipelineRecipe, ResolvedParams } from "../types.js";
import type { ExportTargets } from "../../types.js";
import { AlloyConfigBuilder, componentLabel, escapeString, renderValue } from "../../config-builder.js";

const recipe: PipelineRecipe = {
  name: "kubernetes-services",
  category: "metrics",
  signal: "metrics",
  summary: "Auto-discover and scrape Kubernetes service endpoints (requires K8s RBAC)",
  dashboardTemplate: "multi-kpi",
  credentialParams: [],

  requiredParams: [],

  optionalParams: [
    { name: "namespaces", type: "string[]", description: "Namespaces to discover (empty = all)", default: [] },
    { name: "scrapeInterval", type: "string", description: "Scrape interval", default: "15s" },
  ],

  generateConfig(pipelineId: string, params: ResolvedParams, targets: ExportTargets, _pipelineName: string): string {
    const namespaces = (params.namespaces as string[]) || [];
    const scrapeInterval = (params.scrapeInterval as string) || "15s";
    const jobName = (params.jobName as string) || "kubernetes-services";
    const discLabel = componentLabel(pipelineId, "k8s_svc");
    const scrapeLabel = componentLabel(pipelineId, "scrape");
    const writeLabel = componentLabel(pipelineId, "write");

    const builder = new AlloyConfigBuilder();

    let discBlock = `discovery.kubernetes "${discLabel}" {\n  role = "service"`;
    if (namespaces.length > 0) {
      discBlock += `\n  namespaces {\n    names = ${renderValue(namespaces)}\n  }`;
    }
    discBlock += "\n}";
    builder.addBlock(discBlock);

    const relabelLabel = componentLabel(pipelineId, "relabel");

    builder.addBlock(`prometheus.scrape "${scrapeLabel}" {
  targets         = discovery.kubernetes.${discLabel}.targets
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

    return builder.build(pipelineId, "kubernetes-services", "kubernetes-services");
  },

  sampleQueries(_params: ResolvedParams, jobName: string) {
    return { serviceCount: `count(up{job="${jobName}"})` };
  },

  componentIds(pipelineId: string) {
    return [
      `discovery.kubernetes.${componentLabel(pipelineId, "k8s_svc")}`,
      `prometheus.scrape.${componentLabel(pipelineId, "scrape")}`,
      `prometheus.relabel.${componentLabel(pipelineId, "relabel")}`,
      `prometheus.remote_write.${componentLabel(pipelineId, "write")}`,
    ];
  },
};

export default recipe;
