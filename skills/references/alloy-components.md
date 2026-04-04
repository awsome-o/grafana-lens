# Alloy Component Reference — Escape Hatch Companion

When no recipe fits, compose raw Alloy configs using these component patterns.
Use `alloy_pipeline` with `config` param + optional `sampleQueries` for data verification.

## Table of Contents

- [Log Sources](#log-sources)
- [Log Processing](#log-processing)
- [Metrics Exporters](#metrics-exporters)
- [OTel Processors](#otel-processors)
- [OTel Connectors](#otel-connectors)
- [Profiling](#profiling)
- [Frontend](#frontend)
- [Wiring Patterns](#wiring-patterns)

---

## Log Sources

### loki.source.gelf — GELF UDP Log Source

Receives GELF (Graylog Extended Log Format) logs over UDP. Common with Graylog, Docker GELF driver.

```alloy
loki.source.gelf "my_gelf" {
  forward_to = [loki.write.default.receiver]
}
```

Default: listens on `0.0.0.0:12201` (UDP). Override with `use_incoming_timestamp = true`.
Labels: Auto-extracts `__gelf_message_host`, `__gelf_message_level`, `__gelf_message_facility`.
Use `loki.relabel` to promote `__gelf_*` labels.

**Sample queries**: `{source="gelf"}`, `{source="gelf"} |= "error"`

### loki.source.api — Loki Push API Endpoint

Accepts logs via Loki-compatible HTTP push API. Use for centralized log gateways, TCP JSON ingestion.

```alloy
loki.source.api "push" {
  http {
    listen_address = "0.0.0.0"
    listen_port    = 3500
  }
  forward_to = [loki.process.parse.receiver]
}
```

**Sample queries**: `{source="push-api"}`, `rate({source="push-api"}[5m])`

### loki.source.kafka — Kafka Log Consumer

Consumes log messages from Apache Kafka topics.

```alloy
loki.source.kafka "logs" {
  brokers       = ["kafka:9092"]
  topics        = ["app-logs"]
  consumer_group = "alloy"
  forward_to    = [loki.process.parse.receiver]
}
```

Authentication: Add `authentication { type = "sasl" ... }` block for SASL/SCRAM.
**Sample queries**: `{source="kafka"}`, `{source="kafka", topic="app-logs"}`

### loki.source.windowsevent — Windows Event Logs

Collects Windows Event Log entries. Windows-only.

```alloy
loki.source.windowsevent "events" {
  eventlog_name = "Application"
  forward_to    = [loki.process.parse.receiver]
}
```

Common event logs: `"Application"`, `"System"`, `"Security"`.
**Sample queries**: `{source="windowsevent"}`, `{source="windowsevent"} |= "error"`

---

## Log Processing

Insert `loki.process` between source and `loki.write` for parsing, enrichment, and routing.

### stage.json — JSON Field Extraction

```alloy
loki.process "parse" {
  stage.json {
    expressions = {
      "timestamp"  = "",
      "level"      = "",
      "message"    = "",
      "request_id" = "context.request_id",
    }
  }
  forward_to = [loki.write.default.receiver]
}
```

Empty string `""` extracts the top-level key matching the name. Dotted paths extract nested fields.

### stage.labels — Promote Fields to Labels

```alloy
  stage.labels {
    values = {
      "level" = "",
      "service" = "",
    }
  }
```

Promotes extracted fields to Loki index labels. Use sparingly — high-cardinality labels hurt performance.

### stage.structured_metadata — High-Cardinality Fields

```alloy
  stage.structured_metadata {
    values = {
      "request_id" = "",
      "user_id"    = "",
    }
  }
```

For high-cardinality data. Queryable via `| request_id="abc"` but not indexed as labels.

### stage.timestamp — Parse Log Timestamps

```alloy
  stage.timestamp {
    source = "timestamp"
    format = "RFC3339"
  }
```

Formats: `"RFC3339"`, `"RFC3339Nano"`, `"Unix"`, `"UnixMs"`, or Go time layout strings.

### stage.static_labels — Add Fixed Labels

```alloy
  stage.static_labels {
    values = {
      "environment" = "production",
      "service_name" = "my-app",
    }
  }
```

### stage.output — Set Log Line Content

```alloy
  stage.output {
    source = "message"
  }
```

Replaces the log line with the extracted `message` field.

### stage.regex — Regex Extraction

```alloy
  stage.regex {
    expression = "^(?P<timestamp>\\S+) (?P<level>\\w+) (?P<message>.*)$"
  }
```

Named capture groups become available for subsequent stages.

### stage.match — Conditional Processing

```alloy
  stage.match {
    selector = '{app="frontend"}'
    stage.json { expressions = { "url" = "" } }
    stage.labels { values = { "url" = "" } }
  }
```

Apply stages only to logs matching the LogQL selector.

### stage.tenant — Multi-Tenant Routing

```alloy
  stage.tenant {
    source = "tenant_id"
  }
```

Routes logs to different Loki tenants based on extracted field.

### loki.secretfilter — Secret Redaction

```alloy
loki.secretfilter "redact" {
  forward_to = [loki.write.default.receiver]
}
```

Uses built-in Gitleaks patterns to redact secrets. Optional: `redact_with = "<REDACTED:$SECRET_NAME>"`, `types = "all"`.

### Full Processing Pipeline Example

```alloy
loki.source.api "push" {
  http { listen_port = 3500 }
  forward_to = [loki.process.parse.receiver]
}

loki.process "parse" {
  stage.json {
    expressions = { "timestamp" = "", "level" = "", "message" = "", "user_id" = "" }
  }
  stage.timestamp {
    source = "timestamp"
    format = "RFC3339"
  }
  stage.labels {
    values = { "level" = "" }
  }
  stage.structured_metadata {
    values = { "user_id" = "" }
  }
  stage.output {
    source = "message"
  }
  forward_to = [loki.write.default.receiver]
}

loki.write "default" {
  endpoint {
    url = "http://loki:3100/loki/api/v1/push"
  }
}
```

---

## Metrics Exporters

All follow: `prometheus.exporter.X → prometheus.scrape → prometheus.remote_write`.

### prometheus.exporter.blackbox — Synthetic HTTP Probing

```alloy
prometheus.exporter.blackbox "probes" {
  config = "{ modules: { http_2xx: { prober: http, timeout: 5s } } }"

  target {
    name    = "web"
    address = "http://myapp:8080"
    module  = "http_2xx"
  }
}

prometheus.scrape "blackbox" {
  targets    = prometheus.exporter.blackbox.probes.targets
  forward_to = [prometheus.remote_write.default.receiver]
}
```

Modules: `http_2xx` (HTTP), `tcp_connect` (TCP), `icmp` (ICMP/ping).
**Sample queries**: `probe_success{instance="..."}`, `probe_http_duration_seconds`, `probe_http_status_code`

### prometheus.exporter.memcached — Memcached Metrics

```alloy
prometheus.exporter.memcached "cache" {
  address = "memcached:11211"
}

prometheus.scrape "memcached" {
  targets    = prometheus.exporter.memcached.cache.targets
  forward_to = [prometheus.remote_write.default.receiver]
}
```

**Sample queries**: `memcached_up`, `memcached_current_bytes`, `memcached_current_connections`

### prometheus.exporter.snmp — SNMP Device Monitoring

```alloy
prometheus.exporter.snmp "devices" {
  config_file = "/etc/alloy/snmp.yml"

  target "switch" {
    address = "192.168.1.1"
    module  = "if_mib"
  }
}
```

Requires external `snmp.yml` config file (MIB definitions).
**Sample queries**: `ifOperStatus`, `ifInOctets`, `ifOutOctets`

### prometheus.exporter.windows — Windows System Metrics

```alloy
prometheus.exporter.windows "system" {
  enabled_collectors = ["cpu", "cs", "logical_disk", "net", "os", "system"]
}
```

Windows-only. Collectors: `cpu`, `cs`, `logical_disk`, `memory`, `net`, `os`, `process`, `system`.
**Sample queries**: `windows_cpu_time_total`, `windows_logical_disk_free_bytes`

### prometheus.exporter.self — Alloy Self-Monitoring

```alloy
prometheus.exporter.self "alloy" {}

prometheus.scrape "self" {
  targets    = prometheus.exporter.self.alloy.targets
  forward_to = [prometheus.remote_write.default.receiver]
}
```

**Sample queries**: `alloy_build_info`, `rate(alloy_component_evaluation_slow_seconds_count[5m])`, `alloy_component_controller_running_components`

---

## OTel Processors

### otelcol.processor.tail_sampling — Trace Sampling Policies

```alloy
otelcol.processor.tail_sampling "smart" {
  decision_wait = "10s"
  num_traces    = 100

  // Always keep error traces
  policy {
    name = "errors"
    type = "status_code"
    status_code { status_codes = ["ERROR"] }
  }

  // Keep slow traces (>5s)
  policy {
    name = "latency"
    type = "latency"
    latency { threshold_ms = 5000 }
  }

  // Drop health checks
  policy {
    name = "drop-health"
    type = "string_attribute"
    string_attribute {
      key          = "http.url"
      values       = ["/health", "/metrics", "/ready"]
      invert_match = true
    }
  }

  // Sample 10% of remaining
  policy {
    name = "probabilistic"
    type = "probabilistic"
    probabilistic { sampling_percentage = 10 }
  }

  output {
    traces = [otelcol.processor.batch.default.input]
  }
}
```

Policy types: `status_code`, `latency`, `probabilistic`, `string_attribute`, `numeric_attribute`, `always_sample`, `rate_limiting`.

### otelcol.processor.transform — Attribute Transformation

```alloy
otelcol.processor.transform "enrich" {
  metric_statements {
    context    = "datapoint"
    statements = [
      "set(attributes[\"environment\"], \"production\")",
    ]
  }
  output {
    metrics = [otelcol.exporter.otlphttp.default.input]
  }
}
```

Uses OTTL (OpenTelemetry Transformation Language). Contexts: `resource`, `scope`, `span`, `spanevent`, `metric`, `datapoint`, `log`.

### otelcol.processor.resourcedetection — Auto-Detect Host Metadata

```alloy
otelcol.processor.resourcedetection "env" {
  detectors = ["env", "system"]
  system {
    hostname_sources = ["os"]
  }
  output {
    traces = [otelcol.processor.batch.default.input]
  }
}
```

Detectors: `env`, `system`, `docker`, `gcp`, `aws`, `azure`.

---

## OTel Connectors

Connectors consume one signal type and produce another.

### otelcol.connector.spanmetrics — RED Metrics from Traces

```alloy
otelcol.connector.spanmetrics "red" {
  histogram {
    explicit {}
  }
  dimension { name = "http.method" }
  dimension { name = "http.status_code" }
  metrics_flush_interval = "5s"

  output {
    metrics = [otelcol.exporter.otlphttp.prometheus.input]
  }
}
```

Produces: `traces_spanmetrics_calls_total`, `traces_spanmetrics_duration_milliseconds_bucket`.
Wire: `batch.output.traces = [spanmetrics.input, exporter.input]` (dual output).

### otelcol.connector.servicegraph — Service Dependency Graphs

```alloy
otelcol.connector.servicegraph "graph" {
  metrics_flush_interval = "10s"
  dimensions             = ["service.name", "http.method"]
  store {
    max_items = 5000
    ttl       = "30s"
  }
  output {
    metrics = [otelcol.exporter.otlphttp.prometheus.input]
  }
}
```

Produces: `traces_service_graph_request_total`, `traces_service_graph_request_server_seconds_bucket`.
Same dual-output wiring as spanmetrics.

### otelcol.connector.count — Count Signals

```alloy
otelcol.connector.count "req" {
  spans {
    "request.count" { description = "Total request count" }
  }
  output {
    metrics = [otelcol.exporter.otlphttp.prometheus.input]
  }
}
```

Derives count metrics from traces, logs, or spans.

---

## Profiling

### pyroscope.scrape + pyroscope.write — Continuous Profiling

```alloy
pyroscope.scrape "profiles" {
  targets = [
    { "__address__" = "myapp:6060", "service_name" = "myapp" },
  ]
  profiling_config {
    profile.process_cpu { enabled = true }
    profile.memory      { enabled = true }
    profile.goroutine   { enabled = true }
  }
  forward_to = [pyroscope.write.default.receiver]
}

pyroscope.write "default" {
  endpoint {
    url = "http://pyroscope:4040"
  }
}
```

Profiles: `process_cpu`, `memory`, `goroutine`, `mutex`, `block`. Go apps expose at `:6060/debug/pprof`.

---

## Frontend

### faro.receiver — Browser RUM/Web Vitals

```alloy
faro.receiver "frontend" {
  server {
    listen_address = "0.0.0.0"
    listen_port    = 12347
    cors_allowed_origins = ["*"]
  }
  output {
    logs = [loki.write.default.receiver]
  }
}
```

Collects frontend telemetry via Grafana Faro SDK. Signals: logs, traces, measurements (web vitals).

---

## Wiring Patterns

### Source → Write (simplest)
```
loki.source.X → loki.write
prometheus.exporter.X → prometheus.scrape → prometheus.remote_write
```

### Source → Process → Write (log enrichment)
```
loki.source.X → loki.process → loki.write
```

### Source → Multiple Destinations (fan-out)
```
otelcol.receiver.otlp → otelcol.processor.batch → [
  otelcol.connector.spanmetrics (→ metrics export),
  otelcol.exporter.otlp (→ traces export)
]
```

### Discovery → Relabel → Scrape → Write (dynamic targets)
```
discovery.docker → discovery.relabel → loki.source.docker → loki.write
```

### Common `prometheus.remote_write` + `loki.write` blocks

Always end metrics pipelines with:
```alloy
prometheus.remote_write "default" {
  endpoint {
    url = "PROMETHEUS_REMOTE_WRITE_URL"
  }
}
```

Always end log pipelines with:
```alloy
loki.write "default" {
  endpoint {
    url = "LOKI_WRITE_URL"
  }
}
```

Replace URLs with the values from your LGTM stack config (`alloy.lgtm` settings).
