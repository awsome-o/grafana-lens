---
name: e2e-test
description: >
  End-to-end integration tests for Grafana Lens agent tools against a live LGTM stack.
  Detects local code changes and runs targeted tests for affected tools.
  Use when: "e2e test", "end to end test", "test against LGTM", "test grafana tools",
  "integration test", "run e2e", "test my changes"
---

# Grafana Lens E2E Tests

Integration tests for all 18 Grafana Lens tools against a live LGTM stack + Grafana + Alloy.
Tests run via `openclaw agent` in gateway mode. Each test group is self-contained.

**Default behavior**: detect local uncommitted changes → identify affected tools → test only those.
**Override**: user can request specific groups or "run all e2e tests".

---

## Phase 1: Detect What to Test

Run `git diff --name-only` and `git diff --cached --name-only` in the grafana-lens workspace to find changed files. Map them to test groups:

```
Changed File                          → Test Group(s)
──────────────────────────────────────────────────────
src/config.ts                         → ALL (critical shared dep, all 14 tools)
src/grafana-client.ts                 → Discovery + Query + Traces + Dashboard + Alerting
index.ts                              → ALL (wiring changes)
src/services/custom-metrics-store.ts  → Metrics Push
src/services/otel-metrics.ts          → Metrics Push
src/services/otlp-json-writer.ts      → Metrics Push
src/services/metrics-collector.ts     → Metrics Push + Telemetry
src/services/lifecycle-telemetry.ts   → Telemetry
src/services/otel-traces.ts           → Telemetry
src/services/otel-logs.ts             → Telemetry
src/services/alert-webhook.ts         → Alerting
src/tools/push-metrics.ts             → Metrics Push
src/tools/query.ts                    → Query
src/tools/query-logs.ts               → Query
src/tools/explain-metric.ts           → Query
src/tools/list-metrics.ts             → Discovery
src/tools/explore-datasources.ts      → Discovery
src/tools/search.ts                   → Discovery
src/tools/create-dashboard.ts         → Dashboard
src/tools/get-dashboard.ts            → Dashboard
src/tools/update-dashboard.ts         → Dashboard
src/tools/share-dashboard.ts          → Dashboard
src/tools/create-alert.ts             → Alerting
src/tools/check-alerts.ts             → Alerting
src/tools/annotate.ts                 → Alerting
src/tools/query-traces.ts             → Traces
src/tools/query-guidance.ts           → Query + Traces
src/tools/resolve-panel.ts            → Query + Traces
src/templates/*                       → Dashboard
src/tools/alloy-pipeline.ts           → Alloy Pipelines
src/services/alloy-service.ts         → Alloy Pipelines
src/alloy/*                           → Alloy Pipelines
src/alloy/alloy-client.ts             → Alloy Pipelines
src/alloy/pipeline-store.ts           → Alloy Pipelines
src/alloy/config-builder.ts           → Alloy Pipelines
src/alloy/types.ts                    → Alloy Pipelines
src/alloy/recipes/*                   → Alloy Pipelines
```

**User overrides** (skip change detection):
- "run all e2e tests" → all 6 groups in order
- "run discovery tests" → only Discovery
- "run metrics-push and query tests" → those 2 groups
- "test push-metrics" → Metrics Push group
- "test traces" → Traces group

If no local changes detected and no override given, ask the user which groups to run.

---

## Phase 2: Infrastructure Check

Verify before running any tests:

### 2.1 LGTM Stack
```bash
curl -sf http://localhost:3000/api/health
```
If fails, start it:
```bash
cd ~/workspace/docker-otel-lgtm && bash run-lgtm.sh
```

### 2.2 Alloy (for Alloy Pipelines group)
```bash
curl -sf http://localhost:12345/-/ready
```
If fails, start the alloy-scenarios test stack:
```bash
cd ~/workspace/alloy-scenarios/grafana-lens-test && docker compose --env-file ../image-versions.env up -d
```
Alloy must be running with directory-mode config (`/etc/alloy/`) and `config.d/` bind-mounted from the host.

### 2.3 OTLP Endpoint
```bash
curl -sf -o /dev/null -w "%{http_code}" http://localhost:4318/v1/metrics
```
Expected: 200 or 405 (endpoint exists). If connection refused, LGTM stack is not running.

### 2.3 Grafana Service Account Token
Read from config:
```bash
cat ~/.openclaw/openclaw.json | jq -r '.plugins.entries["openclaw-grafana-lens"].config.grafana.apiKey'
```
Or check env: `echo $GRAFANA_SERVICE_ACCOUNT_TOKEN`

If neither exists:
1. Open http://localhost:3000 (admin/admin)
2. Administration > Service Accounts > Create > Add token (Editor role)
3. Update `~/.openclaw/openclaw.json` with the token

### 2.4 Gateway Restart & Verification

Pick up latest grafana-lens code changes:
```bash
openclaw gateway restart
```
Wait 3-5 seconds for the gateway to fully restart.

**Important**: `openclaw health` may report "pairing required" even when the gateway is functional. This error is misleading for local development — the plugin still loads and `openclaw agent` commands work correctly. Do NOT block on this error. Instead, verify the plugin loaded by checking the gateway log output during restart. Look for:
```
grafana-lens: registered 14 tools and services
grafana-lens: Grafana connection verified
```
If you see these lines, proceed directly to running tests with `openclaw agent`.

---

## Phase 3: Run Test Groups

### Two Test Channels

There are two ways to send messages to the agent, and they exercise **different code paths**:

| Channel | Code path | model.usage events | Full trace hierarchy | When to use |
|---------|-----------|-------------------|---------------------|-------------|
| `openclaw agent` CLI | Embedded runner (pi-embedded-runner) | **No** — bypasses `agent-runner.ts` | **No** — missing `invoke_agent` root span | Tool-level tests (Discovery, Query, Dashboard, etc.) |
| Gateway Web UI (Chrome) | Auto-reply pipeline (`agent-runner.ts`) | **Yes** — fires after each run | **Yes** — full span hierarchy | Telemetry tests (traces, fallback, model.usage, lifecycle logs) |

The gateway web UI at `http://127.0.0.1:18789/chat` is the **true gateway-mode channel**. It goes through the same auto-reply pipeline as production messaging channels (Telegram, WhatsApp, etc.). Use it when testing features that depend on gateway-mode signals.

### CLI Execution Pattern

For tool-level tests:
1. Run `openclaw agent --session-id <session-id> -m "<prompt>"`
2. Check the agent output for the expected tool call and response shape
3. Optionally run `curl` verification against Grafana/Mimir API
4. Record: PASS / FAIL / SKIP

### Gateway Web UI Execution Pattern (Chrome)

For telemetry/trace tests, use Chrome browser automation (requires `mcp__claude-in-chrome__*` tools):
1. Create a new tab: `tabs_create_mcp`
2. Navigate to `http://127.0.0.1:18789/chat`
3. Read the page to find interactive elements: `read_page(filter="interactive")`
4. (Optional) Click "New session" button to start fresh
5. Type message into the textbox: `form_input(ref=<textbox_ref>, value="<message>")`
6. Click Send button: `computer(action="left_click", ref=<send_ref>)`
7. Wait for response: `computer(action="wait", duration=10)`
8. Screenshot to verify: `computer(action="screenshot")`
9. Check Tempo/Loki/Prometheus via `curl` for telemetry verification

**Key refs** (re-read with `read_page` after each navigation — refs change):
- Textbox: placeholder contains "Message (↩ to send"
- Send button: labeled "Send"
- New session button: labeled "New session"

### Session ID Convention
- Discovery: `e2e-discovery`
- Metrics Push: `e2e-metrics-push`
- Query: `e2e-query`
- Traces: `e2e-traces`
- Dashboard: `e2e-dashboard`
- Alerting: `e2e-alerting`

**Important**: Use gateway mode (NOT `--local`).

---

### Group: Discovery

**Tools**: `grafana_explore_datasources`, `grafana_list_metrics`, `grafana_search`
**Preconditions**: Grafana healthy, gateway running
**Session**: `e2e-discovery`

#### D1: Explore Datasources
```bash
openclaw agent --session-id e2e-discovery -m "What datasources are configured in Grafana? List them all."
```
**Expected tool**: `grafana_explore_datasources`
**Pass**: Response includes at least 1 Prometheus-type datasource with `uid`.
**Verify**:
```bash
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/datasources | jq '.[].type'
```

#### D2: List Metrics
```bash
openclaw agent --session-id e2e-discovery -m "What metrics are available in Grafana? Show me metrics with the 'up' prefix."
```
**Expected tool**: `grafana_list_metrics` with prefix or search param
**Pass**: Response includes `metrics` array with at least `up` metric.

#### D3: Search Dashboards
```bash
openclaw agent --session-id e2e-discovery -m "Search for any existing dashboards in Grafana."
```
**Expected tool**: `grafana_search`
**Pass**: Response includes `dashboards` array (may be empty on fresh Grafana).

---

### Group: Metrics Push

**Tools**: `grafana_push_metrics` (register, push, list, delete actions)
**Preconditions**: OTLP endpoint healthy, gateway running
**Session**: `e2e-metrics-push`

#### MP1: Register Metric
```bash
openclaw agent --session-id e2e-metrics-push -m "Register a custom gauge metric called 'e2e_test_gauge' with help 'E2E test metric' and label names ['env', 'version']."
```
**Expected tool**: `grafana_push_metrics` with `action: "register"`
**Pass**: `status: "registered"`, `queryName` contains `openclaw_ext_e2e_test_gauge`.

#### MP2: Push Values
```bash
openclaw agent --session-id e2e-metrics-push -m "Push these metrics: e2e_test_gauge=42 with labels env=test,version=v1 and also e2e_test_counter=1 as a counter type."
```
**Expected tool**: `grafana_push_metrics` with `action: "push"`
**Pass**: `status: "ok"`, `accepted: 2`, `queryNames` with both metrics.
**Verify** (wait ~5s for OTLP flush):
```bash
curl -s --data-urlencode 'query=openclaw_ext_e2e_test_gauge' http://localhost:9090/api/v1/query | jq '.data.result'
```

#### MP3: List Custom Metrics
```bash
openclaw agent --session-id e2e-metrics-push -m "List all custom metrics I've pushed."
```
**Expected tool**: `grafana_push_metrics` with `action: "list"`
**Pass**: `count >= 1`, includes `e2e_test_gauge` definition.

#### MP4: Delete Metric
```bash
openclaw agent --session-id e2e-metrics-push -m "Delete the custom metric called 'e2e_test_counter'."
```
**Expected tool**: `grafana_push_metrics` with `action: "delete"`
**Pass**: `status: "deleted"`.

#### MP5: Push Timestamped (Historical) Data
```bash
openclaw agent --session-id e2e-metrics-push -m "Push historical step count data: 8000 steps on 2025-01-15, 10500 steps on 2025-01-16, 7200 steps on 2025-01-17. Use metric name 'e2e_daily_steps'."
```
**Expected tool**: `grafana_push_metrics` with `action: "push"`, all points have `timestamp` field
**Pass**: `accepted: 3`, response includes `note` about timestamps being >10m old.
**Note**: Old timestamps (>10m) may be dropped by Mimir's `out_of_order_time_window`. The test verifies the tool accepts and routes them correctly, not that they land in Mimir.

#### MP6: Mixed Batch (Real-Time + Timestamped)
```bash
openclaw agent --session-id e2e-metrics-push -m "Push a mixed batch: 'e2e_mixed_gauge' = 42 (real-time, no timestamp), and 'e2e_mixed_gauge' = 99 at timestamp '2025-01-20'."
```
**Expected tool**: `grafana_push_metrics` with both real-time and timestamped paths
**Pass**: `accepted: 2`. Real-time value queryable in Mimir.
**Verify** (real-time value only):
```bash
curl -s --data-urlencode 'query=openclaw_ext_e2e_mixed_gauge' http://localhost:9090/api/v1/query | jq '.data.result'
```

#### MP7: Counter with Timestamp (Rejection)
```bash
openclaw agent --session-id e2e-metrics-push -m "Push a counter metric called 'e2e_counter_ts' with value 5 at timestamp '2025-01-15'. Use type 'counter'."
```
**Expected tool**: `grafana_push_metrics` with `action: "push"`
**Pass**: `rejected: 1`, reason contains "gauge type" (counters with timestamps break rate() calculations).

---

### Group: Query

**Tools**: `grafana_query` (instant + range), `grafana_query_logs`, `grafana_explain_metric`
**Preconditions**: Datasource UIDs known (run Discovery first or let agent discover)
**Session**: `e2e-query`

#### Q1: Instant Query
```bash
openclaw agent --session-id e2e-query -m "What is the current value of the 'up' metric? Use a Prometheus query."
```
**Expected tool**: `grafana_query` with `queryType: "instant"`
**Pass**: Response includes `metrics` array with value for at least one target.

#### Q2: Range Query
```bash
openclaw agent --session-id e2e-query -m "Show me the 'up' metric over the last 1 hour as a range query with 5-minute steps."
```
**Expected tool**: `grafana_query` with `queryType: "range"`, `start`, `end`, `step`
**Pass**: Response includes `series` array with multiple time-value pairs.

#### Q3: Query Logs (conditional)
```bash
openclaw agent --session-id e2e-query -m "Search for any log entries in Grafana from the last hour. Use a Loki query."
```
**Expected tool**: `grafana_query_logs`
**Pass**: Response includes `entries` array (may be empty). **SKIP** if no Loki datasource found.

#### Q4: Explain Metric
```bash
openclaw agent --session-id e2e-query -m "Explain the 'up' metric -- what is its current value, trend, and stats?"
```
**Expected tool**: `grafana_explain_metric`
**Pass**: Response includes `current`, `trend`, and `stats` sections.

---

### Group: Traces

**Tools**: `grafana_query_traces` (search + get)
**Preconditions**: Tempo datasource available (uid discoverable via `grafana_explore_datasources`), gateway running
**Session**: `e2e-traces`

#### TR1: Discover Tempo Datasource
```bash
openclaw agent --session-id e2e-traces -m "What datasources are configured in Grafana? I need to find the Tempo datasource."
```
**Expected tool**: `grafana_explore_datasources`
**Pass**: Response includes a Tempo datasource with `uid`, query tool `grafana_query_traces`, language `TraceQL`.

#### TR2: TraceQL Search
```bash
openclaw agent --session-id e2e-traces -m "Search for any traces in the last hour using the Tempo datasource. Use a broad TraceQL query like '{ status = ok || status = error || status = unset }' to match all traces."
```
**Expected tool**: `grafana_query_traces` with `queryType: "search"`
**Pass**: Response includes `traces` array with `traceId`, `rootServiceName`, `rootTraceName`, `durationMs`, `startTime`. May be empty if no recent traces exist — mark SKIP.

#### TR3: Get Trace by ID
```bash
openclaw agent --session-id e2e-traces -m "Get the full trace details for trace ID <trace-id-from-TR2> from the Tempo datasource. Show me the spans."
```
**Expected tool**: `grafana_query_traces` with `queryType: "get"`
**Pass**: Response includes `spans` array with `traceId` (hex), `spanId` (hex), `operationName`, `serviceName`, `durationMs`, `status`, `kind`, `attributes`. **SKIP** if TR2 returned no traces.
**Note**: Tempo v2 returns protobuf-JSON format (`batches` key, base64 IDs, string kind/status). The tool normalizes this to hex IDs and friendly status/kind strings.

#### TR4: Search with Duration Filter
```bash
openclaw agent --session-id e2e-traces -m "Search for traces with duration over 10 seconds in the last hour from the Tempo datasource. Use minDuration."
```
**Expected tool**: `grafana_query_traces` with `minDuration: "10s"`
**Pass**: Response includes only traces with `durationMs >= 10000` (or empty if none that slow).

#### TR5: TraceQL Attribute Filter
```bash
openclaw agent --session-id e2e-traces -m "Search for traces matching this TraceQL: { span.gen_ai.operation.name = \"execute_tool\" && duration > 50ms } using the Tempo datasource."
```
**Expected tool**: `grafana_query_traces` with TraceQL span attribute filter
**Pass**: Response includes traces matching the filter. **SKIP** if no matching traces.

---

### Group: Dashboard

**Tools**: `grafana_create_dashboard`, `grafana_get_dashboard`, `grafana_update_dashboard`, `grafana_share_dashboard`
**Preconditions**: Grafana healthy, gateway running
**Session**: `e2e-dashboard`

#### DB1: Create Dashboard
```bash
openclaw agent --session-id e2e-dashboard -m "Create a Grafana dashboard using the metric-explorer template with the title 'E2E Test Dashboard'."
```
**Expected tool**: `grafana_create_dashboard` with `template: "metric-explorer"`
**Pass**: Response includes `uid`, `url`, `status: "created"`.
**Capture**: Save returned `uid` for subsequent tests.

#### DB2: Get Dashboard
```bash
openclaw agent --session-id e2e-dashboard -m "Show me the details of the dashboard titled 'E2E Test Dashboard' -- what panels does it have?"
```
**Expected tool**: `grafana_search` then `grafana_get_dashboard`
**Pass**: Response includes `panels` array with at least one panel.

#### DB3: Update — Add Panel
```bash
openclaw agent --session-id e2e-dashboard -m "Add a new timeseries panel titled 'E2E Added Panel' to the 'E2E Test Dashboard' with PromQL query 'up'."
```
**Expected tool**: `grafana_update_dashboard` with `operation: "add_panel"`
**Pass**: `status: "updated"`, `panelCount` increased.

#### DB4: Update — Remove Panel
```bash
openclaw agent --session-id e2e-dashboard -m "Remove the panel titled 'E2E Added Panel' from the 'E2E Test Dashboard'."
```
**Expected tool**: `grafana_update_dashboard` with `operation: "remove_panel"`
**Pass**: `status: "updated"`.

#### DB5: Share Dashboard
```bash
openclaw agent --session-id e2e-dashboard -m "Share the first panel of the 'E2E Test Dashboard' as an image."
```
**Expected tool**: `grafana_share_dashboard`
**Pass**: Response includes `deliveryTier` (any of "image", "snapshot", "link" is acceptable).

#### DB6: Cleanup — Delete Dashboard
```bash
openclaw agent --session-id e2e-dashboard -m "Delete the dashboard titled 'E2E Test Dashboard'. Yes, I confirm the deletion."
```
**Expected tool**: `grafana_update_dashboard` with `operation: "delete"`
**Pass**: `status: "deleted"`.

---

### Group: Alerting

**Tools**: `grafana_check_alerts` (setup + list), `grafana_create_alert`, `grafana_annotate` (create + list)
**Preconditions**: Grafana healthy, datasource UIDs known
**Session**: `e2e-alerting`

#### A1: Setup Webhook
```bash
openclaw agent --session-id e2e-alerting -m "Set up the Grafana alert webhook so the agent can receive alert notifications."
```
**Expected tool**: `grafana_check_alerts` with `action: "setup"`
**Pass**: `status: "created"` or `status: "already_exists"`.

#### A2: List Alerts
```bash
openclaw agent --session-id e2e-alerting -m "Are there any active Grafana alerts right now?"
```
**Expected tool**: `grafana_check_alerts` with `action: "list"`
**Pass**: Response includes `alertCount` (may be 0).

#### A3: Create Alert
```bash
openclaw agent --session-id e2e-alerting -m "Create a Grafana alert called 'E2E Test Alert' that fires when the 'up' metric is less than 1 for 1 minute."
```
**Expected tool**: `grafana_create_alert`
**Pass**: `status: "created"`, `uid`, `url`.
**Verify**:
```bash
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/v1/provisioning/alert-rules | jq '.[].title'
```

#### A4: Create Annotation
```bash
openclaw agent --session-id e2e-alerting -m "Create a Grafana annotation saying 'E2E test annotation' with tags 'e2e' and 'test'."
```
**Expected tool**: `grafana_annotate` with `action: "create"`
**Pass**: `status: "created"`, `id`.

#### A5: List Annotations
```bash
openclaw agent --session-id e2e-alerting -m "List recent annotations with the tag 'e2e'."
```
**Expected tool**: `grafana_annotate` with `action: "list"`
**Pass**: Response includes `annotations` array with at least one entry.

---

### Group: Alloy Pipelines

**Tools**: `alloy_pipeline` (7 actions: create, list, update, delete, recipes, status, diagnose)
**Preconditions**: LGTM + Alloy stack running (see `~/workspace/alloy-scenarios/grafana-lens-test/`), gateway running with `alloy.enabled: true`, `config.d/` empty (only `base.alloy`)
**Session**: `e2e-alloy`

**Infrastructure**: Start the test stack before running:
```bash
cd ~/workspace/alloy-scenarios/grafana-lens-test && docker compose --env-file ../image-versions.env up -d
```

> **Important**: Scrape targets in prompts must use Docker-internal service names (e.g., `http://prometheus:9090/metrics`), not `localhost`.

#### AP1: Recipes — Discover Catalog
```bash
openclaw agent --session-id e2e-alloy -m "What Alloy pipeline recipes are available? Show me the full catalog."
```
**Expected tool**: `alloy_pipeline` with `action: "recipes"`
**Pass**: `categories` includes `{ metrics: 11, logs: 10, traces: 4, infrastructure: 3, profiling: 1 }`. 29 total recipes. `scrape-endpoint` listed with `url` required param.

#### AP2: Recipes — Category Filter
```bash
openclaw agent --session-id e2e-alloy -m "Show me only the log collection pipeline recipes."
```
**Expected tool**: `alloy_pipeline` with `action: "recipes"`, `category: "logs"`
**Pass**: Exactly 10 recipes: docker-logs, file-logs, syslog, kubernetes-logs, journal-logs, loki-push-api, kafka-logs, secret-filter-logs, faro-frontend, gelf-logs.

#### AP3: Create — Deploy scrape-endpoint Pipeline
```bash
openclaw agent --session-id e2e-alloy -m "Create an Alloy pipeline to scrape Prometheus metrics from http://prometheus:9090/metrics. Name it 'prom-self-scrape'."
```
**Expected tool**: `alloy_pipeline` with `action: "create"`, `recipe: "scrape-endpoint"`, `params.url`, `name: "prom-self-scrape"`
**Pass**: `status: "created"`, `reloaded: true`, `sampleQueries.metrics` present with `job="prom-self-scrape"`, `suggestedWorkflow` non-empty.
**Verify**:
```bash
ls ~/workspace/alloy-scenarios/grafana-lens-test/config.d/lens-prom-self-scrape-*.alloy
curl -sf http://localhost:12345/-/healthy
```

#### AP4: Status — Verify Components Healthy
```bash
openclaw agent --session-id e2e-alloy -m "What is the status of the 'prom-self-scrape' pipeline?"
```
**Expected tool**: `alloy_pipeline` with `action: "status"`, `name: "prom-self-scrape"`
**Pass**: `status: "healthy"`, 2 components both `health: "healthy"`, `dataVerification.verifyQuery` is `up{job="prom-self-scrape"}`.
**Verify**:
```bash
curl -s http://localhost:12345/api/v0/web/components | jq '.[].localID' | grep lens
```

#### AP5: List — Show Managed Pipelines
```bash
openclaw agent --session-id e2e-alloy -m "List all managed Alloy pipelines."
```
**Expected tool**: `alloy_pipeline` with `action: "list"`
**Pass**: `count: 1`, pipeline `prom-self-scrape` with `status: "active"`, `signal: "metrics"`, `limits` present.

#### AP6: Update — Change scrapeInterval
```bash
openclaw agent --session-id e2e-alloy -m "Update the 'prom-self-scrape' pipeline to scrape every 30 seconds instead of 15."
```
**Expected tool**: `alloy_pipeline` with `action: "update"`, `name: "prom-self-scrape"`, `params.scrapeInterval: "30s"`
**Pass**: `status: "updated"`.
**Verify**:
```bash
grep 'scrape_interval' ~/workspace/alloy-scenarios/grafana-lens-test/config.d/lens-prom-self-scrape-*.alloy
# Expected: scrape_interval = "30s"
```

#### AP7: Diagnose — Full System Check
```bash
openclaw agent --session-id e2e-alloy -m "Run a full diagnostic on the Alloy pipeline system."
```
**Expected tool**: `alloy_pipeline` with `action: "diagnose"`
**Pass**: `alloyConnectivity.reachable: true`, `alloyConnectivity.healthy: true`, `managedPipelines: 1`, `driftDetected: []`, `orphanFiles: []`.

#### AP8: Delete — Remove Pipeline
```bash
openclaw agent --session-id e2e-alloy -m "Delete the 'prom-self-scrape' pipeline."
```
**Expected tool**: `alloy_pipeline` with `action: "delete"`, `name: "prom-self-scrape"`
**Pass**: `status: "deleted"`. Config file removed from disk. Subsequent `list` returns `count: 0`.

#### AP9: Cross-Tool — Create Pipeline + Query Data
```bash
openclaw agent --session-id e2e-alloy -m "Create a pipeline called 'prom-e2e-verify' to scrape Prometheus metrics from http://prometheus:9090/metrics with a 10 second scrape interval."
```
Wait 20 seconds for scrape cycle + ingestion.
```bash
openclaw agent --session-id e2e-alloy -m "Query Prometheus for up{job=\"prom-e2e-verify\"}. Has data started flowing?"
```
**Expected tools**: `alloy_pipeline create` then `grafana_query`
**Pass**: `grafana_query` returns result with value `1`.
**Verify**:
```bash
curl -s 'http://localhost:9090/api/v1/query' --data-urlencode 'query=up{job="prom-e2e-verify"}' | jq '.data.result[0].value[1]'
# Expected: "1"
```

#### AP10: Cross-Tool — Create Dashboard from Pipeline
```bash
openclaw agent --session-id e2e-alloy -m "Create a Grafana dashboard to visualize the metrics from the 'prom-e2e-verify' pipeline. Use the metric-explorer template."
```
**Expected tool**: `grafana_create_dashboard` with `template: "metric-explorer"`
**Pass**: `status: "created"`, `uid` returned.

#### AP11: Cross-Tool — Cleanup
```bash
openclaw agent --session-id e2e-alloy -m "Delete the 'prom-e2e-verify' pipeline and the Metric Explorer dashboard."
```
**Pass**: Pipeline deleted, dashboard deleted.

#### AP12: Error — Unknown Recipe
```bash
openclaw agent --session-id e2e-alloy -m "Create an Alloy pipeline using the 'banana-exporter' recipe."
```
**Pass**: Error containing `"Unknown recipe"` with list of available recipes.

#### AP13: Error — Missing Required Param
```bash
openclaw agent --session-id e2e-alloy -m "Create an Alloy pipeline using the scrape-endpoint recipe with no URL."
```
**Pass**: Error containing `"requires 'url' parameter"`, `status: "validation_error"`.
**Note**: Agent may infer a URL — acceptable if it provides one. Key assertion: calling without `params.url` returns the documented error.

#### AP14: Error — Duplicate Name
Create `dup-test`, then try creating another with the same name.
**Pass**: Second call returns `"already exists"`. Cleanup: delete `dup-test`.

#### AP15: Error — Bad Raw Config
```bash
openclaw agent --session-id e2e-alloy -m "Create a custom Alloy pipeline named 'bad-config' with this raw config: 'this is not valid alloy syntax { broken'. Use the config parameter directly."
```
**Pass**: `"Config rejected by Alloy"`, `status: "rolled_back"`. No config file on disk. Alloy still healthy.
**Verify**:
```bash
curl -sf http://localhost:12345/-/healthy
```

#### AP16–18: Error — Non-Existent Pipeline (status/delete/update)
```bash
openclaw agent --session-id e2e-alloy -m "Check the status of pipeline 'ghost-pipeline'."
openclaw agent --session-id e2e-alloy -m "Delete pipeline 'ghost-pipeline'."
openclaw agent --session-id e2e-alloy -m "Update pipeline 'ghost-pipeline' with scrapeInterval 30s."
```
**Pass**: All return `"not found"`.

#### AP19: Advanced — Drift Detection
1. Create `drift-test` pipeline.
2. Manually tamper: `echo "// tampered" >> config.d/lens-drift-test-*.alloy`
3. Run diagnose.
**Pass**: `driftDetected` includes `drift-test` with `"hash mismatch"`. Cleanup: delete `drift-test`.

#### AP20: Advanced — Orphan File Detection
1. `touch ~/workspace/alloy-scenarios/grafana-lens-test/config.d/lens-orphan-test.alloy`
2. Run diagnose.
**Pass**: `orphanFiles` includes `lens-orphan-test.alloy`.
3. Cleanup: `rm config.d/lens-orphan-test.alloy`

#### AP21: Advanced — Alloy Unreachable
1. `docker compose stop alloy`
2. Try to create a pipeline.
**Pass**: Error about connection refused / rollback.
3. `docker compose start alloy` to restore.

#### AP22: Recipe — node-exporter (create + status + data flow) [P0]
```bash
openclaw agent --session-id e2e-alloy -m "Create an Alloy pipeline using the node-exporter recipe. Name it 'e2e-node'."
```
Wait 20s for scrape.
```bash
openclaw agent --session-id e2e-alloy -m "Check the status of the 'e2e-node' pipeline."
openclaw agent --session-id e2e-alloy -m "Query Prometheus for up{job=\"e2e-node\"}."
```
**Pass**: Created with 4 components, status `"healthy"`, query returns value `1`.
**Cleanup**: Delete `e2e-node`.

#### AP23: Recipe — docker-metrics (cAdvisor data flow) [P0]
```bash
openclaw agent --session-id e2e-alloy -m "Create an Alloy pipeline to collect Docker container metrics. Name it 'e2e-docker-metrics'."
```
Wait 20s. Query `container_cpu_usage_seconds_total{job="e2e-docker-metrics"}`.
**Pass**: `status: "created"`, 4 components, container metrics arrive.
**Cleanup**: Delete `e2e-docker-metrics`.

#### AP24: Recipe — docker-logs (log signal path) [P0]
```bash
openclaw agent --session-id e2e-alloy -m "Create an Alloy pipeline to collect Docker container logs. Name it 'e2e-docker-logs'."
```
Wait 20s.
```bash
openclaw agent --session-id e2e-alloy -m "Query Loki for recent logs with source=docker."
```
**Expected tools**: `alloy_pipeline` create, then `grafana_query_logs`
**Pass**: Pipeline created with signal `"logs"`, log entries returned from Loki.
**Cleanup**: Delete `e2e-docker-logs`.

#### AP25: Recipe — file-logs (file tailing) [P1]
Create a test log file inside the Alloy container, then create `file-logs` pipeline pointing to it.
**Pass**: Pipeline created with 3 components. Tailed log content appears in Loki.
**Challenge**: File path must be accessible inside the Alloy container (bind mount or `docker exec`).

#### AP26: Recipe — syslog (protocol param) [P1]
```bash
openclaw agent --session-id e2e-alloy -m "Create a syslog pipeline listening on UDP port 5514. Name it 'e2e-syslog'."
```
**Expected tool**: `alloy_pipeline` create with `recipe: "syslog"`, `params.protocol: "udp"`
**Pass**: Config contains `protocol = "udp"` (not tcp). 2 components. Status healthy.
**Cleanup**: Delete `e2e-syslog`.

#### AP27: Recipe — otlp-receiver (trace ingestion) [P0]
```bash
openclaw agent --session-id e2e-alloy -m "Create an OTLP receiver pipeline on gRPC port 4327 and HTTP port 4328. Name it 'e2e-otlp'."
```
Send test OTLP trace via `curl -X POST http://localhost:4328/v1/traces ...`.
```bash
openclaw agent --session-id e2e-alloy -m "Search for recent traces in Tempo."
```
**Pass**: Pipeline created with signal `"traces"`, trace found in Tempo.
**Infra**: Needs port mapping `4327:4327` and `4328:4328` in docker-compose.
**Cleanup**: Delete `e2e-otlp`.

#### AP28: Recipe — application-traces (environment enrichment) [P1]
```bash
openclaw agent --session-id e2e-alloy -m "Create an application-traces pipeline for staging environment. Name it 'e2e-app-traces'."
```
**Pass**: Created with 4 components. Sample queries include `deployment.environment = "staging"`.
**Cleanup**: Delete `e2e-app-traces`.

#### AP29: Recipe — postgres-exporter (credential handling) [P1]
```bash
openclaw agent --session-id e2e-alloy -m "Create a pipeline to monitor PostgreSQL at postgres://user:pass@db:5432/test. Name it 'e2e-postgres'."
```
**Pass**: `envVarsRequired` includes `ALLOY_POSTGRES_EXPORTER_E2E_POSTGRES_CONNECTIONSTRING`. Stored params have `"***REDACTED***"`. Components will be unhealthy (no Postgres) — expected.
**Cleanup**: Delete `e2e-postgres`.

#### AP30: Recipe — redis-exporter (optional credential) [P1]
Create without password → empty `envVarsRequired`. Create with password → env var generated.
**Pass**: Conditional credential handling works.
**Cleanup**: Delete both pipelines.

#### AP31: Recipe — mysql-exporter (credential consistency) [P2]
Same pattern as AP29 for MySQL. Validates credential handling consistency.

#### AP32: Recipe — elasticsearch-exporter (infrastructure category) [P2]
Create pipeline, verify `category: "infrastructure"` in recipes listing.

#### AP33: Recipe — kafka-exporter (string[] param) [P2]
```bash
openclaw agent --session-id e2e-alloy -m "Create a Kafka exporter pipeline monitoring brokers at kafka1:9092 and kafka2:9092. Name it 'e2e-kafka'."
```
**Pass**: Array parameter handled correctly in generated config.
**Cleanup**: Delete `e2e-kafka`.

#### AP34: Raw Config — Valid deployment [P0]
```bash
openclaw agent --session-id e2e-alloy -m "Create a custom Alloy pipeline named 'e2e-raw-basic' with this raw config: prometheus.scrape \"raw_scrape\" { targets = [{\"__address__\" = \"prometheus:9090\"}] forward_to = [prometheus.remote_write.raw_write.receiver] } prometheus.remote_write \"raw_write\" { endpoint { url = \"http://mimir:9009/api/prom/push\" } }"
```
**Pass**: `status: "created"`, `recipe: null`, components detected (not empty).
**Cleanup**: Delete `e2e-raw-basic`.

#### AP35: Raw Config — GELF log ingestion pattern [P1]
Deploy adapted GELF config from `alloy-scenarios/gelf-log-ingestion/config.alloy`.
**Pass**: Reload succeeds. Use `signal: "logs"` param to correctly label the pipeline.
**Cleanup**: Delete pipeline.

#### AP36: Raw Config — Blackbox probing pattern [P1]
Deploy adapted blackbox-probing config. Query `probe_success` metric.
**Pass**: Config accepted by Alloy. Probe metrics arrive.
**Cleanup**: Delete pipeline.

#### AP37: Raw Config — Tail sampling pattern [P2]
Deploy adapted `otel-tail-sampling/config.alloy` (113 lines, 6 policies).
**Pass**: Complex multi-component config accepted by Alloy.

#### AP38: Raw Config — Update (two cases) [P0]
Create raw pipeline `raw-update-test` via AP35/36, then test both update paths:
**Case A** — Update without `config` param (just `params`):
```bash
openclaw agent --session-id e2e-alloy -m "Update pipeline 'raw-update-test' with scrapeInterval 30s."
```
**Pass A**: Returns `status: "validation_error"` with error containing `"Raw-config pipelines require 'config' param"`.
**Case B** — Update WITH replacement `config`:
```bash
openclaw agent --session-id e2e-alloy -m "Update pipeline 'raw-update-test' with this new raw config: prometheus.scrape \"updated\" { targets = [{ \"__address__\" = \"localhost:9090\" }] forward_to = [prometheus.remote_write.updated.receiver] } prometheus.remote_write \"updated\" { endpoint { url = \"http://mimir:9009/api/prom/push\" } }"
```
**Pass B**: Returns `status: "updated"`, pipeline config replaced on disk, Alloy reloaded.
**Cleanup**: Delete `raw-update-test`.

#### AP39: Raw Config — Missing name [P0]
```bash
openclaw agent --session-id e2e-alloy -m "Create a custom Alloy pipeline with this raw config: prometheus.scrape \"test\" { }. Don't give it a name."
```
**Pass**: Error `"Pipeline 'name' is required when using raw config."`.

#### AP40: Multi-Pipeline — Different signals [P0]
Create `node-exporter` (metrics) + `docker-logs` (logs).
```bash
openclaw agent --session-id e2e-alloy -m "List all managed Alloy pipelines."
openclaw agent --session-id e2e-alloy -m "Run a full diagnostic on the Alloy pipeline system."
```
**Pass**: 2 pipelines with different signals. Diagnose: both healthy, no drift.
**Cleanup**: Delete both.

#### AP41: Multi-Pipeline — Docker metrics + logs [P1]
Create `docker-metrics` + `docker-logs` from same Docker host. Query both signals.
**Pass**: Metrics and logs arrive independently. No interference.
**Cleanup**: Delete both.

#### AP42: Multi-Pipeline — Limit enforcement [P1]
Requires `maxPipelines: 3` in test config. Create 3 pipelines, attempt 4th.
**Pass**: 4th returns error containing `"limit"`.
**Note**: Impractical with default limit of 20. Consider reducing limit in test config.

#### AP43: Multi-Pipeline — Job label isolation [P1]
Create 2 `scrape-endpoint` pipelines targeting different services.
**Pass**: `up{job="pipeline-1"}` and `up{job="pipeline-2"}` return data independently.
**Cleanup**: Delete both.

#### AP44: Multi-Pipeline — Mixed health [P1]
Create `node-exporter` (healthy) + `scrape-endpoint` targeting `http://nonexistent:9999` (unhealthy).
**Pass**: Diagnose shows mixed health. Healthy pipeline unaffected.
**Cleanup**: Delete both.

#### AP45: Update — Change scrape interval [P0]
```bash
openclaw agent --session-id e2e-alloy -m "Create a scrape-endpoint pipeline for http://prometheus:9090/metrics. Name it 'e2e-update-test'."
openclaw agent --session-id e2e-alloy -m "Update 'e2e-update-test' to scrape every 30 seconds."
```
**Pass**: `status: "updated"`. Config file reflects `scrape_interval = "30s"`.
**Cleanup**: Delete `e2e-update-test`.

#### AP46: Update — Add credential param [P1]
Create `scrape-endpoint` without auth, update to add `basicAuth`.
**Pass**: Param merge works. `envVarsRequired` now includes auth env vars.
**Cleanup**: Delete pipeline.

#### AP47: Update — Partial param preservation [P0]
Create with `{ url, scrapeInterval: "10s", metricsPath: "/custom" }`. Update only `scrapeInterval: "60s"`.
**Pass**: Pipeline retains original `url` and `metricsPath`. Only `scrapeInterval` changed.
**Cleanup**: Delete pipeline.

#### AP48: Update — Recipe change silently ignored [P1]
Create `scrape-endpoint`, update with `recipe: "node-exporter"`.
**Pass**: Recipe does NOT change (update handler ignores recipe param). Pipeline remains `scrape-endpoint`.
**Cleanup**: Delete pipeline.

#### AP49: Update — Rollback on Alloy rejection [P1]
Create valid pipeline, update with params producing invalid config (e.g., empty URL).
**Pass**: `status: "rolled_back"`. Previous config restored. Pipeline still works.
**Cleanup**: Delete pipeline.

#### AP50: Cross-Tool — Pipeline to grafana_query_logs [P0]
Create `docker-logs` pipeline. Wait 20s.
```bash
openclaw agent --session-id e2e-alloy -m "Query Loki for recent Docker container logs."
```
**Pass**: `grafana_query_logs` returns log entries from Docker containers.
**Cleanup**: Delete pipeline.

#### AP51: Cross-Tool — Pipeline to grafana_query_traces [P1]
Create `otlp-receiver` with non-default ports. Send test OTLP trace.
```bash
openclaw agent --session-id e2e-alloy -m "Search for traces from service 'e2e-test-service' in Tempo."
```
**Pass**: `grafana_query_traces` returns the test trace.
**Infra**: Needs port exposure in docker-compose.
**Cleanup**: Delete pipeline.

#### AP52: Cross-Tool — Pipeline to list_metrics to create_dashboard [P0]
```bash
openclaw agent --session-id e2e-alloy -m "Create a node-exporter pipeline named 'e2e-workflow'. Then discover what metrics it produces and create a Metric Explorer dashboard for them."
```
**Expected tools**: `alloy_pipeline` create → `grafana_list_metrics` → `grafana_create_dashboard`
**Pass**: Pipeline created, node_* metrics discovered, dashboard created.
**Cleanup**: Delete pipeline + dashboard.

#### AP53: Cross-Tool — Pipeline to create_alert [P1]
Create `scrape-endpoint`, then create alert on `up{job="..."}==0`.
**Pass**: Alert rule created referencing pipeline's job label.
**Cleanup**: Delete pipeline + alert rule.

#### AP54: Cross-Tool — Pipeline to explain_metric [P1]
Create `node-exporter`. Wait 20s.
```bash
openclaw agent --session-id e2e-alloy -m "Explain the node_cpu_seconds_total metric from the 'e2e-explain' pipeline."
```
**Pass**: Returns explanation with current value, trend, stats.
**Cleanup**: Delete pipeline.

#### AP55: Cross-Tool — Pipeline to investigate [P2]
Create `scrape-endpoint` targeting unreachable host. Use `grafana_investigate`.
**Pass**: Investigation gathers signals and suggests hypotheses.
**Cleanup**: Delete pipeline.

#### AP56: Resilience — Create during Alloy restart [P1]
`docker restart alloy`, immediately create pipeline.
**Pass**: Either succeeds or returns clear connectivity error. No corrupt state.

#### AP57: Resilience — Rapid create/delete cycles [P0]
3x sequential: create `node-exporter` as `e2e-rapid-N` + delete.
**Pass**: All 3 cycles succeed. Final `list` returns 0. `diagnose` shows no orphans.

#### AP58: Resilience — State file corruption [P2]
Corrupt `alloy-pipelines.json`, restart gateway.
**Pass**: Service starts fresh or throws clear error. Orphan detection finds stale config files.

#### AP59: Resilience — Delete with missing config file [P1]
Create pipeline, manually `rm config.d/lens-*.alloy`, then delete via tool.
**Pass**: Delete succeeds (handles ENOENT). Pipeline removed from state.

#### AP60: Resilience — Read-only config directory [P2]
`chmod 555 config.d/`, attempt create.
**Pass**: Returns `"Failed to write config file"`. No corrupt state.
**Reset**: `chmod 755 config.d/`.

#### AP61: Scenario — Multi-stage log processing via raw config [P1]
Deploy adapted `log-secret-filtering/config.alloy` as raw config with `signal: "logs"`.
**Pass**: Alloy accepts the multi-stage pipeline (file_match → source.file → secretfilter → write).
**Cleanup**: Delete pipeline.

#### AP62: Scenario — Recipe + raw config coexistence [P1]
Create 1 recipe pipeline (`node-exporter`) + 1 raw config pipeline. Run `diagnose`.
**Pass**: Both in list. Diagnose shows 2 managed pipelines, no drift.
**Cleanup**: Delete both.

#### AP63: Scenario — Port conflict (otlp-receiver + application-traces) [P1]
Create `otlp-receiver` (default ports), then `application-traces` (same default ports).
**Pass**: Second pipeline fails with `status: "rolled_back"` (port conflict).
**Cleanup**: Delete first pipeline.

#### AP64: Scenario — Alloy-scenarios compatibility survey [P2]
Deploy 4 adapted real-world configs as raw pipelines (serial, cleanup between):
1. blackbox-probing → reload succeeds → delete
2. gelf-log-ingestion → reload succeeds → delete
3. otel-tail-sampling → reload succeeds → delete
4. log-secret-filtering → reload succeeds → delete
**Pass**: All 4 configs accepted by Alloy.

#### AP65: Edge — Pipeline name with special characters [P1]
```bash
openclaw agent --session-id e2e-alloy -m "Create a node-exporter pipeline named 'e2e my/special:pipeline'."
```
**Pass**: Name sanitized for filename (special chars → `-`). Pipeline addressable by original name for status/delete.
**Cleanup**: Delete pipeline.

#### AP66: Edge — Auto-generated name (no name param) [P0]
```bash
openclaw agent --session-id e2e-alloy -m "Create a node-exporter pipeline."
```
**Pass**: `status: "created"`, name auto-generated (equals recipe name or variant). Appears in `list`.
**Cleanup**: Delete by auto-generated name.

#### AP67: Edge — docker-logs containerNames filtering [P2]
```bash
openclaw agent --session-id e2e-alloy -m "Create a docker-logs pipeline that only collects from the 'grafana' container. Name it 'e2e-filtered-logs'."
```
**Pass**: Config contains `discovery.relabel` with `__meta_docker_container_name` keep rule for "grafana".
**Cleanup**: Delete `e2e-filtered-logs`.

#### AP68: Recipe — loki-push-api (HTTP log gateway) [P1]
```bash
openclaw agent --session-id e2e-alloy -m "Create an Alloy pipeline to accept logs via HTTP push API on port 3500. Name it 'e2e-push-api'."
```
**Expected tool**: `alloy_pipeline` with `recipe: "loki-push-api"`
**Pass**: `status: "created"`, 2 components (`loki.source.api`, `loki.write`), `boundPorts` includes 3500.
**Data verification**: Send a test log via `curl -X POST http://localhost:3500/loki/api/v1/push -H 'Content-Type: application/json' -d '{"streams":[{"stream":{"job":"e2e-push-test"},"values":[["'$(date +%s)000000000'","hello from push API"]]}]}'`. Query Loki for `{job="e2e-push-test"}`.
**Cleanup**: Delete `e2e-push-api`.

#### AP69: Recipe — kafka-logs (complex params + credentials) [P2]
```bash
openclaw agent --session-id e2e-alloy -m "Create an Alloy pipeline to consume logs from Kafka. Brokers: ['kafka:9092']. Topics: ['app-logs']. Use SASL PLAIN auth. Name it 'e2e-kafka-logs'."
```
**Pass**: `status: "created"`, `envVarsRequired` includes SASL credential env vars. Config contains `loki.source.kafka`. Stored params have redacted SASL credentials. Components will be unhealthy (no Kafka) — expected.
**Cleanup**: Delete `e2e-kafka-logs`.

#### AP70: Recipe — secret-filter-logs (gitleaks redaction) [P2]
```bash
openclaw agent --session-id e2e-alloy -m "Create an Alloy pipeline to collect logs from /tmp/e2e-secrets.log with automatic secret redaction. Name it 'e2e-secret-filter'."
```
**Setup**: `docker exec alloy sh -c 'echo "api_key=ghp_1234567890abcdef1234567890abcdef12345678" > /tmp/e2e-secrets.log'`
**Pass**: Config contains `loki.secretfilter` component. After 20s, query Loki — log line should have `ghp_*` redacted.
**Cleanup**: Delete `e2e-secret-filter`.

#### AP71: Recipe — mongodb-exporter (credential handling) [P2]
```bash
openclaw agent --session-id e2e-alloy -m "Create an Alloy pipeline to monitor MongoDB at mongodb://admin:pass@mongo:27017. Name it 'e2e-mongodb'."
```
**Pass**: `envVarsRequired` includes `ALLOY_MONGODB_EXPORTER_E2E_MONGODB_MONGODBURI`. Stored params have `"***REDACTED***"`. Components unhealthy (no MongoDB) — expected.
**Cleanup**: Delete `e2e-mongodb`.

#### AP72: Recipe — span-metrics (dual output: traces + metrics) [P1]
```bash
openclaw agent --session-id e2e-alloy -m "Create a span-metrics pipeline on gRPC port 4327 and HTTP port 4328. Name it 'e2e-span-metrics'."
```
**Pass**: `status: "created"`, config contains `otelcol.connector.spanmetrics`, `otelcol.exporter.otlphttp`, AND `prometheus.remote_write`. `boundPorts` includes 4327 and 4328.
**Data verification**: Send test OTLP traces to port 4328, wait 20s. Query Prometheus for `duration_milliseconds_bucket{service_name="e2e-test"}` AND query Tempo for traces.
**Cleanup**: Delete `e2e-span-metrics`.

#### AP73: Recipe — service-graph (dual output) [P1]
```bash
openclaw agent --session-id e2e-alloy -m "Create a service-graph pipeline on gRPC port 4337 and HTTP port 4338. Name it 'e2e-service-graph'."
```
**Pass**: Config contains `otelcol.connector.servicegraph`. `boundPorts` includes 4337, 4338.
**Cleanup**: Delete `e2e-service-graph`.

#### AP74: Recipe — blackbox-exporter with multiple targets [P1]
```bash
openclaw agent --session-id e2e-alloy -m "Create a blackbox probing pipeline to monitor these endpoints: grafana at http://grafana:3000, prometheus at http://prometheus:9090, mimir at http://mimir:9009. Name it 'e2e-blackbox'."
```
**Pass**: Config contains 3 targets. After 20s, `probe_success{instance=~".*grafana.*"}` returns 1.
**Cleanup**: Delete `e2e-blackbox`.

#### AP75: Recipe — memcached-exporter [P2]
```bash
openclaw agent --session-id e2e-alloy -m "Create a pipeline to monitor Memcached at memcached:11211. Name it 'e2e-memcached'."
```
**Pass**: `status: "created"`, recipe `memcached-exporter`. Components unhealthy (no Memcached) — expected. No credential env vars required.
**Cleanup**: Delete `e2e-memcached`.

#### AP76: Log Processing — docker-logs with JSON extraction [P1]
```bash
openclaw agent --session-id e2e-alloy -m "Create a docker-logs pipeline with JSON extraction for 'level' and 'service' fields. Name it 'e2e-json-logs'."
```
**Expected params**: `jsonExpressions: { level: "level", service: "service" }` (or similar)
**Pass**: Config contains `stage.json` with the extraction expressions. After 20s, Loki query `{container_name=~".+"} | json | level != ""` returns results with extracted labels.
**Cleanup**: Delete `e2e-json-logs`.

#### AP77: Log Processing — file-logs with regex + timestamp [P2]
Setup: Create test log file inside Alloy container with Apache-format log lines.
```bash
openclaw agent --session-id e2e-alloy -m "Create a file-logs pipeline for /tmp/e2e-apache.log with regex extraction for 'ip', 'method', 'path'. Use timestamp parsing. Name it 'e2e-regex-logs'."
```
**Pass**: Config contains `stage.regex` and `stage.timestamp`. Parsed fields appear as labels/metadata in Loki.
**Cleanup**: Delete `e2e-regex-logs`.

#### AP78: Log Processing — syslog with structuredMetadata [P2]
```bash
openclaw agent --session-id e2e-alloy -m "Create a syslog pipeline on UDP port 5514 with structured metadata for hostname and app_name. Name it 'e2e-syslog-meta'."
```
**Pass**: Config contains `stage.structured_metadata` block with `hostname` and `app_name`. Protocol is UDP.
**Cleanup**: Delete `e2e-syslog-meta`.

#### AP79: Log Processing — kafka-logs with full processing pipeline [P2]
```bash
openclaw agent --session-id e2e-alloy -m "Create a kafka-logs pipeline for brokers ['kafka:9092'], topics ['events']. Extract JSON fields: level, service, trace_id. Promote level and service to labels. Add trace_id as structured metadata. Add static label environment=staging. Name it 'e2e-full-processing'."
```
**Pass**: Config contains `stage.json`, `stage.labels`, `stage.structured_metadata`, `stage.static_labels`. All specified fields present.
**Cleanup**: Delete `e2e-full-processing`.

#### AP80: Raw Config — Pyroscope profiling pipeline [P1]
```bash
openclaw agent --session-id e2e-alloy -m "Create a custom Alloy pipeline for continuous profiling. Use pyroscope.scrape targeting localhost:6060 and pyroscope.write to http://pyroscope:4040. Name it 'e2e-profiling'. Use the config parameter directly."
```
**Pass**: `signal: "profiles"`, 2 components extracted (`pyroscope.scrape`, `pyroscope.write`). `exportTargets` present in response.
**Cleanup**: Delete `e2e-profiling`.

#### AP81: Raw Config — Faro frontend receiver [P1]
```bash
openclaw agent --session-id e2e-alloy -m "Create a custom Alloy pipeline for frontend observability. Use faro.receiver on port 12347 with CORS for all origins, forwarding to loki.write. Name it 'e2e-faro'. Use the config parameter."
```
**Pass**: `signal: "logs"` (not "metrics"), components include `faro.receiver` and `loki.write`.
**Cleanup**: Delete `e2e-faro`.

#### AP82: Raw Config — Tail sampling (complex OTel pipeline) [P1]
```bash
openclaw agent --session-id e2e-alloy -m "Create a custom Alloy pipeline with OTLP receiver, tail sampling (keep errors and >5s latency), batch processor, and OTLP HTTP exporter to tempo:4318. Name it 'e2e-tail-sampling'. Use the config parameter."
```
**Pass**: `signal: "traces"`, 4+ components extracted (receiver, tail_sampling, batch, exporter). Status healthy after reload.
**Cleanup**: Delete `e2e-tail-sampling`.

#### AP83: Raw Config — GELF log ingestion [P2]
```bash
openclaw agent --session-id e2e-alloy -m "Create a custom Alloy pipeline for GELF UDP log ingestion on port 12201. Use loki.source.gelf forwarding to loki.write. Name it 'e2e-gelf'. Use the config parameter."
```
**Pass**: Components include `loki.source.gelf` and `loki.write`. Signal auto-detected as "logs".
**Cleanup**: Delete `e2e-gelf`.

#### AP84: Raw Config — Update with replacement config [P0]
1. Create raw config pipeline `e2e-raw-update` (simple prometheus.scrape).
2. Update with new config via `config` param:
```bash
openclaw agent --session-id e2e-alloy -m "Update pipeline 'e2e-raw-update' with this new raw config: prometheus.scrape \"updated\" { targets = [{ \"__address__\" = \"prometheus:9090\" }] forward_to = [prometheus.remote_write.updated.receiver] } prometheus.remote_write \"updated\" { endpoint { url = \"http://mimir:9009/api/prom/push\" } }"
```
**Pass**: `status: "updated"`, `sampleQueries` and `suggestedWorkflow` present in response. Config file on disk contains "updated" labels.
**Cleanup**: Delete `e2e-raw-update`.

#### AP85: Port Conflict Detection [P0]
1. Create `e2e-otlp-1` with recipe `otlp-receiver` on default ports (4317/4318).
2. Create `e2e-otlp-2` with recipe `otlp-receiver` on same default ports.
```bash
openclaw agent --session-id e2e-alloy -m "Create another OTLP receiver pipeline on the default ports. Name it 'e2e-otlp-2'."
```
**Pass**: Second create returns `status: "validation_error"` with error mentioning port 4317 and pipeline `e2e-otlp-1`. First pipeline unaffected.
3. Create `e2e-otlp-2` with different ports (4327/4328) — should succeed.
**Cleanup**: Delete both pipelines.

#### AP86: Full Observability Stack Workflow [P0]
End-to-end cross-tool chain:
1. `alloy_pipeline` create `node-exporter`, name `e2e-stack-metrics`
2. `alloy_pipeline` create `docker-logs`, name `e2e-stack-logs`
3. `alloy_pipeline` create `otlp-receiver` on ports 4327/4328, name `e2e-stack-traces`
4. `alloy_pipeline` diagnose — all 3 healthy, no drift
5. Wait 20s. `grafana_query` with `node_cpu_seconds_total{job="e2e-stack-metrics"}` — has data
6. `grafana_query_logs` with `{job="e2e-stack-logs"}` — has log entries
7. `grafana_create_dashboard` with template `metric-explorer` — `status: "created"`
8. Delete all 3 pipelines + dashboard.
**Pass**: Complete chain works end-to-end. Each signal type has flowing data.

#### AP87: Rapid Sequential Creates (stress test) [P1]
Create 5 pipelines in rapid succession with no wait between:
```bash
openclaw agent --session-id e2e-alloy -m "Create these 5 Alloy pipelines one after another without waiting: node-exporter named 'rapid-1', self-monitoring named 'rapid-2', docker-metrics named 'rapid-3', blackbox-exporter targeting http://grafana:3000 named 'rapid-4', scrape-endpoint at http://prometheus:9090/metrics named 'rapid-5'."
```
**Pass**: All 5 appear in `list`. At least 4 of 5 show `status: "active"` (timing sensitivity).
**Cleanup**: Delete all 5.

#### AP88: Update Recipe Params (param merge) [P0]
1. Create `scrape-endpoint` with `url: "http://prometheus:9090/metrics"`, `scrapeInterval: "15s"`, name `e2e-param-update`.
2. Update with `params: { scrapeInterval: "30s" }`.
```bash
openclaw agent --session-id e2e-alloy -m "Update pipeline 'e2e-param-update' to scrape every 30 seconds."
```
**Pass**: `status: "updated"`, `sampleQueries` present in response. Config file contains `scrape_interval = "30s"`. URL unchanged (param merge, not replacement).
**Cleanup**: Delete `e2e-param-update`.

#### AP89: Export Targets in Raw Config Response [P1]
```bash
openclaw agent --session-id e2e-alloy -m "Create a custom Alloy pipeline named 'e2e-export-targets' with this raw config: prometheus.scrape \"test\" { targets = [{ \"__address__\" = \"localhost:9090\" }] forward_to = [prometheus.remote_write.test.receiver] } prometheus.remote_write \"test\" { endpoint { url = \"http://mimir:9009/api/prom/push\" } }"
```
**Pass**: Response includes `exportTargets` with `prometheusRemoteWriteUrl`, `lokiWriteUrl`, `otlpEndpoint`. These URLs match the configured LGTM endpoints.
**Cleanup**: Delete `e2e-export-targets`.

---

### Group: Telemetry (Gateway Web UI)

**Purpose**: Verify the full OTLP trace/log/metrics pipeline using the gateway auto-reply path.
**Channel**: Gateway Web UI via Chrome (NOT `openclaw agent` CLI)
**Preconditions**: Gateway running, LGTM stack healthy, Chrome browser tools available
**Changed files that trigger this group**: `src/services/lifecycle-telemetry.ts`, `src/services/metrics-collector.ts`, `index.ts`

#### T1: Full Trace Hierarchy
Send a simple message via the gateway web UI (e.g., "What is 2+2?"). After the response, check Tempo:
```bash
# Search recent traces
curl -s "http://localhost:3000/api/datasources/proxy/uid/tempo/api/search?limit=5&start=$(( $(date +%s) - 120 ))&end=$(date +%s)" -u admin:admin
```
**Pass**: Trace contains `invoke_agent` root span, `chat` span(s) with `gen_ai.operation.name: "chat"`, and `execute_tool` spans if tools were called. This is the full hierarchy that `openclaw agent` CLI does NOT produce.

#### T2: model.usage Tokens Flowing
After T1, check Prometheus for token counters:
```bash
curl -s 'http://localhost:9090/api/v1/query' --data-urlencode 'query=openclaw_lens_tokens_total'
```
**Pass**: Token counters have non-zero values for input/output/cacheRead.

#### T3: Lifecycle Logs in Loki
After T1, check Loki for lifecycle telemetry logs:
```bash
curl -s -G "http://localhost:3000/api/datasources/proxy/uid/loki/loki/api/v1/query_range" \
  --data-urlencode 'query={service_name="openclaw"} | json | component="lifecycle"' \
  --data-urlencode "start=$(( $(date +%s) - 120 ))000000000" \
  --data-urlencode "end=$(date +%s)000000000" \
  --data-urlencode "limit=5" -u admin:admin
```
**Pass**: At least 1 lifecycle log entry in the last 2 minutes.

#### T4: Fallback Dormant (Normal Mode)
After T1, verify no fallback spans were created:
```bash
curl -s 'http://localhost:9090/api/v1/query' --data-urlencode 'query=openclaw_lens_trace_fallback_spans_total'
```
**Pass**: Counter is 0 or absent (no fallback activation when hooks work). Also verify no `openclaw.trace_fallback=true` attribute on any spans in the trace from T1.

#### T5: Fallback Active (Simulated Hook Failure)
**This test requires temporarily disabling `llm_input`/`llm_output` hooks in `index.ts`.**
1. Comment out the `api.on("llm_input", ...)` and `api.on("llm_output", ...)` blocks in `index.ts`
2. Restart gateway: `openclaw gateway restart`
3. Send a message via gateway web UI
4. Check Tempo for a `chat` span with `openclaw.trace_fallback: true`
5. Check Loki for WARN log containing "hook dispatch appears broken"
6. Check Prometheus: `openclaw_lens_trace_fallback_spans_total > 0`
7. **Restore hooks** in `index.ts` and restart gateway

**Pass**: Fallback span in Tempo with correct attributes, WARN log in Loki, counter > 0.
**Important**: Always restore `index.ts` after this test.

---

## Known Caveats

| Caveat | Impact | Workaround |
|--------|--------|------------|
| LGTM uses `admin/admin` on first start | Token creation fails without service account | Create service account in Grafana UI first |
| Image Renderer not in LGTM stack | `grafana_share_dashboard` can't render PNG | Accept "link" deliveryTier as pass |
| `grafana_query_logs` needs Loki with data | Empty results if no logs in Loki | Mark SKIP if no Loki datasource |
| Agent needs valid model provider | `openclaw agent` fails without API key | Ensure model configured in openclaw |
| Agent may reorder tool calls | LLM might use tools in different order | Check target tool was called, not exact sequence |
| Custom metrics OTLP flush ~15s | Query right after push may miss data | Agent calls forceFlush; curl verification waits 5s |
| Alert rules need ~60s eval cycle | Alert state won't change instantly | Test rule creation only, not firing |
| Gateway restart takes a few seconds | Commands immediately after may fail | Wait 3-5s after restart |
| `openclaw health` reports "pairing required" | Looks like gateway is broken | Ignore — `openclaw agent` works fine for local dev. Check log output for "registered 14 tools" |
| Old timestamps (>10m) may be dropped by Mimir | Timestamped push tests may not land data | Test tool acceptance, not Mimir storage. Verify real-time pushes only |
| Tempo v2 returns protobuf-JSON format | `batches` key (not `resourceSpans`), base64 IDs, string kind/status | Tool normalizes to hex IDs + friendly strings. Both formats handled |
| `grafana_query_traces` needs Tempo with data | Empty results if no recent traces ingested | Mark SKIP if no Tempo datasource or no traces |
| `openclaw agent` CLI uses embedded mode | Missing `model.usage` events, `invoke_agent` root spans, `chat` spans | Use gateway web UI via Chrome for telemetry tests |
| Gateway web UI needs Chrome tools | `mcp__claude-in-chrome__*` tools required | Skip Telemetry group if Chrome tools unavailable |
| T5 modifies `index.ts` temporarily | Hooks disabled during test | Always restore after test, restart gateway |
| Alloy directory-mode config | Alloy must run `alloy run /etc/alloy/` (not single file) | Use `grafana-lens-test/docker-compose.yml` which sets this up |
| Docker DNS in generated configs | LGTM URLs in `.alloy` files must use service names | Set `alloy.lgtm` URLs in plugin config (not localhost) |
| `base.alloy` naming | Must NOT use `lens-` prefix | Named `base.alloy` to avoid drift detection false positive |
| Scrape delay after pipeline creation | Data takes 15-20s to appear | Wait 20s before `grafana_query` verification in AP9 |
| Pipeline state persists across tests | Prior state may interfere | Clean `alloy-pipelines.json` before starting fresh |
| AP21 stops Alloy container | Destructive to running stack | Run last or in isolation, always restart after |
| OTLP exporter uses HTTP not gRPC | `otlpEndpoint` must use port 4318 (HTTP), not 4317 (gRPC) | Set `alloy.lgtm.otlpEndpoint` to `http://tempo:4318` |
| Built-in exporters override `job_name` | Alloy exporters set `job=integrations/*` | Recipes include `prometheus.relabel` step to force pipeline name as job label |
| `loki.source.docker` needs targets | Empty `targets = []` discovers nothing | Recipe includes `discovery.docker` to auto-discover containers |
| AP27/AP51 need OTLP port exposure | otlp-receiver on non-default ports must be accessible from host | Add port mapping `4327:4327`, `4328:4328` to docker-compose.yml |
| AP42 needs reduced maxPipelines | Default limit of 20 makes limit test impractical | Set `alloy.maxPipelines: 3` in test config or skip |
| Exporter recipes create unhealthy components | No actual database/service to connect to | AP29-33 test credential handling only, expect unhealthy components |
| `application-traces` sampleRate adds tail_sampling | When sampleRate < 1.0, adds `otelcol.processor.tail_sampling` | Default (1.0) has no sampling. AP28 tests without, separate test needed with |
| Raw config componentIds auto-detected | `extractComponentIds()` parses River syntax for health checking | Quality depends on config formatting; nested blocks ignored correctly |
| AP63 port conflict causes rollback | Creating 2 OTLP receivers on same ports fails at Alloy reload | Second pipeline auto-rolls back; no pre-validation exists |

---

## Cleanup

After tests, remove test artifacts:
```bash
# Delete test alert rules (find UID first)
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/v1/provisioning/alert-rules \
  | jq -r '.[] | select(.title | startswith("E2E")) | .uid' \
  | xargs -I{} curl -X DELETE -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/v1/provisioning/alert-rules/{}

# Delete test annotations
curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:3000/api/annotations?tags=e2e&limit=50" \
  | jq -r '.[].id' \
  | xargs -I{} curl -X DELETE -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/annotations/{}

# Delete test custom metrics
openclaw agent --session-id e2e-cleanup -m "Delete the custom metrics 'e2e_test_gauge', 'e2e_test_counter', 'e2e_daily_steps', 'e2e_mixed_gauge'."

# Delete Alloy test pipeline configs + state
rm -f ~/workspace/alloy-scenarios/grafana-lens-test/config.d/lens-*.alloy
rm -f ~/.openclaw/state/openclaw-grafana-lens/alloy-pipelines.json
curl -sf -X POST http://localhost:12345/-/reload 2>/dev/null || true
```

---

## Summary

| Group | Tools | Tests | Session ID |
|-------|-------|-------|------------|
| Discovery | explore_datasources, list_metrics, search | D1–D3 | `e2e-discovery` |
| Metrics Push | push_metrics (register, push, list, delete, timestamped, mixed, rejection) | MP1–MP7 | `e2e-metrics-push` |
| Query | query, query_logs, explain_metric | Q1–Q4 | `e2e-query` |
| Traces | query_traces (search + get, duration filter, TraceQL attribute filter) | TR1–TR5 | `e2e-traces` |
| Dashboard | create_dashboard, get_dashboard, update_dashboard, share_dashboard | DB1–DB6 | `e2e-dashboard` |
| Alerting | check_alerts, create_alert, annotate | A1–A5 | `e2e-alerting` |
| Alloy Pipelines | alloy_pipeline (all 7 actions, 26 recipes, raw config, log processing, port conflicts, multi-pipeline, cross-tool) | AP1–AP89 | `e2e-alloy` |
| Telemetry | trace pipeline, model.usage, fallback (via Chrome) | T1–T5 | `e2e-telemetry` |
| **Total** | **18 tools + telemetry pipeline** | **124 tests** | |
