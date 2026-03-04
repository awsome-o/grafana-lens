# Grafana Lens — Feature Roadmap

> Three features validated against community demand, technical feasibility, and codebase reuse.
> Pick up independently — each section is self-contained with all context needed for implementation.

---

## Feature 1: Loki/LogQL Support

**Status**: Done
**Effort**: 4-8 hours
**Priority**: High — completes the observability trifecta (metrics + logs + traces)

### Why It Matters

Strong community signal for log querying alongside metrics. Users want to correlate errors in logs with metric anomalies — e.g., "Find error logs in the last hour" or "Why did my service crash?" Pairs perfectly with existing alerting: an alert fires on a metric spike, agent queries Loki for the root cause.

The Grafana observability stack expects metrics + logs at minimum. Without log support, Grafana Lens only addresses half the story.

### Technical Approach

The existing datasource proxy pattern (`/api/datasources/proxy/uid/{dsUid}/...`) works identically for Loki — just a different path prefix:
- **Prometheus**: `/api/datasources/proxy/uid/{dsUid}/api/v1/query` and `/api/v1/query_range`
- **Loki**: `/api/datasources/proxy/uid/{dsUid}/loki/api/v1/query` and `/loki/api/v1/query_range`

Same query params (`expr`, `start`, `end`, `step`) plus Loki-specific `direction` and `limit`.

`grafana_explore_datasources` already discovers Loki datasources. `grafana_query` is the structural template for the new tool.

### Files to Create/Modify

| File | Action | What |
|------|--------|------|
| `src/grafana-client.ts` | Modify | Add `queryLoki(dsUid, expr, start, end, limit, direction)` method |
| `src/tools/query-logs.ts` | Create | New `grafana_query_logs` tool (mirror `query.ts` structure) |
| `src/tools/query-logs.test.ts` | Create | Unit tests |
| `index.ts` | Modify | Register new tool factory |
| `skills/SKILL.md` | Modify | Add tool docs, params, examples |

### Acceptance Criteria

- [x] `grafana_query_logs` tool registered and available to the agent
- [x] Supports LogQL queries via any Loki datasource discovered by `grafana_explore_datasources`
- [x] Returns structured log entries (timestamp, labels, line) in JSON
- [x] Supports `limit` (default 100) and `direction` (forward/backward)
- [x] Supports both instant and range queries
- [x] Error messages include remediation hints (e.g., "No Loki datasource found — add one in Grafana")
- [x] Tool description includes `WORKFLOW:` hints for agent composability
- [x] Tests pass: `npx vitest src/tools/query-logs.test.ts`
- [x] Type check passes: `npx tsc --noEmit`
- [x] SKILL.md updated with params, examples, returns, musts

### Subtasks

- [x] Add `queryLoki()` and `queryLokiRange()` methods to `GrafanaClient`
- [x] Create `src/tools/query-logs.ts` with parameter validation using `readStringParam`/`readNumberParam`
- [x] Handle Loki response format (streams vs matrix vs vector)
- [x] Format log lines for agent readability (truncate long lines, include labels)
- [ ] Add auto-discovery: if no `datasource_uid` provided, find first Loki datasource
- [x] Write tests with mocked Loki responses
- [x] Register tool in `index.ts`
- [x] Update `skills/SKILL.md`
- [ ] Test end-to-end with local Loki instance

---

## Feature 2: Dashboard Update/Modify

**Status**: Done
**Effort**: 2-3 hours
**Priority**: High — turns dashboards from one-shot artifacts into living documents

### Why It Matters

"Add a panel to my overview dashboard" is the most natural follow-up after creating a dashboard. Currently the agent can only create new dashboards — if a user wants to add a panel or change a time range, they need a whole new dashboard. This makes dashboards disposable rather than maintained.

Grafana treats create and update as the **same API call** (`POST /api/dashboards/db` with `overwrite: true`). The infrastructure is already there.

### Technical Approach

The `GrafanaClient.createDashboard()` method already calls `POST /api/dashboards/db` with `overwrite: true`. The update flow is:
1. Fetch existing dashboard with `getDashboard(uid)` (already exists)
2. Apply modifications (add/remove/update panels, change title, adjust time range)
3. Save with existing `createDashboard()` — Grafana handles versioning automatically

The tool needs to accept a dashboard UID + modification spec (what to add/change/remove).

### Files to Create/Modify

| File | Action | What |
|------|--------|------|
| `src/tools/update-dashboard.ts` | Create | New `grafana_update_dashboard` tool |
| `src/tools/update-dashboard.test.ts` | Create | Unit tests |
| `index.ts` | Modify | Register new tool factory |
| `skills/SKILL.md` | Modify | Add tool docs, params, examples |

### Acceptance Criteria

- [x] `grafana_update_dashboard` tool registered and available to the agent
- [x] Can add panels to existing dashboards
- [x] Can remove panels by ID or title
- [x] Can update dashboard title, description, tags, time range
- [x] Can update panel queries/thresholds
- [x] Returns updated dashboard URL and summary of changes
- [x] Handles version conflicts gracefully (uses `overwrite: true`)
- [x] Error messages for missing dashboards include search suggestions
- [x] Tests pass: `npx vitest src/tools/update-dashboard.test.ts`
- [x] Type check passes: `npx tsc --noEmit`
- [x] SKILL.md updated with params, examples, returns, musts

### Subtasks

- [x] Create `src/tools/update-dashboard.ts` with operations: `add_panel`, `remove_panel`, `update_panel`, `update_metadata`
- [x] Implement panel grid position auto-layout (find next available position)
- [x] Handle `add_panel` with custom JSON spec (same format as templates)
- [x] Handle `remove_panel` by panel ID or title match
- [x] Handle `update_metadata` for title, description, tags, time range, refresh
- [x] Write tests covering add/remove/update flows
- [x] Register tool in `index.ts`
- [x] Update `skills/SKILL.md`

---

## Feature 3: Explain Metric

**Status**: Done
**Effort**: 2-3 hours
**Priority**: Medium-High — addresses the #1 cost visibility pain point

### Why It Matters

Cost visibility is the top community pain point — users spending $3,600+/month with no insight into *why*. "What does this metric mean?" and "Why did my bill spike?" are natural questions the agent should answer with data, not guesswork.

The key insight: the tool provides **structured data** (current value, trends, min/max/avg); the LLM provides the **narrative**. Don't try to make the tool "explain" — give it enriched data and let the agent reason.

### Technical Approach

A lightweight `grafana_explain_metric` tool that:
1. Queries the current value of a metric
2. Queries 24h and 7d trends (percentage change)
3. Computes min/max/avg over the period
4. Fetches metric metadata (TYPE, HELP, UNIT) from Prometheus if available
5. Returns all of this as structured JSON for the agent to interpret

Reuses the existing `grafana_query` infrastructure — just adds multi-timepoint queries and structured formatting. The `list-metrics` tool already fetches metadata.

### Files to Create/Modify

| File | Action | What |
|------|--------|------|
| `src/tools/explain-metric.ts` | Create | New `grafana_explain_metric` tool |
| `src/tools/explain-metric.test.ts` | Create | Unit tests |
| `index.ts` | Modify | Register new tool factory |
| `skills/SKILL.md` | Modify | Add tool docs, params, examples |

### Acceptance Criteria

- [x] `grafana_explain_metric` tool registered and available to the agent
- [x] Returns current value, 24h change (%), 7d change (%)
- [x] Returns min/max/avg over requested period
- [x] Includes metric metadata (type, help text, unit) when available
- [x] Supports any PromQL expression, not just metric names
- [x] Agent can compose: explain + share for "show and tell" workflows
- [x] Tests pass: `npx vitest src/tools/explain-metric.test.ts`
- [x] Type check passes: `npx tsc --noEmit`
- [x] SKILL.md updated with params, examples, returns, musts

### Subtasks

- [x] Create `src/tools/explain-metric.ts` with structured multi-query approach
- [x] Implement current value query (instant)
- [x] Implement 24h trend query (range, compute % change)
- [x] Implement 7d trend query (range, compute % change)
- [x] Compute min/max/avg from range query results
- [x] Fetch metric metadata via `/api/v1/metadata` (reuse from `list-metrics` tool)
- [x] Format result as agent-friendly JSON with all context
- [x] Write tests with mocked Prometheus responses
- [x] Register tool in `index.ts`
- [x] Update `skills/SKILL.md`

---

## Summary

| Feature | Effort | Priority | Code Reuse | Key Enabler |
|---------|--------|----------|------------|-------------|
| Loki/LogQL | 4-8h | High | ~90% | Datasource proxy pattern |
| Dashboard Update | 2-3h | High | ~95% | Same `POST /api/dashboards/db` API |
| Explain Metric | 2-3h | Medium-High | ~80% | Existing query infra + metadata |

**Combined**: ~8-14 hours for 3 new capabilities. Together they solve: "I spent $3,600 this month. Why? What broke?" — query logs for errors, explain metric trends, show it all on a dashboard the agent maintains over time.
