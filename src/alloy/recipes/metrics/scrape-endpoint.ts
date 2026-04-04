/**
 * Recipe: scrape-endpoint
 *
 * Scrapes Prometheus metrics from any HTTP endpoint.
 * The most common recipe — covers any app that exposes /metrics.
 *
 * Generated Alloy pipeline:
 *   prometheus.scrape → prometheus.remote_write
 */

import type { PipelineRecipe, ResolvedParams } from "../types.js";
import { credentialEnvVar } from "../types.js";
import type { ExportTargets } from "../../types.js";
import {
  AlloyConfigBuilder,
  componentLabel,
  escapeString,
  renderTargets,
} from "../../config-builder.js";

const recipe: PipelineRecipe = {
  name: "scrape-endpoint",
  category: "metrics",
  signal: "metrics",
  summary: "Scrape Prometheus metrics from any HTTP endpoint",
  dashboardTemplate: "metric-explorer",
  credentialParams: ["basicAuth", "bearerToken"],

  requiredParams: [
    {
      name: "url",
      type: "string",
      description: "Full URL to scrape (host:port or http://host:port/path)",
      example: "http://myapp:8080/metrics",
    },
  ],

  optionalParams: [
    {
      name: "scrapeInterval",
      type: "string",
      description: "How often to scrape",
      default: "15s",
    },
    {
      name: "metricsPath",
      type: "string",
      description: "Path to the metrics endpoint",
      default: "/metrics",
    },
    {
      name: "jobName",
      type: "string",
      description: "Prometheus job label value",
    },
    {
      name: "basicAuth",
      type: "string",
      description: "Basic auth credentials (user:password)",
      sensitive: true,
      example: "admin:secret",
    },
    {
      name: "bearerToken",
      type: "string",
      description: "Bearer token for authentication",
      sensitive: true,
    },
    {
      name: "tlsInsecure",
      type: "boolean",
      description: "Skip TLS certificate verification",
      default: false,
    },
  ],

  generateConfig(
    pipelineId: string,
    params: ResolvedParams,
    targets: ExportTargets,
    pipelineName: string,
  ): string {
    const url = params.url as string;
    const scrapeInterval = (params.scrapeInterval as string) || "15s";
    const metricsPath = (params.metricsPath as string) || "/metrics";
    const jobName = (params.jobName as string) || deriveJobName(url);
    const tlsInsecure = params.tlsInsecure as boolean;
    const basicAuth = params.basicAuth as string | undefined;
    const bearerToken = params.bearerToken as string | undefined;

    // Parse URL to extract address
    const { address, scheme } = parseTarget(url);

    const scrapeLabel = componentLabel(pipelineId, "scrape");
    const writeLabel = componentLabel(pipelineId, "write");

    const builder = new AlloyConfigBuilder();

    // Build scrape block
    let scrapeBlock = `prometheus.scrape "${scrapeLabel}" {
  targets = ${renderTargets([{ address }])}
  forward_to      = [prometheus.remote_write.${writeLabel}.receiver]
  job_name        = "${escapeString(jobName)}"
  scrape_interval = "${escapeString(scrapeInterval)}"
  metrics_path    = "${escapeString(metricsPath)}"
  scheme          = "${scheme}"`;

    if (basicAuth) {
      scrapeBlock += `

  basic_auth {
    username = sys.env("${credentialEnvVar("scrape-endpoint", pipelineName, "basicAuth_user")}")
    password = sys.env("${credentialEnvVar("scrape-endpoint", pipelineName, "basicAuth_pass")}")
  }`;
    }

    if (bearerToken) {
      scrapeBlock += `

  authorization {
    type        = "Bearer"
    credentials = sys.env("${credentialEnvVar("scrape-endpoint", pipelineName, "bearerToken")}")
  }`;
    }

    if (tlsInsecure) {
      scrapeBlock += `

  tls_config {
    insecure_skip_verify = true
  }`;
    }

    scrapeBlock += "\n}";
    builder.addBlock(scrapeBlock);

    // Build remote_write block
    builder.addBlock(`prometheus.remote_write "${writeLabel}" {
  endpoint {
    url = "${escapeString(targets.prometheusRemoteWriteUrl)}"
  }
}`);

    return builder.build(pipelineId, "scrape-endpoint", jobName);
  },

  sampleQueries(_params: ResolvedParams, jobName: string) {
    return {
      upCheck: `up{job="${jobName}"}`,
      scrapeRate: `scrape_samples_scraped{job="${jobName}"}`,
    };
  },

  componentIds(pipelineId: string) {
    return [
      `prometheus.scrape.${componentLabel(pipelineId, "scrape")}`,
      `prometheus.remote_write.${componentLabel(pipelineId, "write")}`,
    ];
  },
};

// ── Helpers ──────────────────────────────────────────────────────────

function parseTarget(url: string): { address: string; scheme: string } {
  try {
    const parsed = new URL(url);
    return {
      address: `${parsed.hostname}${parsed.port ? ":" + parsed.port : ""}`,
      scheme: parsed.protocol.replace(":", "") || "http",
    };
  } catch {
    // If URL parsing fails, treat as host:port
    return { address: url.replace(/^https?:\/\//, ""), scheme: "http" };
  }
}

function deriveJobName(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/\./g, "-");
  } catch {
    return url.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 30);
  }
}

export default recipe;
