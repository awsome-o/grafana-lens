import { describe, expect, test } from "vitest";
import type { ExportTargets } from "../types.js";
import syslogRecipe from "./logs/syslog.js";
import dockerLogsRecipe from "./logs/docker-logs.js";
import applicationTracesRecipe from "./traces/application-traces.js";
import scrapeEndpointRecipe from "./metrics/scrape-endpoint.js";
import nodeExporterRecipe from "./metrics/node-exporter.js";
import kafkaLogsRecipe from "./logs/kafka-logs.js";
import spanMetricsRecipe from "./traces/span-metrics.js";
import serviceGraphRecipe from "./traces/service-graph.js";
import blackboxExporterRecipe from "./metrics/blackbox-exporter.js";
import secretFilterLogsRecipe from "./logs/secret-filter-logs.js";
import continuousProfilingRecipe from "./infra/continuous-profiling.js";
import faroFrontendRecipe from "./logs/faro-frontend.js";
import gelfLogsRecipe from "./logs/gelf-logs.js";
import { resolveParams } from "./types.js";
import { getRecipe } from "./catalog.js";

const TARGETS: ExportTargets = {
  prometheusRemoteWriteUrl: "http://mimir:9009/api/prom/push",
  lokiWriteUrl: "http://loki:3100/loki/api/v1/push",
  otlpEndpoint: "http://tempo:4318",
  pyroscopeWriteUrl: "http://pyroscope:4040",
};

// ── syslog recipe ──────────────────────────────────────────────────

describe("syslog recipe", () => {
  test("generates config with default protocol (tcp)", () => {
    const { params } = resolveParams(syslogRecipe, {});
    const config = syslogRecipe.generateConfig("abc12345", params, TARGETS, "my-syslog");
    expect(config).toContain('protocol = "tcp"');
  });

  test("generates config with udp protocol when specified", () => {
    const { params } = resolveParams(syslogRecipe, { protocol: "udp" });
    const config = syslogRecipe.generateConfig("abc12345", params, TARGETS, "my-syslog");
    expect(config).toContain('protocol = "udp"');
    expect(config).not.toContain('protocol = "tcp"');
  });

  test("uses custom listen address", () => {
    const { params } = resolveParams(syslogRecipe, { listenAddress: "0.0.0.0:5514" });
    const config = syslogRecipe.generateConfig("abc12345", params, TARGETS, "my-syslog");
    expect(config).toContain("0.0.0.0:5514");
  });

  test("escapes protocol value to prevent injection", () => {
    const { params } = resolveParams(syslogRecipe, { protocol: 'tcp"\n  }' });
    const config = syslogRecipe.generateConfig("abc12345", params, TARGETS, "my-syslog");
    // Should be escaped, not raw
    expect(config).not.toContain('protocol = "tcp"\n  }"');
    expect(config).toContain("\\n");
  });
});

// ── docker-logs recipe ─────────────────────────────────────────────

describe("docker-logs recipe", () => {
  test("generates config without filtering when no containers specified", () => {
    const { params } = resolveParams(dockerLogsRecipe, {});
    const config = dockerLogsRecipe.generateConfig("abc12345", params, TARGETS, "my-docker");
    expect(config).toContain("discovery.docker");
    expect(config).toContain("loki.source.docker");
    expect(config).toContain("loki.write");
    // No relabel block when no filtering
    expect(config).not.toContain("discovery.relabel");
  });

  test("generates relabel keep rules for containerNames", () => {
    const { params } = resolveParams(dockerLogsRecipe, { containerNames: ["grafana", "loki"] });
    const config = dockerLogsRecipe.generateConfig("abc12345", params, TARGETS, "my-docker");
    expect(config).toContain("discovery.relabel");
    expect(config).toContain("__meta_docker_container_name");
    expect(config).toContain("grafana|loki");
    expect(config).toContain('"keep"');
  });

  test("generates relabel drop rules for excludeContainers", () => {
    const { params } = resolveParams(dockerLogsRecipe, { excludeContainers: ["noisy-app"] });
    const config = dockerLogsRecipe.generateConfig("abc12345", params, TARGETS, "my-docker");
    expect(config).toContain("discovery.relabel");
    expect(config).toContain("noisy-app");
    expect(config).toContain('"drop"');
  });

  test("generates both keep and drop rules when both specified", () => {
    const { params } = resolveParams(dockerLogsRecipe, {
      containerNames: ["grafana"],
      excludeContainers: ["debug-sidecar"],
    });
    const config = dockerLogsRecipe.generateConfig("abc12345", params, TARGETS, "my-docker");
    expect(config).toContain('"keep"');
    expect(config).toContain('"drop"');
    expect(config).toContain("grafana");
    expect(config).toContain("debug-sidecar");
  });

  test("routes targets through relabel when filtering is active", () => {
    const { params } = resolveParams(dockerLogsRecipe, { containerNames: ["grafana"] });
    const config = dockerLogsRecipe.generateConfig("abc12345", params, TARGETS, "my-docker");
    // loki.source.docker should reference relabel output, not discovery directly
    expect(config).toContain("discovery.relabel.lens_abc12345_relabel.output");
  });

  test("routes targets directly from discovery when no filtering", () => {
    const { params } = resolveParams(dockerLogsRecipe, {});
    const config = dockerLogsRecipe.generateConfig("abc12345", params, TARGETS, "my-docker");
    expect(config).toContain("discovery.docker.lens_abc12345_discover.targets");
  });
});

// ── application-traces recipe ──────────────────────────────────────

describe("application-traces recipe", () => {
  test("generates config without sampling at default sampleRate (1.0)", () => {
    const { params } = resolveParams(applicationTracesRecipe, {});
    const config = applicationTracesRecipe.generateConfig("abc12345", params, TARGETS, "my-traces");
    expect(config).not.toContain("tail_sampling");
    expect(config).toContain("otelcol.receiver.otlp");
    expect(config).toContain("otelcol.processor.attributes");
    expect(config).toContain("otelcol.processor.batch");
    expect(config).toContain("otelcol.exporter.otlphttp");
  });

  test("adds tail_sampling processor when sampleRate < 1.0", () => {
    const { params } = resolveParams(applicationTracesRecipe, { sampleRate: 0.5 });
    const config = applicationTracesRecipe.generateConfig("abc12345", params, TARGETS, "my-traces");
    expect(config).toContain("otelcol.processor.tail_sampling");
    expect(config).toContain("sampling_percentage = 50");
    expect(config).toContain("probabilistic");
    expect(config).toContain("decision_wait");
  });

  test("routes attributes to sampler when sampling enabled", () => {
    const { params } = resolveParams(applicationTracesRecipe, { sampleRate: 0.1 });
    const config = applicationTracesRecipe.generateConfig("abc12345", params, TARGETS, "my-traces");
    // Attributes should route to tail_sampling, not directly to batch
    expect(config).toContain("otelcol.processor.tail_sampling.lens_abc12345_sampler.input");
  });

  test("routes attributes directly to batch when sampling disabled", () => {
    const { params } = resolveParams(applicationTracesRecipe, { sampleRate: 1.0 });
    const config = applicationTracesRecipe.generateConfig("abc12345", params, TARGETS, "my-traces");
    expect(config).toContain("otelcol.processor.batch.lens_abc12345_batch.input");
    expect(config).not.toContain("tail_sampling");
  });

  test("uses environment param in attributes processor", () => {
    const { params } = resolveParams(applicationTracesRecipe, { environment: "staging" });
    const config = applicationTracesRecipe.generateConfig("abc12345", params, TARGETS, "my-traces");
    expect(config).toContain('"staging"');
    expect(config).toContain("deployment.environment");
  });

  test("rounds sampleRate to integer percentage", () => {
    const { params } = resolveParams(applicationTracesRecipe, { sampleRate: 0.333 });
    const config = applicationTracesRecipe.generateConfig("abc12345", params, TARGETS, "my-traces");
    expect(config).toContain("sampling_percentage = 33");
  });

  test("does not sample when sampleRate is 0", () => {
    const { params } = resolveParams(applicationTracesRecipe, { sampleRate: 0 });
    const config = applicationTracesRecipe.generateConfig("abc12345", params, TARGETS, "my-traces");
    // sampleRate=0 means useSampling = false (sampleRate > 0 && < 1.0)
    expect(config).not.toContain("tail_sampling");
  });

  // ── Multi-policy tail sampling (samplingPolicies) ────────────────

  test("generates multi-policy tail_sampling when samplingPolicies provided", () => {
    const { params } = resolveParams(applicationTracesRecipe, {
      samplingPolicies: [
        { name: "keep-errors", type: "status_code", statusCodes: ["ERROR"] },
        { name: "keep-slow", type: "latency", thresholdMs: 5000 },
        { name: "sample-rest", type: "probabilistic", samplingPercentage: 10 },
      ],
    });
    const config = applicationTracesRecipe.generateConfig("abc12345", params, TARGETS, "my-traces");
    expect(config).toContain("otelcol.processor.tail_sampling");
    expect(config).toContain('name = "keep-errors"');
    expect(config).toContain('type = "status_code"');
    expect(config).toContain('status_codes = ["ERROR"]');
    expect(config).toContain('name = "keep-slow"');
    expect(config).toContain("threshold_ms = 5000");
    expect(config).toContain('name = "sample-rest"');
    expect(config).toContain("sampling_percentage = 10");
  });

  test("samplingPolicies takes precedence over sampleRate", () => {
    const { params } = resolveParams(applicationTracesRecipe, {
      sampleRate: 0.5,
      samplingPolicies: [
        { name: "errors-only", type: "status_code", statusCodes: ["ERROR"] },
      ],
    });
    const config = applicationTracesRecipe.generateConfig("abc12345", params, TARGETS, "my-traces");
    // Should use multi-policy, not simple probabilistic from sampleRate
    expect(config).toContain('name = "errors-only"');
    expect(config).not.toContain("sampling_percentage = 50");
  });

  test("generates string_attribute policy with invertMatch", () => {
    const { params } = resolveParams(applicationTracesRecipe, {
      samplingPolicies: [
        { name: "drop-health", type: "string_attribute", key: "http.url", values: ["/health", "/ready"], invertMatch: true },
      ],
    });
    const config = applicationTracesRecipe.generateConfig("abc12345", params, TARGETS, "my-traces");
    expect(config).toContain('key    = "http.url"');
    expect(config).toContain('values = ["/health", "/ready"]');
    expect(config).toContain("invert_match = true");
  });

  test("generates numeric_attribute policy", () => {
    const { params } = resolveParams(applicationTracesRecipe, {
      samplingPolicies: [
        { name: "high-score", type: "numeric_attribute", key: "score", minValue: 70, maxValue: 100 },
      ],
    });
    const config = applicationTracesRecipe.generateConfig("abc12345", params, TARGETS, "my-traces");
    expect(config).toContain('key       = "score"');
    expect(config).toContain("min_value = 70");
    expect(config).toContain("max_value = 100");
  });

  test("uses decisionWait and numTraces params", () => {
    const { params } = resolveParams(applicationTracesRecipe, {
      samplingPolicies: [
        { name: "errors", type: "status_code", statusCodes: ["ERROR"] },
      ],
      decisionWait: "30s",
      numTraces: 500,
    });
    const config = applicationTracesRecipe.generateConfig("abc12345", params, TARGETS, "my-traces");
    expect(config).toContain('decision_wait = "30s"');
    expect(config).toContain("num_traces    = 500");
  });

  test("adds slowTraces sample query when latency policy present", () => {
    const { params } = resolveParams(applicationTracesRecipe, {
      samplingPolicies: [
        { name: "slow", type: "latency", thresholdMs: 3000 },
      ],
    });
    const queries = applicationTracesRecipe.sampleQueries(params, "test");
    expect(queries.slowTraces).toContain("duration > 3000ms");
  });

  test("throws on invalid samplingPolicies (not array)", () => {
    const { params } = resolveParams(applicationTracesRecipe, {
      samplingPolicies: "invalid",
    });
    expect(() =>
      applicationTracesRecipe.generateConfig("abc12345", params, TARGETS, "my-traces"),
    ).toThrow("must be an array");
  });

  test("throws on invalid policy type", () => {
    const { params } = resolveParams(applicationTracesRecipe, {
      samplingPolicies: [{ name: "bad", type: "unknown_type" }],
    });
    expect(() =>
      applicationTracesRecipe.generateConfig("abc12345", params, TARGETS, "my-traces"),
    ).toThrow("must be one of");
  });

  test("throws on empty samplingPolicies array", () => {
    const { params } = resolveParams(applicationTracesRecipe, {
      samplingPolicies: [],
    });
    expect(() =>
      applicationTracesRecipe.generateConfig("abc12345", params, TARGETS, "my-traces"),
    ).toThrow("at least one policy");
  });
});

// ── scrape-endpoint recipe ────────────────────────────────────────

describe("scrape-endpoint recipe", () => {
  test("generates prometheus.scrape + prometheus.remote_write", () => {
    const { params } = resolveParams(scrapeEndpointRecipe, { url: "http://myapp:8080/metrics" });
    const config = scrapeEndpointRecipe.generateConfig("abc12345", params, TARGETS, "my-scrape");
    expect(config).toContain("prometheus.scrape");
    expect(config).toContain("prometheus.remote_write");
    expect(config).toContain(TARGETS.prometheusRemoteWriteUrl);
  });

  test("derives job name from URL hostname", () => {
    const { params } = resolveParams(scrapeEndpointRecipe, { url: "http://myapp:8080/metrics" });
    const config = scrapeEndpointRecipe.generateConfig("abc12345", params, TARGETS, "my-scrape");
    expect(config).toContain('"myapp"');
  });

  test("uses explicit jobName when provided", () => {
    const { params } = resolveParams(scrapeEndpointRecipe, { url: "http://myapp:8080", jobName: "custom-job" });
    const config = scrapeEndpointRecipe.generateConfig("abc12345", params, TARGETS, "my-scrape");
    expect(config).toContain('"custom-job"');
  });

  test("sampleQueries include job name", () => {
    const { params } = resolveParams(scrapeEndpointRecipe, { url: "http://myapp:8080" });
    const queries = scrapeEndpointRecipe.sampleQueries(params, "my-job");
    expect(queries.upCheck).toContain("my-job");
    expect(queries.scrapeRate).toContain("my-job");
  });

  test("componentIds match expected config components", () => {
    const ids = scrapeEndpointRecipe.componentIds("abc12345");
    expect(ids).toHaveLength(2);
    expect(ids[0]).toMatch(/^prometheus\.scrape\./);
    expect(ids[1]).toMatch(/^prometheus\.remote_write\./);
  });

  test("resolveParams throws without required url", () => {
    expect(() => resolveParams(scrapeEndpointRecipe, {})).toThrow("requires 'url'");
  });

  test("credentialParams lists basicAuth and bearerToken", () => {
    expect(scrapeEndpointRecipe.credentialParams).toContain("basicAuth");
    expect(scrapeEndpointRecipe.credentialParams).toContain("bearerToken");
  });

  test("basicAuth generates basic_auth block", () => {
    const { params } = resolveParams(scrapeEndpointRecipe, { url: "http://myapp:8080", basicAuth: "admin:secret" });
    const config = scrapeEndpointRecipe.generateConfig("abc12345", params, TARGETS, "my-scrape");
    expect(config).toContain("basic_auth");
    expect(config).toContain("username");
    expect(config).toContain("password");
  });

  test("bearerToken generates authorization block", () => {
    const { params } = resolveParams(scrapeEndpointRecipe, { url: "http://myapp:8080", bearerToken: "tok_123" });
    const config = scrapeEndpointRecipe.generateConfig("abc12345", params, TARGETS, "my-scrape");
    expect(config).toContain("authorization");
    expect(config).toContain("Bearer");
    expect(config).toContain("credentials");
  });

  test("tlsInsecure adds tls_config block", () => {
    const { params } = resolveParams(scrapeEndpointRecipe, { url: "https://myapp:8443", tlsInsecure: true });
    const config = scrapeEndpointRecipe.generateConfig("abc12345", params, TARGETS, "my-scrape");
    expect(config).toContain("tls_config");
    expect(config).toContain("insecure_skip_verify = true");
  });

  test("tlsInsecure false does not add tls_config block", () => {
    const { params } = resolveParams(scrapeEndpointRecipe, { url: "http://myapp:8080" });
    const config = scrapeEndpointRecipe.generateConfig("abc12345", params, TARGETS, "my-scrape");
    expect(config).not.toContain("tls_config");
  });

  test("uses default scrapeInterval and metricsPath", () => {
    const { params } = resolveParams(scrapeEndpointRecipe, { url: "http://myapp:8080" });
    const config = scrapeEndpointRecipe.generateConfig("abc12345", params, TARGETS, "my-scrape");
    expect(config).toContain('"15s"');
    expect(config).toContain('"/metrics"');
  });
});

// ── node-exporter recipe ──────────────────────────────────────────

describe("node-exporter recipe", () => {
  test("generates config with no params (zero required)", () => {
    const { params } = resolveParams(nodeExporterRecipe, {});
    const config = nodeExporterRecipe.generateConfig("abc12345", params, TARGETS, "my-node");
    expect(config).toContain("prometheus.exporter.unix");
    expect(config).toContain("prometheus.scrape");
    expect(config).toContain("prometheus.relabel");
    expect(config).toContain("prometheus.remote_write");
    expect(config).toContain(TARGETS.prometheusRemoteWriteUrl);
  });

  test("componentIds are non-empty", () => {
    const ids = nodeExporterRecipe.componentIds("abc12345");
    expect(ids.length).toBeGreaterThan(0);
    expect(ids[0]).toMatch(/^prometheus\.exporter\.unix\./);
  });

  test("sampleQueries contain node_ prefix metrics", () => {
    const { params } = resolveParams(nodeExporterRecipe, {});
    const queries = nodeExporterRecipe.sampleQueries(params, "node-exporter");
    expect(queries.cpuUsage).toContain("node_cpu_seconds_total");
    expect(queries.memoryUsage).toContain("node_memory_MemAvailable_bytes");
    expect(queries.diskUsage).toContain("node_filesystem_avail_bytes");
  });

  test("uses custom scrapeInterval", () => {
    const { params } = resolveParams(nodeExporterRecipe, { scrapeInterval: "30s" });
    const config = nodeExporterRecipe.generateConfig("abc12345", params, TARGETS, "my-node");
    expect(config).toContain('"30s"');
  });

  test("has no credential params", () => {
    expect(nodeExporterRecipe.credentialParams).toHaveLength(0);
  });
});

// ── kafka-logs recipe ─────────────────────────────────────────────

describe("kafka-logs recipe", () => {
  test("generates loki.source.kafka + loki.write", () => {
    const { params } = resolveParams(kafkaLogsRecipe, {
      brokers: ["kafka:9092"],
      topics: ["app-logs"],
    });
    const config = kafkaLogsRecipe.generateConfig("abc12345", params, TARGETS, "my-kafka");
    expect(config).toContain("loki.source.kafka");
    expect(config).toContain("loki.write");
    expect(config).toContain(TARGETS.lokiWriteUrl);
  });

  test("resolveParams throws without brokers", () => {
    expect(() => resolveParams(kafkaLogsRecipe, { topics: ["logs"] })).toThrow("requires 'brokers'");
  });

  test("resolveParams throws without topics", () => {
    expect(() => resolveParams(kafkaLogsRecipe, { brokers: ["kafka:9092"] })).toThrow("requires 'topics'");
  });

  test("credentialParams include kafkaAuth", () => {
    expect(kafkaLogsRecipe.credentialParams).toContain("kafkaAuth");
  });

  test("kafkaAuth generates SASL authentication block", () => {
    const { params } = resolveParams(kafkaLogsRecipe, {
      brokers: ["kafka:9092"],
      topics: ["app-logs"],
      kafkaAuth: "user:pass",
    });
    const config = kafkaLogsRecipe.generateConfig("abc12345", params, TARGETS, "my-kafka");
    expect(config).toContain("authentication");
    expect(config).toContain("sasl");
    expect(config).toContain("PLAIN");
    expect(config).toContain("username");
    expect(config).toContain("password");
  });

  test("uses default consumer group when not specified", () => {
    const { params } = resolveParams(kafkaLogsRecipe, {
      brokers: ["kafka:9092"],
      topics: ["app-logs"],
    });
    const config = kafkaLogsRecipe.generateConfig("abc12345", params, TARGETS, "my-kafka");
    expect(config).toContain('"alloy"');
  });

  test("sampleQueries return kafka-specific queries", () => {
    const { params } = resolveParams(kafkaLogsRecipe, {
      brokers: ["kafka:9092"],
      topics: ["app-logs"],
    });
    const queries = kafkaLogsRecipe.sampleQueries(params, "kafka-logs");
    expect(queries.recentLogs).toContain("kafka");
    expect(queries.errorLogs).toContain("error");
  });
});

// ── span-metrics recipe ───────────────────────────────────────────

describe("span-metrics recipe", () => {
  test("generates spanmetrics connector + exporters", () => {
    const { params } = resolveParams(spanMetricsRecipe, {});
    const config = spanMetricsRecipe.generateConfig("abc12345", params, TARGETS, "my-spanmetrics");
    expect(config).toContain("otelcol.receiver.otlp");
    expect(config).toContain("otelcol.processor.batch");
    expect(config).toContain("otelcol.connector.spanmetrics");
    expect(config).toContain("otelcol.exporter.otlphttp");
    expect(config).toContain("otelcol.exporter.otlp");
  });

  test("sampleQueries contain both trace and metrics queries", () => {
    const { params } = resolveParams(spanMetricsRecipe, {});
    const queries = spanMetricsRecipe.sampleQueries(params, "span-metrics");
    expect(queries.requestRate).toContain("traces_spanmetrics_calls_total");
    expect(queries.p95Duration).toContain("traces_spanmetrics_duration_milliseconds_bucket");
    expect(queries.traces).toContain("resource.service.name");
  });

  test("boundPorts returns [grpcPort, httpPort] with defaults", () => {
    const { params } = resolveParams(spanMetricsRecipe, {});
    const ports = spanMetricsRecipe.boundPorts!(params);
    expect(ports).toEqual([4317, 4318]);
  });

  test("boundPorts returns custom ports", () => {
    const { params } = resolveParams(spanMetricsRecipe, { grpcPort: 5317, httpPort: 5318 });
    const ports = spanMetricsRecipe.boundPorts!(params);
    expect(ports).toEqual([5317, 5318]);
  });

  test("includes custom dimensions in config", () => {
    const { params } = resolveParams(spanMetricsRecipe, { dimensions: ["rpc.method", "db.system"] });
    const config = spanMetricsRecipe.generateConfig("abc12345", params, TARGETS, "my-spanmetrics");
    expect(config).toContain("rpc.method");
    expect(config).toContain("db.system");
  });

  test("uses default dimensions when not specified", () => {
    const { params } = resolveParams(spanMetricsRecipe, {});
    const config = spanMetricsRecipe.generateConfig("abc12345", params, TARGETS, "my-spanmetrics");
    expect(config).toContain("http.method");
    expect(config).toContain("http.status_code");
  });

  test("componentIds lists all 5 components", () => {
    const ids = spanMetricsRecipe.componentIds("abc12345");
    expect(ids).toHaveLength(5);
    expect(ids.some((id) => id.startsWith("otelcol.connector.spanmetrics."))).toBe(true);
    expect(ids.some((id) => id.startsWith("otelcol.exporter.otlphttp."))).toBe(true);
    expect(ids.some((id) => id.startsWith("otelcol.exporter.otlp."))).toBe(true);
  });

  test("has no credential params", () => {
    expect(spanMetricsRecipe.credentialParams).toHaveLength(0);
  });
});

// ── service-graph recipe ──────────────────────────────────────────

describe("service-graph recipe", () => {
  test("generates servicegraph connector + exporters", () => {
    const { params } = resolveParams(serviceGraphRecipe, {});
    const config = serviceGraphRecipe.generateConfig("abc12345", params, TARGETS, "my-svcgraph");
    expect(config).toContain("otelcol.receiver.otlp");
    expect(config).toContain("otelcol.processor.batch");
    expect(config).toContain("otelcol.connector.servicegraph");
    expect(config).toContain("otelcol.exporter.otlphttp");
    expect(config).toContain("otelcol.exporter.otlp");
  });

  test("sampleQueries contain service graph metrics", () => {
    const { params } = resolveParams(serviceGraphRecipe, {});
    const queries = serviceGraphRecipe.sampleQueries(params, "service-graph");
    expect(queries.requestTotal).toContain("traces_service_graph_request_total");
    expect(queries.requestDuration).toContain("traces_service_graph_request_server_seconds_bucket");
  });

  test("boundPorts returns [grpcPort, httpPort] with defaults", () => {
    const { params } = resolveParams(serviceGraphRecipe, {});
    const ports = serviceGraphRecipe.boundPorts!(params);
    expect(ports).toEqual([4317, 4318]);
  });

  test("boundPorts returns custom ports", () => {
    const { params } = resolveParams(serviceGraphRecipe, { grpcPort: 6317, httpPort: 6318 });
    const ports = serviceGraphRecipe.boundPorts!(params);
    expect(ports).toEqual([6317, 6318]);
  });

  test("includes store config with defaults", () => {
    const { params } = resolveParams(serviceGraphRecipe, {});
    const config = serviceGraphRecipe.generateConfig("abc12345", params, TARGETS, "my-svcgraph");
    expect(config).toContain("store");
    expect(config).toContain("max_items = 5000");
    expect(config).toContain('"30s"');
  });

  test("componentIds lists all 5 components", () => {
    const ids = serviceGraphRecipe.componentIds("abc12345");
    expect(ids).toHaveLength(5);
    expect(ids.some((id) => id.startsWith("otelcol.connector.servicegraph."))).toBe(true);
  });

  test("has no credential params", () => {
    expect(serviceGraphRecipe.credentialParams).toHaveLength(0);
  });
});

// ── blackbox-exporter recipe ──────────────────────────────────────

describe("blackbox-exporter recipe", () => {
  const probeTargets = [
    { name: "web", address: "http://myapp:8080", module: "http_2xx" },
    { name: "api", address: "http://api:3000", module: "http_2xx" },
  ];

  test("generates prometheus.exporter.blackbox + scrape + remote_write", () => {
    const { params } = resolveParams(blackboxExporterRecipe, { targets: probeTargets });
    const config = blackboxExporterRecipe.generateConfig("abc12345", params, TARGETS, "my-blackbox");
    expect(config).toContain("prometheus.exporter.blackbox");
    expect(config).toContain("prometheus.scrape");
    expect(config).toContain("prometheus.remote_write");
    expect(config).toContain(TARGETS.prometheusRemoteWriteUrl);
  });

  test("targets are rendered in config", () => {
    const { params } = resolveParams(blackboxExporterRecipe, { targets: probeTargets });
    const config = blackboxExporterRecipe.generateConfig("abc12345", params, TARGETS, "my-blackbox");
    expect(config).toContain("web");
    expect(config).toContain("http://myapp:8080");
    expect(config).toContain("api");
    expect(config).toContain("http://api:3000");
    expect(config).toContain("http_2xx");
  });

  test("resolveParams throws without required targets", () => {
    expect(() => resolveParams(blackboxExporterRecipe, {})).toThrow("requires 'targets'");
  });

  test("sampleQueries include probe_success", () => {
    const { params } = resolveParams(blackboxExporterRecipe, { targets: probeTargets });
    const queries = blackboxExporterRecipe.sampleQueries(params, "blackbox");
    expect(queries.probeSuccess).toContain("probe_success");
    expect(queries.httpDuration).toContain("probe_http_duration_seconds");
  });

  test("componentIds lists 4 components", () => {
    const ids = blackboxExporterRecipe.componentIds("abc12345");
    expect(ids).toHaveLength(4);
    expect(ids[0]).toMatch(/^prometheus\.exporter\.blackbox\./);
    expect(ids[3]).toMatch(/^prometheus\.remote_write\./);
  });

  test("has no credential params", () => {
    expect(blackboxExporterRecipe.credentialParams).toHaveLength(0);
  });
});

// ── secret-filter-logs recipe ─────────────────────────────────────

describe("secret-filter-logs recipe", () => {
  test("generates loki.secretfilter component in pipeline", () => {
    const { params } = resolveParams(secretFilterLogsRecipe, { paths: ["/var/log/app/*.log"] });
    const config = secretFilterLogsRecipe.generateConfig("abc12345", params, TARGETS, "my-filter");
    expect(config).toContain("loki.secretfilter");
    expect(config).toContain("local.file_match");
    expect(config).toContain("loki.source.file");
    expect(config).toContain("loki.write");
    expect(config).toContain(TARGETS.lokiWriteUrl);
  });

  test("config contains redact_with default pattern", () => {
    const { params } = resolveParams(secretFilterLogsRecipe, { paths: ["/var/log/*.log"] });
    const config = secretFilterLogsRecipe.generateConfig("abc12345", params, TARGETS, "my-filter");
    expect(config).toContain("redact_with");
    expect(config).toContain("REDACTED");
  });

  test("resolveParams throws without required paths", () => {
    expect(() => resolveParams(secretFilterLogsRecipe, {})).toThrow("requires 'paths'");
  });

  test("renders multiple path targets", () => {
    const { params } = resolveParams(secretFilterLogsRecipe, {
      paths: ["/var/log/app/*.log", "/var/log/svc/*.log"],
    });
    const config = secretFilterLogsRecipe.generateConfig("abc12345", params, TARGETS, "my-filter");
    expect(config).toContain("/var/log/app/*.log");
    expect(config).toContain("/var/log/svc/*.log");
  });

  test("sampleQueries include redaction-relevant queries", () => {
    const { params } = resolveParams(secretFilterLogsRecipe, { paths: ["/var/log/*.log"] });
    const queries = secretFilterLogsRecipe.sampleQueries(params, "secret-filter-logs");
    expect(queries.redactedEntries).toContain("REDACTED");
    expect(queries.logVolume).toContain("rate");
  });

  test("componentIds lists 4 components including secretfilter", () => {
    const ids = secretFilterLogsRecipe.componentIds("abc12345");
    expect(ids).toHaveLength(4);
    expect(ids.some((id) => id.startsWith("loki.secretfilter."))).toBe(true);
    expect(ids.some((id) => id.startsWith("local.file_match."))).toBe(true);
  });

  test("has no credential params", () => {
    expect(secretFilterLogsRecipe.credentialParams).toHaveLength(0);
  });

  test("uses custom redactWith value", () => {
    const { params } = resolveParams(secretFilterLogsRecipe, {
      paths: ["/var/log/*.log"],
      redactWith: "***HIDDEN***",
    });
    const config = secretFilterLogsRecipe.generateConfig("abc12345", params, TARGETS, "my-filter");
    expect(config).toContain("***HIDDEN***");
  });
});

// ── continuous-profiling recipe ────────────────────────────────────

describe("continuous-profiling recipe", () => {
  test("generates pyroscope.scrape + pyroscope.write", () => {
    const { params } = resolveParams(continuousProfilingRecipe, {
      targets: [{ address: "myapp:6060", serviceName: "my-app" }],
    });
    const config = continuousProfilingRecipe.generateConfig("abc12345", params, TARGETS, "my-profiles");
    expect(config).toContain("pyroscope.scrape");
    expect(config).toContain("pyroscope.write");
    expect(config).toContain('"myapp:6060"');
    expect(config).toContain('"my-app"');
    expect(config).toContain(TARGETS.pyroscopeWriteUrl);
  });

  test("enables all profile types by default", () => {
    const { params } = resolveParams(continuousProfilingRecipe, {
      targets: [{ address: "app:6060", serviceName: "svc" }],
    });
    const config = continuousProfilingRecipe.generateConfig("abc12345", params, TARGETS, "profiles");
    expect(config).toContain("profile.process_cpu");
    expect(config).toContain("profile.memory");
    expect(config).toContain("profile.goroutine");
    expect(config).toContain("profile.mutex");
    expect(config).toContain("profile.block");
  });

  test("uses custom pyroscopeUrl when provided", () => {
    const { params } = resolveParams(continuousProfilingRecipe, {
      targets: [{ address: "app:6060", serviceName: "svc" }],
      pyroscopeUrl: "http://custom-pyroscope:9999",
    });
    const config = continuousProfilingRecipe.generateConfig("abc12345", params, TARGETS, "profiles");
    expect(config).toContain("http://custom-pyroscope:9999");
    expect(config).not.toContain(TARGETS.pyroscopeWriteUrl);
  });

  test("supports multiple targets", () => {
    const { params } = resolveParams(continuousProfilingRecipe, {
      targets: [
        { address: "app1:6060", serviceName: "app1" },
        { address: "app2:6060", serviceName: "app2" },
      ],
    });
    const config = continuousProfilingRecipe.generateConfig("abc12345", params, TARGETS, "profiles");
    expect(config).toContain('"app1:6060"');
    expect(config).toContain('"app2:6060"');
  });

  test("throws on missing targets", () => {
    expect(() => resolveParams(continuousProfilingRecipe, {})).toThrow("targets");
  });

  test("throws on invalid target (missing serviceName)", () => {
    const { params } = resolveParams(continuousProfilingRecipe, {
      targets: [{ address: "app:6060" }],
    });
    expect(() =>
      continuousProfilingRecipe.generateConfig("abc12345", params, TARGETS, "profiles"),
    ).toThrow("serviceName");
  });

  test("has correct signal and category", () => {
    expect(continuousProfilingRecipe.signal).toBe("profiles");
    expect(continuousProfilingRecipe.category).toBe("profiling");
  });

  test("generates sample queries using first target serviceName", () => {
    const { params } = resolveParams(continuousProfilingRecipe, {
      targets: [{ address: "app:6060", serviceName: "my-svc" }],
    });
    const queries = continuousProfilingRecipe.sampleQueries(params, "test");
    expect(queries.cpuProfile).toContain("my-svc");
    expect(queries.memoryProfile).toContain("my-svc");
  });

  test("returns component IDs for health checking", () => {
    const ids = continuousProfilingRecipe.componentIds("abc12345");
    expect(ids).toContain("pyroscope.scrape.lens_abc12345_profiles");
    expect(ids).toContain("pyroscope.write.lens_abc12345_write");
  });
});

// ── faro-frontend recipe ───────────────────────────────────────────

describe("faro-frontend recipe", () => {
  test("generates faro.receiver + loki.write", () => {
    const { params } = resolveParams(faroFrontendRecipe, {});
    const config = faroFrontendRecipe.generateConfig("abc12345", params, TARGETS, "my-faro");
    expect(config).toContain("faro.receiver");
    expect(config).toContain("loki.write");
    expect(config).toContain("12347");
    expect(config).toContain('cors_allowed_origins = ["*"]');
    expect(config).toContain(TARGETS.lokiWriteUrl);
  });

  test("uses custom port and CORS origins", () => {
    const { params } = resolveParams(faroFrontendRecipe, {
      listenPort: 9999,
      corsAllowedOrigins: ["https://myapp.com", "https://staging.myapp.com"],
    });
    const config = faroFrontendRecipe.generateConfig("abc12345", params, TARGETS, "my-faro");
    expect(config).toContain("9999");
    expect(config).toContain('"https://myapp.com"');
    expect(config).toContain('"https://staging.myapp.com"');
  });

  test("reports correct bound ports", () => {
    const { params } = resolveParams(faroFrontendRecipe, { listenPort: 8888 });
    expect(faroFrontendRecipe.boundPorts?.(params)).toEqual([8888]);
  });

  test("has correct signal and category", () => {
    expect(faroFrontendRecipe.signal).toBe("logs");
    expect(faroFrontendRecipe.category).toBe("logs");
  });
});

// ── gelf-logs recipe ───────────────────────────────────────────────

describe("gelf-logs recipe", () => {
  test("generates loki.source.gelf + loki.relabel + loki.write", () => {
    const { params } = resolveParams(gelfLogsRecipe, {});
    const config = gelfLogsRecipe.generateConfig("abc12345", params, TARGETS, "my-gelf");
    expect(config).toContain("loki.source.gelf");
    expect(config).toContain("loki.relabel");
    expect(config).toContain("loki.write");
    expect(config).toContain("__gelf_message_host");
    expect(config).toContain("__gelf_message_level");
    expect(config).toContain("__gelf_message_facility");
    expect(config).toContain(TARGETS.lokiWriteUrl);
  });

  test("skips relabel rules when all disabled", () => {
    const { params } = resolveParams(gelfLogsRecipe, {
      relabelHost: false,
      relabelLevel: false,
      relabelFacility: false,
    });
    const config = gelfLogsRecipe.generateConfig("abc12345", params, TARGETS, "my-gelf");
    expect(config).toContain("loki.source.gelf");
    expect(config).not.toContain("loki.relabel");
    // Should forward directly to write
    expect(config).toContain("loki.write.lens_abc12345_write.receiver");
  });

  test("uses custom listen address", () => {
    const { params } = resolveParams(gelfLogsRecipe, { listenAddress: "127.0.0.1:5555" });
    const config = gelfLogsRecipe.generateConfig("abc12345", params, TARGETS, "my-gelf");
    expect(config).toContain("127.0.0.1");
    expect(config).toContain("5555");
  });

  test("reports correct bound ports", () => {
    const { params } = resolveParams(gelfLogsRecipe, { listenAddress: "0.0.0.0:12201" });
    expect(gelfLogsRecipe.boundPorts?.(params)).toEqual([12201]);
  });

  test("has correct signal and category", () => {
    expect(gelfLogsRecipe.signal).toBe("logs");
    expect(gelfLogsRecipe.category).toBe("logs");
  });
});

// ── resolveParams unknown-param warnings ──────────────────────────

describe("resolveParams warnings", () => {
  test("warns about unknown param with synonym suggestion", () => {
    const { params, warnings } = resolveParams(syslogRecipe, { port: 5514 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("port");
    expect(warnings[0]).toContain("listenAddress");
    // Params still resolve correctly (port is ignored)
    expect(params.listenAddress).toBe("0.0.0.0:1514");
  });

  test("warns about unknown param with listenPort suggestion for loki-push-api", () => {
    const lokiPushRecipe = getRecipe("loki-push-api")!;
    const { warnings } = resolveParams(lokiPushRecipe, { port: 4000 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("listenPort");
  });

  test("warns about completely unknown param and lists available", () => {
    const { params, warnings } = resolveParams(syslogRecipe, { banana: "yellow" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("banana");
    expect(warnings[0]).toContain("Available optional params");
    // Known params still resolve
    expect(params.protocol).toBe("tcp");
  });

  test("returns empty warnings for known params", () => {
    const { params, warnings } = resolveParams(syslogRecipe, { protocol: "udp" });
    expect(warnings).toHaveLength(0);
    expect(params.protocol).toBe("udp");
  });

  test("returns empty warnings when no params provided", () => {
    const { warnings } = resolveParams(syslogRecipe, {});
    expect(warnings).toHaveLength(0);
  });

  test("warns about multiple unknown params", () => {
    const { warnings } = resolveParams(syslogRecipe, { port: 5514, host: "192.168.1.1", foo: "bar" });
    expect(warnings).toHaveLength(3);
  });

  test("does not warn about jobName (implicit param)", () => {
    const { warnings } = resolveParams(syslogRecipe, { jobName: "custom-job" });
    expect(warnings).toHaveLength(0);
  });
});
