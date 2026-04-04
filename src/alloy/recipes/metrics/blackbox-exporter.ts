/**
 * Recipe: blackbox-exporter
 *
 * Synthetic HTTP/TCP/ICMP probing via Alloy's built-in blackbox exporter.
 * Monitors endpoint availability and response times.
 *
 * Generated Alloy pipeline:
 *   prometheus.exporter.blackbox → prometheus.scrape → prometheus.remote_write
 */

import type { PipelineRecipe, ResolvedParams } from "../types.js";
import type { ExportTargets } from "../../types.js";
import { AlloyConfigBuilder, componentLabel, escapeString } from "../../config-builder.js";

type ProbeTarget = { name: string; address: string; module?: string };

const DEFAULT_MODULES = '{ modules: { http_2xx: { prober: http, timeout: 5s } } }';

const recipe: PipelineRecipe = {
  name: "blackbox-exporter",
  category: "metrics",
  signal: "metrics",
  summary: "Synthetic HTTP/TCP/ICMP probing — endpoint availability and response times",
  dashboardTemplate: "metric-explorer",
  credentialParams: [],

  requiredParams: [
    {
      name: "targets",
      type: "object",
      description: "Probe targets array: [{ name, address, module? }]. address=URL to probe, module=blackbox module name (default: http_2xx)",
      example: '[{ "name": "web", "address": "http://myapp:8080", "module": "http_2xx" }]',
    },
  ],

  optionalParams: [
    {
      name: "modules",
      type: "string",
      description: "Inline YAML blackbox config with module definitions",
      default: DEFAULT_MODULES,
    },
    { name: "scrapeInterval", type: "string", description: "Scrape interval", default: "15s" },
  ],

  generateConfig(pipelineId: string, params: ResolvedParams, targets: ExportTargets, _pipelineName: string): string {
    const probeTargets = params.targets as ProbeTarget[];
    const modules = (params.modules as string) || DEFAULT_MODULES;
    const scrapeInterval = (params.scrapeInterval as string) || "15s";
    const jobName = (params.jobName as string) || "blackbox";
    const exp = componentLabel(pipelineId, "blackbox");
    const scr = componentLabel(pipelineId, "scrape");
    const rel = componentLabel(pipelineId, "relabel");
    const wr = componentLabel(pipelineId, "write");

    const targetBlocks = probeTargets.map((t) => {
      const mod = t.module || "http_2xx";
      return `  target {\n    name    = "${escapeString(t.name)}"\n    address = "${escapeString(t.address)}"\n    module  = "${escapeString(mod)}"\n  }`;
    }).join("\n\n");

    return new AlloyConfigBuilder()
      .addBlock(`prometheus.exporter.blackbox "${exp}" {\n  config = "${escapeString(modules)}"\n\n${targetBlocks}\n}`)
      .addBlock(`prometheus.scrape "${scr}" {\n  targets         = prometheus.exporter.blackbox.${exp}.targets\n  forward_to      = [prometheus.relabel.${rel}.receiver]\n  job_name        = "${escapeString(jobName)}"\n  scrape_interval = "${escapeString(scrapeInterval)}"\n}`)
      .addBlock(`prometheus.relabel "${rel}" {\n  forward_to = [prometheus.remote_write.${wr}.receiver]\n  rule {\n    target_label = "job"\n    replacement  = "${escapeString(jobName)}"\n  }\n}`)
      .addBlock(`prometheus.remote_write "${wr}" {\n  endpoint {\n    url = "${escapeString(targets.prometheusRemoteWriteUrl)}"\n  }\n}`)
      .build(pipelineId, "blackbox-exporter", "blackbox");
  },

  sampleQueries(_params: ResolvedParams, jobName: string) {
    return {
      probeSuccess: `probe_success{job="${jobName}"}`,
      httpDuration: `probe_http_duration_seconds{job="${jobName}"}`,
      httpStatusCode: `probe_http_status_code{job="${jobName}"}`,
    };
  },

  componentIds(pipelineId: string) {
    return [
      `prometheus.exporter.blackbox.${componentLabel(pipelineId, "blackbox")}`,
      `prometheus.scrape.${componentLabel(pipelineId, "scrape")}`,
      `prometheus.relabel.${componentLabel(pipelineId, "relabel")}`,
      `prometheus.remote_write.${componentLabel(pipelineId, "write")}`,
    ];
  },
};

export default recipe;
