# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Working Style

**Always ask clarification questions** using the AskUserQuestion tool when requirements or intent are unclear. Do not assume — pause and ask. This applies to:
- Ambiguous feature requests or design choices
- Unclear scope (what to include/exclude)
- Trade-offs where the user's preference matters
- Any time you're about to make a significant decision that could go multiple ways

**Always update `skills/SKILL.md` when changing tools.** When adding, modifying, or removing agent tools — or changing their parameters, return shapes, or behavior — update SKILL.md to match. This includes:
- Tool params (especially required params and useful optional ones with defaults)
- JSON examples (must be valid calls against the actual tool)
- Returns descriptions (focus on shapes the agent reasons about)
- Musts section (if new composability rules apply)
- Composed workflow examples (if the new tool enables new workflows)
- `references/agent-metrics.md` if metrics change

---

## What Is This Project?

**Grafana Lens** is an OpenClaw extension that gives the AI agent **full, native access to Grafana** — for data visualization, monitoring, alerting, and delivery across 15+ messaging channels. Product spec: `/Users/mangquanshi/workspace/grafana/grafana-lens.md`.

**Core philosophy: Everything is an agent tool.** 17 composable tools (query, query logs, query traces, create dashboard, update dashboard, alert, annotate, share, explore datasources, list metrics, search, get dashboard, check alerts, push metrics, explain metric, security check, investigate). No background automation — agent decides when to use Grafana; Grafana's own engines handle scheduled evaluation and rendering. Works with ANY Grafana datasource, not just `openclaw_lens_*` metrics.

---

## Build & Development Commands

```bash
# Install dependencies
npm install

# Run unit tests
npx vitest

# Run a single test file
npx vitest src/services/metrics-collector.test.ts

# TypeScript type-check (no emit)
npx tsc --noEmit

# Link into OpenClaw for local development
openclaw plugins install -l ~/workspace/grafana-lens

# Restart gateway after config changes
openclaw gateway restart

# Publish to npm
npm publish --access public
```

---

## Architecture: Self-Contained Plugin

All Grafana interaction is handled by the bundled `GrafanaClient` — no external tools or MCP servers required.

```
┌─────────────────────────┐                                ┌────────────────────────┐
│   openclaw/              │                                │   grafana/              │
│   ~/workspace/openclaw   │                                │   ~/workspace/grafana   │
│ REFERENCE:               │                                │ REFERENCE:              │
│ • Plugin SDK types       │                                │ • Dashboard JSON schema │
│ • diagnostics-otel       │                                │ • API endpoint patterns │
│ • Diagnostic event types │                                │ • Feature toggles       │
└─────────────────────────┘                                └────────────────────────┘
         │                                                          │
         └──────────────────────────┬───────────────────────────────┘
                                    │
                    ┌───────────────────────────────────────┐
                    │   grafana-lens/ (THIS REPO)            │
                    │  • GrafanaClient (full REST API)       │
                    │  • MetricsCollector → OTLP push        │
                    │  • 17 agent tools + 10 templates        │
                    │  • Works with ANY Grafana datasource   │
                    └──────────────┬────────────────────────┘
                                   │ OTLP HTTP push
                    ┌──────────────▼────────────────────────┐
                    │   OTel Collector / LGTM stack          │
                    │  • :4318 OTLP HTTP receiver            │
                    │  • Routes to Mimir (metrics)           │
                    └───────────────────────────────────────┘
```

---

## Key Design Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Repo location | Standalone npm package | OpenClaw community model — `openclaw plugins install` |
| Grafana API calls | Bundled GrafanaClient (self-contained) | No external dependencies — no MCP servers |
| Everything is tools | 9 agent tools, no background automation | Agent decides when to act; Grafana handles scheduled evaluation |
| General-purpose | Works with ANY datasource/metric | Not limited to `openclaw_lens_*` metrics |
| Alerting | Grafana-native alert rules | Leverages Grafana's mature alerting engine, contact points, silences |
| Panel rendering | Grafana Image Renderer (not local Vega-Lite) | Keeps dashboards persistent + renderable; graceful fallback: image → snapshot → deep link |
| Image delivery | `MEDIA:<path>` + `{type: "image", data, mimeType}` in AgentToolResult | `imageResult()` not exported from plugin-sdk — construct manually. `MEDIA:` triggers attachment via `splitMediaFromOutput()` in `openclaw/src/media/parse.ts` |
| Render endpoint | `GET /render/d/{uid}?viewPanel={panelId}&kiosk=true` | NOT `/render/d-solo/` — verified from Grafana Image Renderer docs |
| Dashboard templates | 4 AI observability + 5 generic variable-based JSON files | All use `templating.list` for dropdown selectors; AI templates have log-to-trace correlation |
| Alert rule provenance | `X-Disable-Provenance` header on creation | Agent-created rules remain editable in Grafana UI |
| Config DX | Env var fallback: `GRAFANA_URL` + `GRAFANA_SERVICE_ACCOUNT_TOKEN` | Follows Grafana community conventions |
| Multi-instance | Named instances via `grafana.instances[]` array, optional `instance` param on tools | Conditional: param only visible when >1 instance configured; smart default to first/named instance |
| Metrics transport | OTLP HTTP push (`@opentelemetry/sdk-metrics`) | Aligns with LGTM stack; no scrape delay; immediate data availability |
| Extension pattern | Follows diagnostics-otel exactly | Proven pattern, same Plugin SDK |

---

## Reference Codebases — Key Files

### OpenClaw Plugin SDK (`~/workspace/openclaw/`)

**Plugin types** — `src/plugins/types.ts`
- `OpenClawPluginDefinition`: id?, name?, description?, version?, configSchema?, `register(api)`, `activate?()`
- `OpenClawPluginApi`: registerTool, registerService, registerHook, registerHttpHandler, registerHttpRoute, registerChannel, registerGatewayMethod, registerCli, registerProvider, registerCommand, on()
- `OpenClawPluginService`: id, start(ctx), stop?(ctx)
- `OpenClawPluginServiceContext`: config, workspaceDir?, stateDir (required), logger
- `OpenClawPluginToolFactory`: `(ctx: OpenClawPluginToolContext) => AnyAgentTool | AnyAgentTool[] | null | undefined`
- `PluginHookName`: 17 lifecycle hooks

**Diagnostic events** — `src/infra/diagnostic-events.ts`
- `DiagnosticEventPayload`: union of 13 event types
- `onDiagnosticEvent(listener)`: subscribe to all events, returns unsubscribe fn
- `emitDiagnosticEvent(event)`: emit custom events (omits `ts`, `seq`)
- Events: model.usage, webhook.received/processed/error, message.queued/processed, session.state/stuck, queue.lane.enqueue/dequeue, run.attempt, diagnostic.heartbeat, tool.loop

**Plugin SDK exports** — `src/plugin-sdk/index.ts` (root surface slimmed in 2026.3.16)
- Root still exports: `onDiagnosticEvent()`, `emptyPluginConfigSchema()`, types (`OpenClawPluginApi`, `DiagnosticEventPayload`)
- Moved to subpaths: `registerLogTransport` → `plugin-sdk/diagnostics-otel`, types (`OpenClawPluginService`, `OpenClawPluginServiceContext`) → `plugin-sdk/core`
- **Vendored locally** (`src/sdk-compat.ts`): `jsonResult()`, `readStringParam()`, `readNumberParam()` — removed from root, no generic public subpath for external plugins
- **NOT exported**: `OpenClawPluginDefinition`, `OpenClawPluginToolFactory`, `OpenClawPluginHttpRouteHandler`, `imageResult`, `imageResultFromFile`, `ToolInputError`, `sanitizeToolResultImages`

**Reference extension** — `extensions/diagnostics-otel/` (factory function, onDiagnosticEvent subscription, start/stop lifecycle)
**Plugin loader** — `src/plugins/loader.ts`, `src/plugins/discovery.ts` (config → workspace → global → bundled; jiti for TS)
**Cron system** — `src/cron/service.ts` (CronService: start/stop/add/remove/run; CronJobCreate: name, schedule, enabled, command)

### Grafana (`~/workspace/grafana/`)

**Dashboard**: `pkg/api/dashboard.go` (POST /api/dashboards/db, GET /api/dashboards/uid/{uid}) · schema: `packages/grafana-schema/src/schema/dashboard/`
**Annotations**: `pkg/api/annotations.go` (POST /api/annotations, GET /api/annotations)
**Alerting**: `pkg/services/ngalert/api/api_ruler.go` (CRUD /api/v1/provisioning/alert-rules) · definitions: `.../tooling/definitions/provisioning_alert_rules.go`
**Contact points**: `.../tooling/definitions/contact_points.go` (`POST /api/v1/provisioning/contact-points` — webhook config: URL, auth, payload templates)
**Notification policies**: `pkg/services/ngalert/api/api_provisioning.go` (`GET /api/v1/provisioning/policies`)
**Alert state history**: `GET /api/v1/rules/history?ruleUID=&from=&to=`
**Folders**: `pkg/api/folder.go` (POST /api/folders, GET /api/folders)
**Datasource proxy**: `pkg/api/dataproxy.go` (GET /api/datasources/proxy/uid/{uid}/api/v1/query for PromQL)
**Datasource management**: `pkg/api/datasources.go` (GET /api/datasources)
**Metric metadata**: `GET .../api/v1/metadata` via datasource proxy (TYPE, HELP, unit per metric)
**Snapshots**: `POST /api/snapshots` → shareable URL with view/delete keys

---

## OpenClaw Extension Patterns

### Plugin Entry Point
```typescript
// index.ts — must export default plugin object
// Note: OpenClawPluginDefinition is NOT exported from plugin-sdk — use untyped const (matches diagnostics-otel)
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

const plugin = {
  id: "my-plugin",
  name: "My Plugin",
  description: "...",
  register(api: OpenClawPluginApi) {
    api.registerService(createMyService());  // factory function pattern
    api.registerTool(myToolFactory);
    api.registerHttpRoute({ path: "/my-path", handler: myHandler });
    api.on("message_received", myHook);
  },
};
export default plugin;
```

### Service Pattern (Factory Function)
```typescript
import type { OpenClawPluginService, OpenClawPluginServiceContext } from "openclaw/plugin-sdk";

// Services are created via factory functions that return the service object
export function createMyService(): OpenClawPluginService {
  let unsubscribe: (() => void) | null = null;

  return {
    id: "my-service",
    async start(ctx: OpenClawPluginServiceContext) {
      // ctx.config — full OpenClawConfig
      // ctx.logger — { info, warn, error, debug? }
      // ctx.stateDir — persistent state directory (required)
      // ctx.workspaceDir — workspace root (optional)
      unsubscribe = onDiagnosticEvent((evt) => { /* ... */ });
    },
    async stop() {
      unsubscribe?.();  // Always clean up subscriptions
      unsubscribe = null;
    },
  } satisfies OpenClawPluginService;
}
```

### Tool Factory Pattern
```typescript
// Note: OpenClawPluginToolFactory is NOT exported from plugin-sdk — use untyped factory function
import { jsonResult, readStringParam } from "../sdk-compat.js";

// Outer factory creates the client; inner factory receives plugin tool context
function createMyToolFactory(config: MyConfig) {
  const client = new MyClient(config);
  return (_ctx: unknown) => ({
    name: "my_tool",
    label: "My Tool",  // Required by AgentTool interface
    description: "WORKFLOW: Describe when/how to use this tool. Returns X for sharing.",
    parameters: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Human-readable name (e.g., 'My Report')" },
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const name = readStringParam(params, "name", { required: true, label: "Name" });
      try {
        const result = await client.doWork(name);
        return jsonResult({ status: "ok", data: result });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return jsonResult({ error: `Failed to do work: ${reason}` });
      }
    },
  });
}
// Can also return AnyAgentTool[] for multiple tools, or null/undefined
```

### Diagnostic Event Subscription
```typescript
import { onDiagnosticEvent } from "openclaw/plugin-sdk";
import type { DiagnosticEventPayload } from "openclaw/plugin-sdk";

const unsubscribe = onDiagnosticEvent((evt: DiagnosticEventPayload) => {
  switch (evt.type) {
    case "model.usage":       // evt.usage.input/output/cacheRead/cacheWrite, evt.costUsd, evt.model, evt.durationMs
    case "message.processed": // evt.outcome ("completed"|"skipped"|"error"), evt.channel, evt.durationMs
    case "session.state":     // evt.state, evt.prevState, evt.reason, evt.queueDepth
    case "session.stuck":     // evt.state, evt.ageMs (required), evt.queueDepth
    case "webhook.received":  // evt.channel, evt.updateType
    case "webhook.processed": // evt.channel, evt.updateType, evt.durationMs
    case "webhook.error":     // evt.channel, evt.updateType, evt.error (required string)
    case "message.queued":    // evt.source (required), evt.channel, evt.queueDepth
    case "queue.lane.enqueue": // evt.lane, evt.queueSize (both required)
    case "queue.lane.dequeue": // evt.lane, evt.queueSize, evt.waitMs (all required)
    case "run.attempt":       // evt.runId (required), evt.attempt (required number)
    case "diagnostic.heartbeat": // evt.webhooks, evt.active, evt.waiting, evt.queued (all required)
    case "tool.loop":         // evt.level, evt.action, evt.detector, evt.count, evt.message
  }
});
// Call unsubscribe() in stop()
```

### Package Requirements
```json
{
  "type": "module",
  "openclaw": { "extensions": ["./index.ts"] },
  "devDependencies": { "openclaw": "*" }
}
```

### Manifest Requirements (`openclaw.plugin.json`)
```json
{
  "id": "my-plugin",
  "configSchema": { "type": "object", "additionalProperties": false, "properties": {} },
  "skills": ["./skills"],
  "uiHints": { "key": { "label": "...", "sensitive": true } }
}
```

### Test Pattern (from diagnostics-otel)
```typescript
import { beforeEach, describe, expect, test, vi } from "vitest";

// Hoist mocks before imports
const onDiagnosticEventMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk")>("openclaw/plugin-sdk");
  return { ...actual, onDiagnosticEvent: onDiagnosticEventMock };
});

// Import after mocks
import { emitDiagnosticEvent } from "openclaw/plugin-sdk";
import { createMyService } from "./my-service.js";

describe("my service", () => {
  beforeEach(() => { onDiagnosticEventMock.mockReset(); });

  test("subscribes on start, unsubscribes on stop", async () => {
    const unsubscribe = vi.fn();
    onDiagnosticEventMock.mockReturnValue(unsubscribe);
    const service = createMyService();
    await service.start(makeCtx());
    expect(onDiagnosticEventMock).toHaveBeenCalledTimes(1);
    await service.stop?.();
    expect(unsubscribe).toHaveBeenCalled();
  });
});
```

---

## Coding Standards

Verified conventions from openclaw and diagnostics-otel codebases:

- **TypeScript**: Strict mode, ESM (`"type": "module"`), `NodeNext` module resolution for standalone plugins
- **Services**: Factory functions returning `OpenClawPluginService`, closure variables for private state, `satisfies` optional
- **Tool results**: Always use `jsonResult()` from `src/sdk-compat.ts` for consistent serialization
- **Tool interface**: `AgentTool` requires `label` (string) and `execute(_toolCallId: string, params: Record<string, unknown>)` signature
- **Parameter validation**: Use `readStringParam()`/`readNumberParam()` from `src/sdk-compat.ts` instead of raw param access
- **Tool descriptions**: Include `WORKFLOW:` hints for agent usability; parameter descriptions include format examples and valid values
- **Error messages**: Include context + remediation (e.g., `"Grafana authentication failed — check your service account token"`)
- **Tests**: vitest, `vi.hoisted()` + `vi.mock()` pattern, one integration-style test per module minimum
- **Imports**: Named exports preferred, `.js` extensions required in NodeNext resolution

---

## Current Implementation State

All 17 tools in `src/tools/`, 10 templates in `src/templates/`, tests alongside each module. Entry: `index.ts`. Config: `src/config.ts`. Client: `src/grafana-client.ts`. Service: `src/services/metrics-collector.ts`. OTel provider: `src/services/otel-metrics.ts`. Custom metrics: `src/services/custom-metrics-store.ts`. Skill: `skills/SKILL.md` + `skills/references/`.

### Metrics — Two Sources

**Core agent telemetry** (from diagnostics-otel — Grafana Lens queries but does not collect):

| Prometheus Name | Type | Labels |
|----------------|------|--------|
| `openclaw_tokens_total` | counter | openclaw_token, openclaw_model, openclaw_provider, openclaw_channel |
| `openclaw_cost_usd_total` | counter | openclaw_model, openclaw_provider, openclaw_channel |
| `openclaw_run_duration_ms_milliseconds` | histogram | openclaw_model, openclaw_provider, openclaw_channel |
| `openclaw_context_tokens` | histogram | openclaw_context (limit/used), openclaw_model, openclaw_provider, openclaw_channel |
| `openclaw_message_processed_total` | counter | openclaw_outcome, openclaw_channel |
| `openclaw_message_duration_ms_milliseconds` | histogram | openclaw_outcome, openclaw_channel |
| `openclaw_message_queued_total` | counter | openclaw_channel, openclaw_source |
| `openclaw_webhook_received_total` | counter | openclaw_channel, openclaw_webhook |
| `openclaw_webhook_error_total` | counter | openclaw_channel, openclaw_webhook |
| `openclaw_webhook_duration_ms_milliseconds` | histogram | openclaw_channel, openclaw_webhook |
| `openclaw_queue_depth` | histogram | openclaw_lane, openclaw_channel |
| `openclaw_queue_wait_ms_milliseconds` | histogram | openclaw_lane |
| `openclaw_queue_lane_enqueue_total` | counter | openclaw_lane |
| `openclaw_queue_lane_dequeue_total` | counter | openclaw_lane |
| `openclaw_session_state_total` | counter | openclaw_state, openclaw_reason |
| `openclaw_session_stuck_total` | counter | openclaw_state |
| `openclaw_session_stuck_age_ms_milliseconds` | histogram | openclaw_state |
| `openclaw_run_attempt_total` | counter | openclaw_attempt |

Full PromQL reference + alert-worthy conditions: see `skills/references/agent-metrics.md`.

**Operational gauges** (from grafana-lens — unique current-state data):

| Metric | Type | Labels |
|--------|------|--------|
| `openclaw_lens_sessions_active` | gauge | state |
| `openclaw_lens_queue_depth` | gauge | — |
| `openclaw_lens_context_tokens` | gauge | type (limit/used) |
| `openclaw_lens_daily_cost_usd` | gauge | — |
| `openclaw_lens_sessions_active_snapshot` | gauge | — |
| `openclaw_lens_sessions_stuck` | gauge | — |
| `openclaw_lens_stuck_session_max_age_ms` | gauge | — |
| `openclaw_lens_cache_read_ratio` | gauge | — |
| `openclaw_lens_tool_loops_active` | gauge | level (warning/critical) |
| `openclaw_lens_queue_lane_depth` | gauge | lane |
| `openclaw_lens_alert_webhooks_received` | gauge | status (firing/resolved) |
| `openclaw_lens_alert_webhooks_pending` | gauge | — |
| `openclaw_lens_custom_metrics_pushed_total` | counter | — |
| `openclaw_lens_cost_by_token_type` | counter | token_type (input/output/cache_read/cache_write), model, provider |
| `openclaw_lens_session_message_types` | counter | type (user/assistant/tool_call/tool_result/error) |
| `openclaw_lens_cache_savings_usd` | gauge | — |
| `openclaw_lens_session_latency_avg_ms` | gauge | — |
| `openclaw_lens_cache_token_ratio` | gauge | — |
| `openclaw_lens_gateway_restarts` | counter | — |
| `openclaw_lens_session_resets` | counter | reason |
| `openclaw_lens_tool_error_classes` | counter | tool, error_class (network/filesystem/timeout/other) |
| `openclaw_lens_prompt_injection_signals` | counter | detector (input_scan/tool_loop) |
| `openclaw_lens_unique_sessions_1h` | gauge | — |

**Self-sufficient counters/histograms** (from grafana-lens — replicate diagnostics-otel for independence):

| Metric | Type | Labels |
|--------|------|--------|
| `openclaw_lens_tokens_total` | counter | token (input/output/cacheRead/cacheWrite), provider, model |
| `openclaw_lens_messages_processed_total` | counter | outcome (completed/skipped/error), channel |
| `openclaw_lens_webhook_received_total` | counter | channel, update_type |
| `openclaw_lens_webhook_error_total` | counter | channel, update_type |
| `openclaw_lens_webhook_duration_ms_bucket` | histogram | channel, update_type |
| `openclaw_lens_queue_lane_enqueue_total` | counter | lane |
| `openclaw_lens_queue_lane_dequeue_total` | counter | lane |
| `openclaw_lens_queue_wait_ms_bucket` | histogram | lane |

### Phase Progress

| Phase | Description | Status |
|-------|-------------|--------|
| ~~1~~ | Metrics Collection (MetricsCollector + OTLP push) | Done |
| ~~2~~ | Dashboard Templates (3 JSON templates) | Done |
| ~~3~~ | Create Dashboard Tool (`grafana_create_dashboard`) | Done |
| ~~A~~ | GrafanaClient full API surface (query, alert, annotate, folder, datasource) | Done |
| ~~B~~ | Full agent tool suite (8 additional tools: query, alert, share, annotate, explore, list-metrics, search, get-dashboard) | Done |
| ~~C~~ | Dynamic dashboard generation + general-purpose templates | Done |
| ~~D~~ | Alert-Response Loop (webhook contact point → agent investigates) | Done |
| ~~E~~ | External data observatory — custom metrics push (calendar, git, health, finance → Grafana) | Done (E.1) |

---

## Remaining Phases

### Phase E.2: Cross-Plugin Data Integration (Future)

**Goal**: Other OpenClaw skills (calendar, git, tasks, health, finance) automatically push data to Grafana.

**Approach**: Other plugins call `grafana_push_metrics` or register custom metric providers.

**Example life dashboards**:
- Weekly Work Review: calendar events + git commits + task completions
- Health & Fitness: Apple Health + Strava data
- Financial Overview: bank APIs + expense tracking
- Content Creator: YouTube + social media metrics
- Team Health: PR review times, Slack sentiment, velocity

**Technical options**:
- Other plugins call `grafana_push_metrics` from their own tool logic
- Add Prometheus remote write support for external data sources
- Custom Grafana datasource plugin (longer term)

---

## Configuration Reference

### OpenClaw Plugin Config (`~/.openclaw/openclaw.json`)
```jsonc
{
  "plugins": {
    "entries": {
      "openclaw-grafana-lens": {
        "enabled": true,
        "config": {
          // Single instance (legacy — still works):
          "grafana": {
            "url": "http://localhost:3000",    // or set GRAFANA_URL env var
            "apiKey": "glsa_xxxxxxxxxxxx",     // or set GRAFANA_SERVICE_ACCOUNT_TOKEN env var
            "orgId": 1                         // optional, default 1
          },
          // Multi-instance (new):
          // "grafana": {
          //   "instances": [
          //     { "name": "dev", "url": "http://dev:3000", "apiKey": "glsa_dev_xxx" },
          //     { "name": "prd", "url": "http://prd:3000", "apiKey": "glsa_prd_xxx" }
          //   ],
          //   "default": "dev"  // optional, first entry if omitted
          // },
          "metrics": {
            "enabled": true                    // default true
          },
          "otlp": {                            // OTLP metrics push (optional — defaults to LGTM collector)
            "endpoint": "http://localhost:4318/v1/metrics",  // or set OTEL_EXPORTER_OTLP_ENDPOINT
            "headers": {},                     // or set OTEL_EXPORTER_OTLP_HEADERS
            "exportIntervalMs": 15000          // default 15000
          },
          "proactive": {                       // Alert webhook handler
            "enabled": false,                  // Enable to receive Grafana alert webhooks
            "costAlertThreshold": 5.0          // default 5.0 USD
          },
          "customMetrics": {                   // External data observatory
            "enabled": true,                   // default true
            "maxMetrics": 100,                 // max custom metric definitions
            "maxLabelsPerMetric": 5,           // max label keys per metric
            "maxLabelValues": 50,              // max unique label combos per metric
            "defaultTtlDays": null             // optional auto-expiry (days)
          }
        }
      }
    }
  }
}
```

### LGTM Stack Local Setup (Recommended)
```bash
# Start LGTM stack (Grafana + Mimir + Loki + Tempo + OTel Collector)
cd ~/workspace/docker-otel-lgtm && docker run -p 3000:3000 -p 4317:4317 -p 4318:4318 -p 9090:9090 grafana/otel-lgtm:latest
# Default: admin/admin at http://localhost:3000
# Service account: Admin > Service Accounts > Create > Add token (Editor role)
# OTLP collector at :4318 — metrics auto-pushed, no scrape config needed
```

---

## Agent Tools

| Tool | What It Does | When Agent Uses It |
|------|-------------|-------------------|
| `grafana_create_dashboard` | Create dashboard from template or custom JSON spec. AI templates: llm-command-center, session-explorer, cost-intelligence, tool-performance | "Create a dashboard for X" / "Set up monitoring" |
| `grafana_update_dashboard` | Add/remove/update panels or change dashboard metadata | "Add a panel to my dashboard" |
| `grafana_query` | Run PromQL instant/range queries against any Prometheus datasource | "What's my token usage today?" |
| `grafana_query_logs` | Run LogQL queries against any Loki datasource | "Find error logs in the last hour" |
| `grafana_create_alert` | Create Grafana-native alert rules with PromQL conditions | "Alert me if daily cost > $5" |
| `grafana_share_dashboard` | Render panels as PNG → MEDIA: delivery to messaging channels | "Show me a chart of my costs" |
| `grafana_annotate` | Create/query annotations on dashboards | "Mark that deployment on my dashboard" |
| `grafana_explore_datasources` | Discover datasources configured in Grafana | "What data sources do I have?" |
| `grafana_list_metrics` | Discover available metrics from any Prometheus datasource | "What metrics are available?" |
| `grafana_search` | Search existing dashboards by title/tag | "Do I have a cost dashboard?" |
| `grafana_get_dashboard` | Get compact dashboard summary (panels, queries, datasources) | "What panels are on my overview?" |
| `grafana_check_alerts` | Check, acknowledge, or set up Grafana alert webhook notifications | "Are there any alerts firing?" |
| `grafana_push_metrics` | Push custom data (calendar, git, fitness, finance) via OTLP | "Track my daily steps in Grafana" |
| `grafana_explain_metric` | Get metric context: current value, trend, stats, metadata | "What does this metric mean?" / "Why did my bill spike?" |
| `grafana_security_check` | Run 6 parallel security checks, return threat assessment (green/yellow/red) | "Am I being attacked?" / "Security status" / "Security audit" |
| `grafana_query_traces` | Run TraceQL queries against Tempo — search traces or get full trace by ID | "Find slow traces" / "Show trace for session X" / "Debug distributed spans" |
| `grafana_investigate` | Multi-signal investigation triage — metrics, logs, traces, context in parallel with hypothesis generation | "Investigate this alert" / "What's wrong?" / "Triage" / "Root cause" |
