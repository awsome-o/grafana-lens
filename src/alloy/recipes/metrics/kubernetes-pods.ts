import type { PipelineRecipe, ResolvedParams } from "../types.js";
import type { ExportTargets } from "../../types.js";
import { AlloyConfigBuilder, componentLabel, escapeString, renderValue } from "../../config-builder.js";

const recipe: PipelineRecipe = {
  name: "kubernetes-pods",
  category: "metrics",
  signal: "metrics",
  summary: "Auto-discover and scrape Kubernetes pod metrics (requires K8s RBAC)",
  dashboardTemplate: "multi-kpi",
  credentialParams: [],

  requiredParams: [],

  optionalParams: [
    { name: "namespaces", type: "string[]", description: "Kubernetes namespaces to discover (empty = all)", default: [] },
    { name: "labelSelector", type: "string", description: "Kubernetes label selector for filtering pods", example: "app.kubernetes.io/part-of=mystack" },
    { name: "scrapeInterval", type: "string", description: "Scrape interval", default: "15s" },
  ],

  generateConfig(pipelineId: string, params: ResolvedParams, targets: ExportTargets, _pipelineName: string): string {
    const namespaces = (params.namespaces as string[]) || [];
    const scrapeInterval = (params.scrapeInterval as string) || "15s";
    const jobName = (params.jobName as string) || "kubernetes-pods";
    const discLabel = componentLabel(pipelineId, "k8s_pods");
    const relabelLabel = componentLabel(pipelineId, "relabel");
    const scrapeLabel = componentLabel(pipelineId, "scrape");
    const writeLabel = componentLabel(pipelineId, "write");

    const builder = new AlloyConfigBuilder();

    let discBlock = `discovery.kubernetes "${discLabel}" {\n  role = "pod"`;
    if (namespaces.length > 0) {
      discBlock += `\n  namespaces {\n    names = ${renderValue(namespaces)}\n  }`;
    }
    discBlock += "\n}";
    builder.addBlock(discBlock);

    // Relabel to only scrape pods with prometheus.io/scrape annotation
    builder.addBlock(`discovery.relabel "${relabelLabel}" {
  targets = discovery.kubernetes.${discLabel}.targets

  rule {
    source_labels = ["__meta_kubernetes_pod_annotation_prometheus_io_scrape"]
    regex         = "true"
    action        = "keep"
  }
  rule {
    source_labels = ["__meta_kubernetes_pod_annotation_prometheus_io_path"]
    target_label  = "__metrics_path__"
    regex         = "(.+)"
  }
  rule {
    source_labels = ["__meta_kubernetes_pod_annotation_prometheus_io_port", "__meta_kubernetes_pod_ip"]
    target_label  = "__address__"
    regex         = "(\\\\d+);(\\\\d+\\\\.\\\\d+\\\\.\\\\d+\\\\.\\\\d+)"
    replacement   = "$2:$1"
  }
  rule {
    source_labels = ["__meta_kubernetes_namespace"]
    target_label  = "namespace"
  }
  rule {
    source_labels = ["__meta_kubernetes_pod_name"]
    target_label  = "pod"
  }
}`);

    const metricRelabelLabel = componentLabel(pipelineId, "metric_relabel");

    builder.addBlock(`prometheus.scrape "${scrapeLabel}" {
  targets         = discovery.relabel.${relabelLabel}.output
  forward_to      = [prometheus.relabel.${metricRelabelLabel}.receiver]
  job_name        = "${escapeString(jobName)}"
  scrape_interval = "${escapeString(scrapeInterval)}"
}`);

    builder.addBlock(`prometheus.relabel "${metricRelabelLabel}" {
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

    return builder.build(pipelineId, "kubernetes-pods", "kubernetes-pods");
  },

  sampleQueries(_params: ResolvedParams, jobName: string) {
    return {
      podCount: `count(up{job="${jobName}"})`,
      podsByNamespace: `count by(namespace) (up{job="${jobName}"})`,
    };
  },

  componentIds(pipelineId: string) {
    return [
      `discovery.kubernetes.${componentLabel(pipelineId, "k8s_pods")}`,
      `discovery.relabel.${componentLabel(pipelineId, "relabel")}`,
      `prometheus.scrape.${componentLabel(pipelineId, "scrape")}`,
      `prometheus.relabel.${componentLabel(pipelineId, "metric_relabel")}`,
      `prometheus.remote_write.${componentLabel(pipelineId, "write")}`,
    ];
  },
};

export default recipe;
