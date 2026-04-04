# Alloy Pipeline Recipes — Full Catalog

The `alloy_pipeline` tool uses recipes to create data collection pipelines. Each recipe generates a complete, self-contained Alloy config file.

## Table of Contents

- [Recipe Catalog](#recipe-catalog)
- [Recipe Details](#recipe-details)
- [Log Processing Params](#log-processing-params)
- [Credential Handling](#credential-handling)
- [Troubleshooting](#troubleshooting)
- [Export Targets](#export-targets)

## Recipe Catalog

### Metrics Recipes (11)

| Recipe | Required Params | Credential Params | Dashboard Template |
|--------|----------------|-------------------|-------------------|
| `scrape-endpoint` | `url` (HTTP endpoint) | basicAuth, bearerToken | metric-explorer |
| `node-exporter` | (none) | (none) | metric-explorer |
| `postgres-exporter` | `connectionString` | connectionString | metric-explorer |
| `mysql-exporter` | `connectionString` | connectionString | metric-explorer |
| `redis-exporter` | `redisUrl` | password | metric-explorer |
| `mongodb-exporter` | `mongodbUri` | mongodbUri | metric-explorer |
| `kubernetes-pods` | (none) | (none) | multi-kpi |
| `kubernetes-services` | (none) | (none) | multi-kpi |
| `blackbox-exporter` | `targets` (array) | (none) | metric-explorer |
| `memcached-exporter` | `memcachedAddress` | (none) | metric-explorer |
| `self-monitoring` | (none) | (none) | metric-explorer |

### Log Recipes (10)

All log recipes support optional [processing params](#log-processing-params) for JSON parsing, label promotion, structured metadata, multi-tenant routing, and more.

| Recipe | Required Params | Source | Dashboard Template |
|--------|----------------|--------|-------------------|
| `docker-logs` | (none) | Docker socket (opt: containerNames, excludeContainers) | (none — use grafana_query_logs) |
| `file-logs` | `paths` (glob array) | Local files | (none) |
| `syslog` | (none) | TCP/UDP listener (opt: protocol, listenAddress) | (none) |
| `kubernetes-logs` | (none) | K8s API | (none) |
| `journal-logs` | (none) | systemd journal | (none) |
| `loki-push-api` | (none) | HTTP push API (opt: listenPort, listenAddress) | (none) |
| `kafka-logs` | `brokers`, `topics` | Apache Kafka (opt: consumerGroup) | (none) |
| `secret-filter-logs` | `paths` (glob array) | Local files + secret redaction | (none) |
| `faro-frontend` | (none) | Grafana Faro Web SDK (opt: listenPort, corsAllowedOrigins) | (none) |
| `gelf-logs` | (none) | GELF over UDP (opt: listenAddress, relabelHost/Level/Facility) | (none) |

### Trace Recipes (4)

| Recipe | Required Params | What It Does | Dashboard Template |
|--------|----------------|-------------|-------------------|
| `otlp-receiver` | (none) | Receive OTLP traces/metrics/logs | (none — use grafana_query_traces) |
| `application-traces` | (none) | Traces + enrichment + sampling (simple or multi-policy) | (none) |
| `span-metrics` | (none) | RED metrics from traces via spanmetrics connector | metric-explorer |
| `service-graph` | (none) | Service dependency graph metrics from traces | metric-explorer |

### Infrastructure Recipes (3)

| Recipe | Required Params | What It Monitors | Dashboard Template |
|--------|----------------|-----------------|-------------------|
| `docker-metrics` | (none) | Container CPU/memory/network | metric-explorer |
| `elasticsearch-exporter` | `elasticsearchUrl` | ES cluster health, indices, shards | metric-explorer |
| `kafka-exporter` | `kafkaBrokers` (array) | Brokers, topics, consumer lag | metric-explorer |

### Profiling Recipes (1)

| Recipe | Required Params | What It Does | Dashboard Template |
|--------|----------------|-------------|-------------------|
| `continuous-profiling` | `targets` (array of {address, serviceName}) | Pyroscope continuous profiling (CPU, memory, goroutine, mutex, block) | (none) |

## Recipe Details

### scrape-endpoint

Scrapes any HTTP endpoint exposing Prometheus metrics.

**Required**: `url` — full URL (e.g., `http://myapp:8080/metrics`)
**Optional**: `scrapeInterval` (default: 15s), `metricsPath` (default: /metrics), `jobName`, `basicAuth`, `bearerToken`, `tlsInsecure`

**Sample queries**: `up{job="..."}`, `scrape_samples_scraped{job="..."}`

### postgres-exporter

PostgreSQL metrics via Alloy's built-in exporter.

**Required**: `connectionString` — Postgres URI (e.g., `postgres://user:pass@host:5432/db`)
**Optional**: `scrapeInterval`

**Sample queries**: `pg_up{job="..."}`, `pg_stat_activity_count{job="..."}`, `rate(pg_stat_database_deadlocks{job="..."}[5m])`

### node-exporter

System metrics (CPU, memory, disk, network) via Alloy's built-in Unix exporter. No external binary needed.

**No required params.**
**Optional**: `scrapeInterval`

**Sample queries**:
- CPU: `100 - (avg by(instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)`
- Memory: `(1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes) * 100`
- Disk: `(1 - node_filesystem_avail_bytes{mountpoint="/"} / node_filesystem_size_bytes{mountpoint="/"}) * 100`

### docker-logs

Collects logs from Docker containers via the Docker socket. Supports container name filtering.

**No required params.**
**Optional**: `containerNames` (string[] — keep only these containers), `excludeContainers` (string[] — drop these containers). When either is specified, a `discovery.relabel` block filters by `__meta_docker_container_name`.
**Labels**: `source="docker"` added to all log entries.

**Sample LogQL**: `{source="docker"}`, `{source="docker"} |= "error"`, `rate({source="docker"}[5m])`

### syslog

Receives syslog messages via TCP or UDP.

**No required params.**
**Optional**: `listenAddress` (default: `0.0.0.0:1514`), `protocol` (default: `tcp` — set to `udp` for UDP syslog).
**Labels**: `source="syslog"`.

**Sample LogQL**: `{source="syslog"}`, `{source="syslog"} |= "error"`

### otlp-receiver

Receives OTLP data (metrics, logs, traces) via gRPC and HTTP. Routes all signals through batching to the LGTM stack.

**No required params.**
**Optional**: `grpcPort` (default: 4317), `httpPort` (default: 4318)
**Note**: Binds to `0.0.0.0:{port}` — cannot coexist with `application-traces` on the same default ports.

**Sample TraceQL**: `{ resource.service.name =~ ".+" }`

### application-traces

Receives traces with service name enrichment, batching, and sampling. Two sampling modes:

**Simple mode**: `sampleRate` (0.0–1.0, default: 1.0). Probabilistic sampling — "keep X% of all traces."
**Advanced mode**: `samplingPolicies` — multi-policy tail sampling for production cost control. Keep errors, keep slow traces, filter health checks, rate-limit the rest. Takes precedence over `sampleRate`.

**No required params.**
**Optional**: `environment` (default: `production`), `sampleRate`, `samplingPolicies` (array), `decisionWait` (default: `10s`), `numTraces` (default: `100`).
**Note**: Uses same default ports as `otlp-receiver` (4317/4318) — cannot coexist with it on defaults.

**samplingPolicies** — Array of policy objects. Policies are OR-ed: trace is kept if ANY policy matches.
Policy types:
- `status_code` — `{ name, type: "status_code", statusCodes: ["ERROR"] }`
- `latency` — `{ name, type: "latency", thresholdMs: 5000 }`
- `probabilistic` — `{ name, type: "probabilistic", samplingPercentage: 10 }`
- `string_attribute` — `{ name, type: "string_attribute", key: "http.url", values: ["/health"], invertMatch: true }`
- `numeric_attribute` — `{ name, type: "numeric_attribute", key: "score", minValue: 70, maxValue: 100 }`

**Example** — Keep all errors + slow traces, drop health checks, sample 10% of the rest:
```json
{
  "recipe": "application-traces",
  "params": {
    "environment": "production",
    "samplingPolicies": [
      { "name": "keep-errors", "type": "status_code", "statusCodes": ["ERROR"] },
      { "name": "keep-slow", "type": "latency", "thresholdMs": 5000 },
      { "name": "drop-health", "type": "string_attribute", "key": "http.url", "values": ["/health", "/ready"], "invertMatch": true },
      { "name": "sample-rest", "type": "probabilistic", "samplingPercentage": 10 }
    ]
  }
}
```

**Sample TraceQL**: `{ resource.deployment.environment = "production" }`, `{ status = error }`, `{ duration > 5s }`

### blackbox-exporter

Synthetic HTTP/TCP/ICMP probing for endpoint availability.

**Required**: `targets` — array of `[{ name, address, module? }]` (e.g., `[{ "name": "web", "address": "http://myapp:8080" }]`)
**Optional**: `modules` (inline YAML blackbox config, default: `http_2xx`), `scrapeInterval`

**Sample queries**: `probe_success{job="..."}`, `probe_http_duration_seconds{job="..."}`, `probe_http_status_code{job="..."}`

### memcached-exporter

Memcached metrics — connections, memory, items, evictions.

**Required**: `memcachedAddress` (e.g., `memcached:11211`)
**Optional**: `scrapeInterval`

**Sample queries**: `memcached_up{job="..."}`, `memcached_current_bytes{job="..."}`, `memcached_current_connections{job="..."}`

### self-monitoring

Monitor Alloy itself — component health, evaluation latency, resource usage.

**No required params.**
**Optional**: `scrapeInterval`

**Sample queries**: `alloy_build_info{job="..."}`, `rate(alloy_component_evaluation_slow_seconds_count{job="..."}[5m])`, `alloy_component_controller_running_components{job="..."}`

### loki-push-api

Accept logs via Loki-compatible HTTP push API. Covers centralized log gateways and TCP JSON ingestion.

**No required params.**
**Optional**: `listenPort` (default: 3500), `listenAddress`, + [processing params](#log-processing-params)

**Sample LogQL**: `{source="push-api"}`, `rate({source="push-api"}[5m])`

### kafka-logs

Consume log messages from Apache Kafka topics.

**Required**: `brokers` (string array), `topics` (string array)
**Optional**: `consumerGroup` (default: `alloy`), `kafkaAuth` (SASL credentials), + [processing params](#log-processing-params)

**Sample LogQL**: `{source="kafka"}`, `{source="kafka"} |= "error"`

### secret-filter-logs

Tail log files with automatic secret redaction using built-in Gitleaks patterns.

**Required**: `paths` (glob array)
**Optional**: `redactWith` (default: `<REDACTED:$SECRET_NAME>`)

**Sample LogQL**: `{source="file"} |= "REDACTED"`

### span-metrics

Generate RED (Request, Error, Duration) metrics from traces via the spanmetrics connector. Dual-output: traces → Tempo, metrics → Prometheus.

**No required params.**
**Optional**: `dimensions` (default: `["http.method", "http.status_code"]`), `metricsFlushInterval` (default: `5s`), `grpcPort`, `httpPort`

**Sample PromQL**: `sum(rate(traces_spanmetrics_calls_total[5m]))`, `histogram_quantile(0.95, sum(rate(traces_spanmetrics_duration_milliseconds_bucket[5m])) by (le))`
**Sample TraceQL**: `{ resource.service.name =~ ".+" }`

### service-graph

Generate service dependency graph metrics from traces via the servicegraph connector. Same dual-output as span-metrics.

**No required params.**
**Optional**: `dimensions` (default: `["service.name", "http.method"]`), `storeMaxItems` (default: 5000), `storeTtl` (default: `30s`), `metricsFlushInterval`, `grpcPort`, `httpPort`

**Sample PromQL**: `traces_service_graph_request_total`, `histogram_quantile(0.95, sum(rate(traces_service_graph_request_server_seconds_bucket[5m])) by (le))`

### faro-frontend

Receive frontend telemetry from the Grafana Faro Web SDK — browser errors, performance, web vitals, sessions.

**No required params.**
**Optional**: `listenPort` (default: 12347), `listenAddress` (default: `0.0.0.0`), `corsAllowedOrigins` (default: `["*"]`)

**Sample LogQL**: `{service_name="faro-web-sdk"}`, `{service_name="faro-web-sdk"} |= "error"`

### gelf-logs

Receive GELF (Graylog Extended Log Format) logs over UDP with automatic metadata relabeling.

**No required params.**
**Optional**: `listenAddress` (default: `0.0.0.0:12201`), `relabelHost` (default: true), `relabelLevel` (default: true), `relabelFacility` (default: true)

**Sample LogQL**: `{source="gelf"}`, `{host=~".+"}`, `{level=~"3|4"}`

### continuous-profiling

Continuous profiling via Pyroscope — scrape pprof profiles from Go applications.

**Required**: `targets` — array of `[{ address, serviceName }]` (e.g., `[{ "address": "myapp:6060", "serviceName": "my-app" }]`)
**Optional**: `scrapeInterval` (default: `15s`), `profileTypes` (default: `["cpu", "memory", "goroutine", "mutex", "block"]`), `pyroscopeUrl`

**Sample Pyroscope queries**: `process_cpu:cpu:nanoseconds:cpu:nanoseconds{service_name="my-app"}`, `memory:alloc_objects:count:space:bytes{service_name="my-app"}`

## Log Processing Params

All log recipes (docker-logs, file-logs, syslog, kubernetes-logs, journal-logs, loki-push-api, kafka-logs, secret-filter-logs) accept these optional processing params. When any are provided, a `loki.process` block is automatically inserted between the source and `loki.write`.

| Param | Type | What It Does |
|-------|------|-------------|
| `jsonExpressions` | object | `stage.json` — Extract fields from JSON. Keys=output names, values=JSON paths ("" = top-level key) |
| `regexExpression` | string | `stage.regex` — Extract fields via regex with named capture groups |
| `timestampSource` | string | `stage.timestamp` — Parse timestamp from this field (use with `timestampFormat`) |
| `timestampFormat` | string | Timestamp format: `RFC3339`, `RFC3339Nano`, `Unix`, `UnixMs`, Go layout |
| `labelFields` | object | `stage.labels` — Promote fields to Loki index labels (low-cardinality only) |
| `structuredMetadata` | object | `stage.structured_metadata` — Store high-cardinality fields as metadata |
| `staticLabels` | object | `stage.static_labels` — Add fixed labels to all entries |
| `tenantValue` | string | `stage.tenant` — Static Loki tenant ID (X-Scope-OrgID). Routes all logs to this tenant |
| `tenantSource` | string | `stage.tenant` — Dynamic tenant from extracted field (e.g., `"org_id"`) |
| `matchRoutes` | object[] | `stage.match` — Conditional multi-tenant routing by label selector |
| `outputSource` | string | `stage.output` — Replace log line with extracted field value |

**Example**: Parse JSON logs, extract timestamp, promote `level` to label, store `request_id` as metadata:
```json
{
  "recipe": "file-logs",
  "params": {
    "paths": ["/var/log/app/*.log"],
    "jsonExpressions": { "timestamp": "", "level": "", "message": "", "request_id": "ctx.rid" },
    "timestampSource": "timestamp",
    "timestampFormat": "RFC3339",
    "labelFields": { "level": "" },
    "structuredMetadata": { "request_id": "" },
    "outputSource": "message"
  }
}
```

**Example**: Multi-tenant routing — route logs to different Loki tenants by environment:
```json
{
  "recipe": "loki-push-api",
  "params": {
    "jsonExpressions": { "env": "" },
    "labelFields": { "env": "" },
    "matchRoutes": [
      { "selector": "{env=\"prod\"}", "tenantValue": "prod-tenant" },
      { "selector": "{env=\"staging\"}", "tenantValue": "staging-tenant" }
    ]
  }
}
```

## Credential Handling

Recipes with `credentialParams` generate Alloy config using `sys.env()` references. Secrets are never written to config files.

**Env var convention**: `ALLOY_{RECIPE}_{PIPELINE_NAME}_{PARAM}` (all uppercase, hyphens → underscores)

Example: `postgres-exporter` pipeline named `analytics-db` → env var `ALLOY_POSTGRES_EXPORTER_ANALYTICS_DB_CONNECTIONSTRING`

### Two-Phase Credential Lifecycle

Credential recipes use a two-phase creation flow:

1. **Create**: Config is written to disk. Alloy attempts to reload.
2. **If env vars aren't set**: Alloy reload fails, but the config file stays. Pipeline enters `pending_credentials` status. The response includes `envVarsRequired` with exact env var names.
   > **Blast radius**: Alloy reload is atomic — a single failed config blocks reload for ALL managed pipelines, not just the new one. Existing healthy pipelines continue running on their last good config, but any subsequent create/update/delete operations will fail until the env vars are set or the broken pipeline is deleted.
3. **User sets env vars** where Alloy runs (shell env, systemd unit, Docker env, K8s secret).
4. **Verify**: Use action `status` — the pipeline auto-promotes to `active` once Alloy components are healthy.

If the env vars are already set when the pipeline is created, the reload succeeds immediately and the pipeline starts in `active` status.

## Troubleshooting

### "pending_credentials" status
- The pipeline config is on disk but Alloy can't connect — env vars aren't set yet
- Check `envVarsRequired` from the create response for exact var names
- Set the env vars where Alloy runs, then verify with action `status`
- Pipeline will auto-promote to `active` once components pass health check

### "Alloy not reachable"
- Check Alloy is running: `curl http://localhost:12345/-/ready`
- Check URL in plugin config: `alloy.url`
- Check env var: `ALLOY_URL`

### "Config rejected by Alloy"
- The pipeline was automatically rolled back (previous config restored)
- Check the `alloyError` field in the response for Alloy's error message
- Common: unknown component type, invalid attribute name, syntax error

### "Pipeline status: degraded"
- One or more Alloy components are unhealthy
- Check `remediation` field in status response
- Common: target unreachable (wrong host/port), auth failure, DNS resolution

### "Pipeline status: drift"
- The config file was modified or deleted externally
- Run `alloy_pipeline` action `diagnose` for details
- Fix: delete and recreate the pipeline

### "No data in Grafana"
- Check pipeline status first (action `status`)
- Check env vars are set (for credential recipes)
- Check Alloy has access to the data source (network, permissions)
- Check LGTM stack is running (Mimir for metrics, Loki for logs, Tempo for traces)

## Export Targets

Recipes need to know where to send data. This is auto-resolved:

- **Prometheus remote_write**: from `alloy.lgtm.prometheusRemoteWriteUrl` or default `http://localhost:9009/api/prom/push`
- **Loki write**: from `alloy.lgtm.lokiUrl` or default `http://localhost:3100/loki/api/v1/push`
- **OTLP**: from `alloy.lgtm.otlpEndpoint` or derived from `otlp.endpoint` config

Override these in plugin config when using non-default LGTM endpoints:
```json
{
  "alloy": {
    "enabled": true,
    "configDir": "/etc/alloy/config.d",
    "lgtm": {
      "prometheusRemoteWriteUrl": "http://mimir:9009/api/prom/push",
      "lokiUrl": "http://loki:3100/loki/api/v1/push"
    }
  }
}
```
