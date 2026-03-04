---
name: e2e-test
description: >
  End-to-end integration tests for Grafana Lens agent tools against a live LGTM stack.
  Detects local code changes and runs targeted tests for affected tools.
  Use when: "e2e test", "end to end test", "test against LGTM", "test grafana tools",
  "integration test", "run e2e", "test my changes"
---

# Grafana Lens E2E Tests

Integration tests for all 14 Grafana Lens tools against a live LGTM stack + Grafana.
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
src/grafana-client.ts                 → Discovery + Query + Dashboard + Alerting
index.ts                              → ALL (wiring changes)
src/services/custom-metrics-store.ts  → Metrics Push
src/services/otel-metrics.ts          → Metrics Push
src/services/otlp-json-writer.ts      → Metrics Push
src/services/metrics-collector.ts     → Metrics Push
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
src/templates/*                       → Dashboard
```

**User overrides** (skip change detection):
- "run all e2e tests" → all 5 groups in order
- "run discovery tests" → only Discovery
- "run metrics-push and query tests" → those 2 groups
- "test push-metrics" → Metrics Push group

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

### 2.2 OTLP Endpoint
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

### Execution Pattern

For each test:
1. Run `openclaw agent --session-id <session-id> -m "<prompt>"`
2. Check the agent output for the expected tool call and response shape
3. Optionally run `curl` verification against Grafana/Mimir API
4. Record: PASS / FAIL / SKIP

### Session ID Convention
- Discovery: `e2e-discovery`
- Metrics Push: `e2e-metrics-push`
- Query: `e2e-query`
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
```

---

## Summary

| Group | Tools | Tests | Session ID |
|-------|-------|-------|------------|
| Discovery | explore_datasources, list_metrics, search | D1–D3 | `e2e-discovery` |
| Metrics Push | push_metrics (register, push, list, delete, timestamped, mixed, rejection) | MP1–MP7 | `e2e-metrics-push` |
| Query | query, query_logs, explain_metric | Q1–Q4 | `e2e-query` |
| Dashboard | create_dashboard, get_dashboard, update_dashboard, share_dashboard | DB1–DB6 | `e2e-dashboard` |
| Alerting | check_alerts, create_alert, annotate | A1–A5 | `e2e-alerting` |
| **Total** | **14 tools** | **25 tests** | |
