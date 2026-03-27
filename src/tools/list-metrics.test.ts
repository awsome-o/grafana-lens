import { beforeEach, describe, expect, test, vi } from "vitest";

// ── Hoisted mocks ────────────────────────────────────────────────────

const listMetricNamesMock = vi.hoisted(() => vi.fn());
const listLabelValuesMock = vi.hoisted(() => vi.fn());
const getMetricMetadataMock = vi.hoisted(() => vi.fn());

vi.mock("../grafana-client.js", async () => {
  const actual = await vi.importActual<typeof import("../grafana-client.js")>("../grafana-client.js");
  return {
    ...actual,
    GrafanaClient: class {
      listMetricNames = listMetricNamesMock;
      listLabelValues = listLabelValuesMock;
      getMetricMetadata = getMetricMetadataMock;
      getUrl() { return "http://localhost:3000"; }
    },
  };
});

// ── Imports (after mocks) ────────────────────────────────────────────

import { createListMetricsToolFactory, categorizeMetric, PURPOSE_CATEGORIES, deduplicateAndEnrich, KNOWN_LENS_METRICS } from "./list-metrics.js";
import type { MetricPurpose } from "./list-metrics.js";
import type { ValidatedGrafanaLensConfig } from "../config.js";
import { GrafanaClientRegistry } from "../grafana-client-registry.js";

function makeConfig(): ValidatedGrafanaLensConfig {
  return {
    grafana: {
      instances: { default: { url: "http://localhost:3000", apiKey: "test-key" } },
      defaultInstance: "default",
    },
  } as ValidatedGrafanaLensConfig;
}

function makeRegistry(): GrafanaClientRegistry {
  return new GrafanaClientRegistry(makeConfig());
}

function getTextContent(result: { content: Array<{ type: string; text?: string }> }): string {
  const first = result.content[0];
  if (first.type === "text" && first.text) return first.text;
  throw new Error("Expected text content");
}

describe("grafana_list_metrics tool", () => {
  beforeEach(() => {
    listMetricNamesMock.mockReset();
    listLabelValuesMock.mockReset();
    getMetricMetadataMock.mockReset();
  });

  test("lists metric names", async () => {
    listMetricNamesMock.mockResolvedValueOnce(["up", "openclaw_lens_tokens_total", "openclaw_lens_cost_usd_total"]);

    const tool = createListMetricsToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-1", { datasourceUid: "prom1" });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.status).toBe("success");
    expect(parsed.count).toBe(3);
    expect(parsed.metrics).toContain("up");
  });

  test("filters by prefix via server-side match[]", async () => {
    // Server-side filtering: mock returns only matching results
    listMetricNamesMock.mockResolvedValueOnce(["openclaw_lens_tokens_total", "openclaw_lens_cost_usd_total"]);

    const tool = createListMetricsToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-2", { datasourceUid: "prom1", prefix: "openclaw_lens_" });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.count).toBe(2);
    expect(parsed.metrics).not.toContain("up");
    expect(parsed.prefix).toBe("openclaw_lens_");
    // Verify match[] was passed to client
    expect(listMetricNamesMock).toHaveBeenCalledWith("prom1", { match: '{__name__=~"openclaw_lens_.*"}' });
  });

  test("truncates to 200 metrics", async () => {
    const manyMetrics = Array.from({ length: 300 }, (_, i) => `metric_${i}`);
    listMetricNamesMock.mockResolvedValueOnce(manyMetrics);

    const tool = createListMetricsToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-3", { datasourceUid: "prom1" });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.count).toBe(200);
    expect(parsed.totalCount).toBe(300);
    expect(parsed.truncated).toBe(true);
  });

  test("label mode returns label values", async () => {
    listLabelValuesMock.mockResolvedValueOnce(["prometheus:9090", "node-exporter:9100"]);

    const tool = createListMetricsToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-4", { datasourceUid: "prom1", label: "instance" });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.label).toBe("instance");
    expect(parsed.values).toHaveLength(2);
    expect(listMetricNamesMock).not.toHaveBeenCalled();
  });

  test("API error caught gracefully", async () => {
    listMetricNamesMock.mockRejectedValueOnce(new Error("Not found: list metric names"));

    const tool = createListMetricsToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-5", { datasourceUid: "bad-uid" });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.error).toContain("Failed to list metrics");
  });

  // ── Metadata mode tests ─────────────────────────────────────────

  test("metadata mode returns enriched objects with type and help", async () => {
    getMetricMetadataMock.mockResolvedValueOnce({
      up: [{ type: "gauge", help: "Target is up", unit: "" }],
      http_requests_total: [{ type: "counter", help: "Total HTTP requests", unit: "" }],
    });

    const tool = createListMetricsToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-m1", { datasourceUid: "prom1", metadata: true });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.status).toBe("success");
    expect(parsed.count).toBe(2);
    expect(parsed.metrics[0]).toHaveProperty("name");
    expect(parsed.metrics[0]).toHaveProperty("type");
    expect(parsed.metrics[0]).toHaveProperty("help");
    expect(listMetricNamesMock).not.toHaveBeenCalled();
  });

  test("metadata mode with prefix filter uses server-side intersection", async () => {
    // Server-side listMetricNames returns matching names for intersection
    listMetricNamesMock.mockResolvedValueOnce(["http_requests_total", "http_request_duration_seconds"]);
    getMetricMetadataMock.mockResolvedValueOnce({
      up: [{ type: "gauge", help: "Target is up", unit: "" }],
      http_requests_total: [{ type: "counter", help: "Total HTTP requests", unit: "" }],
      http_request_duration_seconds: [{ type: "histogram", help: "HTTP request duration", unit: "" }],
    });

    const tool = createListMetricsToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-m2", { datasourceUid: "prom1", metadata: true, prefix: "http_" });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.count).toBe(2);
    expect(parsed.prefix).toBe("http_");
    expect(parsed.metrics.every((m: { name: string }) => m.name.startsWith("http_"))).toBe(true);
    expect(listMetricNamesMock).toHaveBeenCalledWith("prom1", { match: '{__name__=~"http_.*"}' });
  });

  test("metadata mode truncates at 200", async () => {
    const bigMeta: Record<string, Array<{ type: string; help: string; unit: string }>> = {};
    for (let i = 0; i < 300; i++) {
      bigMeta[`metric_${i}`] = [{ type: "gauge", help: `Metric ${i}`, unit: "" }];
    }
    getMetricMetadataMock.mockResolvedValueOnce(bigMeta);

    const tool = createListMetricsToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-m3", { datasourceUid: "prom1", metadata: true });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.count).toBe(200);
    expect(parsed.totalCount).toBe(300);
    expect(parsed.truncated).toBe(true);
  });

  test("label mode ignores metadata flag", async () => {
    listLabelValuesMock.mockResolvedValueOnce(["val1", "val2"]);

    const tool = createListMetricsToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-m4", { datasourceUid: "prom1", label: "job", metadata: true });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.label).toBe("job");
    expect(parsed.values).toHaveLength(2);
    expect(getMetricMetadataMock).not.toHaveBeenCalled();
  });

  // ── Search param tests ─────────────────────────────────────────

  test("search param constructs match[] regex", async () => {
    listMetricNamesMock.mockResolvedValueOnce(["openclaw_ext_steps_today", "openclaw_ext_steps_weekly"]);

    const tool = createListMetricsToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-s1", { datasourceUid: "prom1", search: "steps" });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.count).toBe(2);
    expect(parsed.search).toBe("steps");
    expect(listMetricNamesMock).toHaveBeenCalledWith("prom1", { match: '{__name__=~".*steps.*"}' });
  });

  test("search + prefix combined into single match[]", async () => {
    listMetricNamesMock.mockResolvedValueOnce(["openclaw_ext_fitness_steps"]);

    const tool = createListMetricsToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-s2", { datasourceUid: "prom1", prefix: "openclaw_ext_", search: "fitness" });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.count).toBe(1);
    expect(parsed.prefix).toBe("openclaw_ext_");
    expect(parsed.search).toBe("fitness");
    expect(listMetricNamesMock).toHaveBeenCalledWith("prom1", { match: '{__name__=~"openclaw_ext_.*fitness.*"}' });
  });

  test("metadata mode with search filters by name and help text", async () => {
    listMetricNamesMock.mockResolvedValueOnce(["openclaw_ext_steps_today"]);
    getMetricMetadataMock.mockResolvedValueOnce({
      openclaw_ext_steps_today: [{ type: "gauge", help: "Daily step count", unit: "" }],
      openclaw_ext_weight_kg: [{ type: "gauge", help: "Body weight in kg", unit: "" }],
      openclaw_ext_walk_distance: [{ type: "gauge", help: "Walking distance with step tracker", unit: "" }],
    });

    const tool = createListMetricsToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-s3", { datasourceUid: "prom1", metadata: true, search: "step" });

    const parsed = JSON.parse(getTextContent(result));
    // Should find: steps_today (by name via server-side), walk_distance (by help text "step tracker")
    expect(parsed.count).toBe(2);
    expect(parsed.search).toBe("step");
    const names = parsed.metrics.map((m: { name: string }) => m.name).sort();
    expect(names).toEqual(["openclaw_ext_steps_today", "openclaw_ext_walk_distance"]);
  });

  test("search escapes special regex characters", async () => {
    listMetricNamesMock.mockResolvedValue([]);

    const tool = createListMetricsToolFactory(makeRegistry())({} as never);
    await tool!.execute("call-s4", { datasourceUid: "prom1", search: "foo.bar+baz" });

    expect(listMetricNamesMock).toHaveBeenCalledWith("prom1", { match: '{__name__=~".*foo\\.bar\\+baz.*"}' });
  });

  // ── Custom metrics metadata merge tests ────────────────────────────

  test("custom metrics appear in metadata mode when Prometheus has none", async () => {
    getMetricMetadataMock.mockResolvedValueOnce({});
    listMetricNamesMock.mockResolvedValueOnce([]); // OTLP fallback lists names

    const mockStore = {
      listMetrics: () => [
        { name: "openclaw_ext_steps_today", type: "gauge", help: "Daily step count", labelNames: ["source"], createdAt: 0, updatedAt: 0 },
        { name: "openclaw_ext_weight_kg", type: "gauge", help: "Body weight", labelNames: [], createdAt: 0, updatedAt: 0 },
      ],
    };
    const getStore = () => mockStore as never;

    const tool = createListMetricsToolFactory(makeRegistry(), getStore)({} as never);
    const result = await tool!.execute("call-cm1", { datasourceUid: "prom1", metadata: true });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.status).toBe("success");
    expect(parsed.count).toBe(2);
    const names = parsed.metrics.map((m: { name: string }) => m.name).sort();
    expect(names).toEqual(["openclaw_ext_steps_today", "openclaw_ext_weight_kg"]);
    expect(parsed.metrics[0].source).toBe("custom");
    expect(parsed.metrics[0].labelNames).toBeDefined();
  });

  test("Prometheus wins on overlap — no duplicates", async () => {
    getMetricMetadataMock.mockResolvedValueOnce({
      openclaw_ext_steps_today: [{ type: "gauge", help: "Prometheus scraped version", unit: "" }],
    });

    const mockStore = {
      listMetrics: () => [
        { name: "openclaw_ext_steps_today", type: "gauge", help: "Custom store version", labelNames: [], createdAt: 0, updatedAt: 0 },
        { name: "openclaw_ext_unique_custom", type: "gauge", help: "Only in custom store", labelNames: [], createdAt: 0, updatedAt: 0 },
      ],
    };
    const getStore = () => mockStore as never;

    const tool = createListMetricsToolFactory(makeRegistry(), getStore)({} as never);
    const result = await tool!.execute("call-cm2", { datasourceUid: "prom1", metadata: true });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.count).toBe(2);
    const stepsEntry = parsed.metrics.find((m: { name: string }) => m.name === "openclaw_ext_steps_today");
    expect(stepsEntry.help).toBe("Prometheus scraped version");
    expect(stepsEntry.source).toBeUndefined(); // Prometheus entry, no source tag
    const customEntry = parsed.metrics.find((m: { name: string }) => m.name === "openclaw_ext_unique_custom");
    expect(customEntry.source).toBe("custom");
  });

  test("search/prefix filters apply to custom metrics", async () => {
    getMetricMetadataMock.mockResolvedValueOnce({});
    listMetricNamesMock.mockResolvedValueOnce([]);

    const mockStore = {
      listMetrics: () => [
        { name: "openclaw_ext_steps_today", type: "gauge", help: "Daily steps", labelNames: [], createdAt: 0, updatedAt: 0 },
        { name: "openclaw_ext_weight_kg", type: "gauge", help: "Body weight", labelNames: [], createdAt: 0, updatedAt: 0 },
      ],
    };
    const getStore = () => mockStore as never;

    const tool = createListMetricsToolFactory(makeRegistry(), getStore)({} as never);
    const result = await tool!.execute("call-cm3", { datasourceUid: "prom1", metadata: true, search: "steps" });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.count).toBe(1);
    expect(parsed.metrics[0].name).toBe("openclaw_ext_steps_today");
  });

  test("backward compatible — factory without store works unchanged", async () => {
    getMetricMetadataMock.mockResolvedValueOnce({
      up: [{ type: "gauge", help: "Target is up", unit: "" }],
    });

    // No store parameter — original behavior
    const tool = createListMetricsToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-cm4", { datasourceUid: "prom1", metadata: true });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.status).toBe("success");
    expect(parsed.count).toBe(1);
    expect(parsed.metrics[0].name).toBe("up");
  });

  // ── Category enrichment tests ─────────────────────────────────────

  test("metadata mode adds category to openclaw_lens_ metrics", async () => {
    getMetricMetadataMock.mockResolvedValueOnce({
      openclaw_lens_tokens_total: [{ type: "counter", help: "Token usage", unit: "" }],
      openclaw_lens_cost_by_token_type_total: [{ type: "counter", help: "Cost breakdown", unit: "" }],
      openclaw_lens_sessions_active: [{ type: "gauge", help: "Active sessions", unit: "" }],
      openclaw_lens_queue_depth: [{ type: "gauge", help: "Queue depth", unit: "" }],
      openclaw_lens_tool_calls_total: [{ type: "counter", help: "Tool calls", unit: "" }],
      up: [{ type: "gauge", help: "Target is up", unit: "" }],
    });

    const tool = createListMetricsToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-cat1", { datasourceUid: "prom1", metadata: true });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.count).toBe(6);

    const byName = Object.fromEntries(parsed.metrics.map((m: { name: string; category?: string }) => [m.name, m.category]));
    expect(byName["openclaw_lens_tokens_total"]).toBe("usage");
    expect(byName["openclaw_lens_cost_by_token_type_total"]).toBe("cost");
    expect(byName["openclaw_lens_sessions_active"]).toBe("session");
    expect(byName["openclaw_lens_queue_depth"]).toBe("queue");
    expect(byName["openclaw_lens_tool_calls_total"]).toBe("tools");
    expect(byName["up"]).toBeUndefined(); // non-openclaw → no category
  });

  test("metadata mode includes categorySummary", async () => {
    getMetricMetadataMock.mockResolvedValueOnce({
      openclaw_lens_tokens_total: [{ type: "counter", help: "Token usage", unit: "" }],
      openclaw_lens_context_tokens: [{ type: "gauge", help: "Context tokens", unit: "" }],
      openclaw_lens_cost_by_token_type_total: [{ type: "counter", help: "Cost", unit: "" }],
      openclaw_lens_sessions_active: [{ type: "gauge", help: "Sessions", unit: "" }],
    });

    const tool = createListMetricsToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-cat2", { datasourceUid: "prom1", metadata: true });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.categorySummary).toBeDefined();
    expect(parsed.categorySummary.usage).toBe(2);
    expect(parsed.categorySummary.cost).toBe(1);
    expect(parsed.categorySummary.session).toBe(1);
  });

  test("categorySummary omitted when no openclaw metrics present", async () => {
    getMetricMetadataMock.mockResolvedValueOnce({
      up: [{ type: "gauge", help: "Target is up", unit: "" }],
      node_cpu_seconds_total: [{ type: "counter", help: "CPU seconds", unit: "" }],
    });

    const tool = createListMetricsToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-cat3", { datasourceUid: "prom1", metadata: true });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.categorySummary).toBeUndefined();
  });

  test("custom store metrics get category 'custom'", async () => {
    getMetricMetadataMock.mockResolvedValueOnce({});
    listMetricNamesMock.mockResolvedValueOnce([]); // OTLP fallback lists names

    const mockStore = {
      listMetrics: () => [
        { name: "openclaw_ext_meditation_minutes", type: "gauge", help: "Daily meditation", labelNames: [], createdAt: 0, updatedAt: 0 },
      ],
    };
    const getStore = () => mockStore as never;

    const tool = createListMetricsToolFactory(makeRegistry(), getStore)({} as never);
    const result = await tool!.execute("call-cat4", { datasourceUid: "prom1", metadata: true });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.metrics[0].category).toBe("custom");
    expect(parsed.categorySummary).toEqual({ custom: 1 });
  });

  // ── Compact mode tests ──────────────────────────────────────────

  test("compact mode returns only name, type, category — drops help, source, labelNames", async () => {
    getMetricMetadataMock.mockResolvedValueOnce({
      openclaw_lens_tokens_total: [{ type: "counter", help: "Token usage across all models", unit: "" }],
      openclaw_lens_sessions_active: [{ type: "gauge", help: "Currently active sessions", unit: "" }],
      up: [{ type: "gauge", help: "Target is up", unit: "" }],
    });

    const tool = createListMetricsToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-compact1", { datasourceUid: "prom1", metadata: true, compact: true });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.status).toBe("success");
    expect(parsed.count).toBe(3);

    // Compact entries should have name and type, category only for openclaw metrics
    const tokens = parsed.metrics.find((m: { name: string }) => m.name === "openclaw_lens_tokens_total");
    expect(tokens.name).toBe("openclaw_lens_tokens_total");
    expect(tokens.type).toBe("counter");
    expect(tokens.category).toBe("usage");
    expect(tokens.help).toBeUndefined();
    expect(tokens.source).toBeUndefined();
    expect(tokens.labelNames).toBeUndefined();

    const upMetric = parsed.metrics.find((m: { name: string }) => m.name === "up");
    expect(upMetric.name).toBe("up");
    expect(upMetric.type).toBe("gauge");
    expect(upMetric.category).toBeUndefined(); // non-openclaw
    expect(upMetric.help).toBeUndefined();
  });

  test("compact mode preserves categorySummary", async () => {
    getMetricMetadataMock.mockResolvedValueOnce({
      openclaw_lens_cost_by_token_type_total: [{ type: "counter", help: "Cost", unit: "" }],
      openclaw_lens_sessions_active: [{ type: "gauge", help: "Sessions", unit: "" }],
    });

    const tool = createListMetricsToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-compact2", { datasourceUid: "prom1", metadata: true, compact: true });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.categorySummary).toEqual({ cost: 1, session: 1 });
  });

  test("compact mode with custom metrics store drops source and labelNames", async () => {
    getMetricMetadataMock.mockResolvedValueOnce({});
    listMetricNamesMock.mockResolvedValueOnce([]); // OTLP fallback lists names

    const mockStore = {
      listMetrics: () => [
        { name: "openclaw_ext_steps_today", type: "gauge", help: "Daily steps", labelNames: ["source"], createdAt: 0, updatedAt: 0 },
      ],
    };
    const getStore = () => mockStore as never;

    const tool = createListMetricsToolFactory(makeRegistry(), getStore)({} as never);
    const result = await tool!.execute("call-compact3", { datasourceUid: "prom1", metadata: true, compact: true });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.count).toBe(1);
    expect(parsed.metrics[0].name).toBe("openclaw_ext_steps_today");
    expect(parsed.metrics[0].type).toBe("gauge");
    expect(parsed.metrics[0].category).toBe("custom");
    expect(parsed.metrics[0].help).toBeUndefined();
    expect(parsed.metrics[0].source).toBeUndefined();
    expect(parsed.metrics[0].labelNames).toBeUndefined();
  });

  test("compact without metadata is ignored — returns name-only list as usual", async () => {
    listMetricNamesMock.mockResolvedValueOnce(["up", "openclaw_lens_tokens_total"]);

    const tool = createListMetricsToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-compact4", { datasourceUid: "prom1", compact: true });

    const parsed = JSON.parse(getTextContent(result));
    // Without metadata=true, compact has no effect — returns name strings
    expect(parsed.metrics).toEqual(["up", "openclaw_lens_tokens_total"]);
  });

  test("core openclaw_ metrics (non-lens) get categories", async () => {
    getMetricMetadataMock.mockResolvedValueOnce({
      openclaw_tokens_total: [{ type: "counter", help: "Core token usage", unit: "" }],
      openclaw_session_state_total: [{ type: "counter", help: "Session state changes", unit: "" }],
      openclaw_run_duration_ms_milliseconds_bucket: [{ type: "histogram", help: "Run duration", unit: "" }],
    });

    const tool = createListMetricsToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-cat5", { datasourceUid: "prom1", metadata: true });

    const parsed = JSON.parse(getTextContent(result));
    const byName = Object.fromEntries(parsed.metrics.map((m: { name: string; category?: string }) => [m.name, m.category]));
    expect(byName["openclaw_tokens_total"]).toBe("usage");
    expect(byName["openclaw_session_state_total"]).toBe("session");
    expect(byName["openclaw_run_duration_ms_milliseconds_bucket"]).toBe("agent");
  });
});

// ── Purpose filter tests ──────────────────────────────────────────────

describe("purpose filter", () => {
  beforeEach(() => {
    listMetricNamesMock.mockReset();
    listLabelValuesMock.mockReset();
    getMetricMetadataMock.mockReset();
  });

  test("purpose=performance returns only session + tools metrics (name mode)", async () => {
    listMetricNamesMock.mockResolvedValueOnce([
      "openclaw_lens_sessions_active",
      "openclaw_lens_session_latency_avg_ms",
      "openclaw_lens_tool_calls_total",
      "openclaw_lens_cost_by_token_type_total",
      "openclaw_lens_queue_depth",
      "openclaw_lens_webhook_received_total",
    ]);

    const tool = createListMetricsToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-p1", { datasourceUid: "prom1", purpose: "performance" });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.status).toBe("success");
    expect(parsed.purpose).toBe("performance");
    expect(parsed.count).toBe(3);
    expect(parsed.metrics).toContain("openclaw_lens_sessions_active");
    expect(parsed.metrics).toContain("openclaw_lens_session_latency_avg_ms");
    expect(parsed.metrics).toContain("openclaw_lens_tool_calls_total");
    expect(parsed.metrics).not.toContain("openclaw_lens_cost_by_token_type_total");
    // Auto-injects openclaw_ prefix
    expect(listMetricNamesMock).toHaveBeenCalledWith("prom1", { match: '{__name__=~"openclaw_.*"}' });
  });

  test("purpose=cost returns cost + usage metrics (metadata mode), skips listMetricNames", async () => {
    // Purpose-only metadata mode: no listMetricNames call (auto-injected prefix
    // narrowing is handled client-side by the purpose category filter)
    getMetricMetadataMock.mockResolvedValueOnce({
      openclaw_lens_cost_by_token_type_total: [{ type: "counter", help: "Cost breakdown", unit: "" }],
      openclaw_lens_tokens_total: [{ type: "counter", help: "Token usage", unit: "" }],
      openclaw_lens_sessions_active: [{ type: "gauge", help: "Active sessions", unit: "" }],
      openclaw_lens_queue_depth: [{ type: "gauge", help: "Queue depth", unit: "" }],
    });

    const tool = createListMetricsToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-p2", { datasourceUid: "prom1", purpose: "cost", metadata: true });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.purpose).toBe("cost");
    expect(parsed.count).toBe(2);
    const names = parsed.metrics.map((m: { name: string }) => m.name).sort();
    expect(names).toEqual(["openclaw_lens_cost_by_token_type_total", "openclaw_lens_tokens_total"]);
    expect(parsed.categorySummary).toEqual({ cost: 1, usage: 1 });
    // Verify no redundant listMetricNames call
    expect(listMetricNamesMock).not.toHaveBeenCalled();
  });

  test("purpose=reliability returns webhook + messaging + agent metrics", async () => {
    listMetricNamesMock.mockResolvedValueOnce([
      "openclaw_lens_webhook_received_total",
      "openclaw_lens_messages_processed_total",
      "openclaw_lens_run_duration_ms_bucket",
      "openclaw_lens_cost_by_token_type_total",
    ]);

    const tool = createListMetricsToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-p3", { datasourceUid: "prom1", purpose: "reliability" });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.purpose).toBe("reliability");
    expect(parsed.count).toBe(3);
    expect(parsed.metrics).toContain("openclaw_lens_webhook_received_total");
    expect(parsed.metrics).toContain("openclaw_lens_messages_processed_total");
    expect(parsed.metrics).toContain("openclaw_lens_run_duration_ms_bucket");
  });

  test("purpose=capacity returns queue + session metrics", async () => {
    listMetricNamesMock.mockResolvedValueOnce([
      "openclaw_lens_queue_depth",
      "openclaw_lens_queue_lane_depth",
      "openclaw_lens_sessions_active",
      "openclaw_lens_tokens_total",
    ]);

    const tool = createListMetricsToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-p4", { datasourceUid: "prom1", purpose: "capacity" });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.purpose).toBe("capacity");
    expect(parsed.count).toBe(3);
    expect(parsed.metrics).toContain("openclaw_lens_queue_depth");
    expect(parsed.metrics).toContain("openclaw_lens_queue_lane_depth");
    expect(parsed.metrics).toContain("openclaw_lens_sessions_active");
    expect(parsed.metrics).not.toContain("openclaw_lens_tokens_total");
  });

  test("invalid purpose returns actionable error", async () => {
    const tool = createListMetricsToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-p5", { datasourceUid: "prom1", purpose: "banana" });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.error).toContain("Invalid purpose 'banana'");
    expect(parsed.error).toContain("performance, cost, reliability, capacity");
    expect(listMetricNamesMock).not.toHaveBeenCalled();
  });

  test("purpose preserves explicit prefix (no auto-inject)", async () => {
    listMetricNamesMock.mockResolvedValueOnce([
      "openclaw_lens_sessions_active",
      "openclaw_lens_session_latency_avg_ms",
    ]);

    const tool = createListMetricsToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-p6", { datasourceUid: "prom1", purpose: "performance", prefix: "openclaw_lens_" });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.count).toBe(2);
    // Uses explicit prefix, not auto-injected
    expect(listMetricNamesMock).toHaveBeenCalledWith("prom1", { match: '{__name__=~"openclaw_lens_.*"}' });
  });

  test("purpose composes with search", async () => {
    listMetricNamesMock.mockResolvedValueOnce([
      "openclaw_lens_session_latency_avg_ms",
    ]);

    const tool = createListMetricsToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-p7", { datasourceUid: "prom1", purpose: "performance", search: "latency" });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.count).toBe(1);
    expect(parsed.metrics[0]).toBe("openclaw_lens_session_latency_avg_ms");
    // Auto-injected openclaw_ prefix + search
    expect(listMetricNamesMock).toHaveBeenCalledWith("prom1", { match: '{__name__=~"openclaw_.*latency.*"}' });
  });

  test("purpose ignored in label mode", async () => {
    listLabelValuesMock.mockResolvedValueOnce(["val1", "val2"]);

    const tool = createListMetricsToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-p8", { datasourceUid: "prom1", label: "job", purpose: "performance" });

    const parsed = JSON.parse(getTextContent(result));
    // Label mode takes precedence — purpose is silently ignored
    expect(parsed.label).toBe("job");
    expect(parsed.values).toHaveLength(2);
    expect(listMetricNamesMock).not.toHaveBeenCalled();
  });
});

// ── PURPOSE_CATEGORIES mapping tests ──────────────────────────────────

describe("PURPOSE_CATEGORIES", () => {
  test("performance maps to session + tools", () => {
    expect(PURPOSE_CATEGORIES.performance).toEqual(new Set(["session", "tools"]));
  });

  test("cost maps to cost + usage", () => {
    expect(PURPOSE_CATEGORIES.cost).toEqual(new Set(["cost", "usage"]));
  });

  test("reliability maps to webhook + messaging + agent", () => {
    expect(PURPOSE_CATEGORIES.reliability).toEqual(new Set(["webhook", "messaging", "agent"]));
  });

  test("capacity maps to queue + session", () => {
    expect(PURPOSE_CATEGORIES.capacity).toEqual(new Set(["queue", "session"]));
  });

  test("all 4 purposes are defined", () => {
    const purposes: MetricPurpose[] = ["performance", "cost", "reliability", "capacity"];
    for (const p of purposes) {
      expect(PURPOSE_CATEGORIES[p]).toBeDefined();
    }
  });
});

// ── categorizeMetric() unit tests ─────────────────────────────────────

describe("categorizeMetric", () => {
  test("returns undefined for non-openclaw metrics", () => {
    expect(categorizeMetric("up")).toBeUndefined();
    expect(categorizeMetric("node_cpu_seconds_total")).toBeUndefined();
    expect(categorizeMetric("http_requests_total")).toBeUndefined();
  });

  test("categorizes openclaw_ext_ as custom", () => {
    expect(categorizeMetric("openclaw_ext_steps_today")).toBe("custom");
    expect(categorizeMetric("openclaw_ext_meditation_minutes")).toBe("custom");
    expect(categorizeMetric("openclaw_ext_e2e_test_gauge")).toBe("custom");
  });

  test("categorizes openclaw_lens_ cost metrics", () => {
    expect(categorizeMetric("openclaw_lens_cost_by_token_type_total")).toBe("cost");
    expect(categorizeMetric("openclaw_lens_cost_by_model_total")).toBe("cost");
    expect(categorizeMetric("openclaw_lens_daily_cost_usd")).toBe("cost");
    expect(categorizeMetric("openclaw_lens_cache_savings_usd")).toBe("cost");
  });

  test("categorizes openclaw_lens_ usage metrics", () => {
    expect(categorizeMetric("openclaw_lens_tokens_total")).toBe("usage");
    expect(categorizeMetric("openclaw_lens_context_tokens")).toBe("usage");
    expect(categorizeMetric("openclaw_lens_cache_read_ratio")).toBe("usage");
    expect(categorizeMetric("openclaw_lens_cache_token_ratio")).toBe("usage");
  });

  test("categorizes openclaw_lens_ session metrics", () => {
    expect(categorizeMetric("openclaw_lens_sessions_active")).toBe("session");
    expect(categorizeMetric("openclaw_lens_sessions_active_snapshot")).toBe("session");
    expect(categorizeMetric("openclaw_lens_sessions_stuck")).toBe("session");
    expect(categorizeMetric("openclaw_lens_session_duration_ms_bucket")).toBe("session");
    expect(categorizeMetric("openclaw_lens_session_latency_avg_ms")).toBe("session");
    expect(categorizeMetric("openclaw_lens_stuck_session_max_age_ms")).toBe("session");
  });

  test("categorizes openclaw_lens_ queue metrics", () => {
    expect(categorizeMetric("openclaw_lens_queue_depth")).toBe("queue");
    expect(categorizeMetric("openclaw_lens_queue_lane_depth")).toBe("queue");
    expect(categorizeMetric("openclaw_lens_queue_lane_enqueue_total")).toBe("queue");
    expect(categorizeMetric("openclaw_lens_queue_wait_ms_bucket")).toBe("queue");
  });

  test("categorizes openclaw_lens_ messaging metrics", () => {
    expect(categorizeMetric("openclaw_lens_messages_processed_total")).toBe("messaging");
    expect(categorizeMetric("openclaw_lens_session_message_types_total")).toBe("session"); // session_ prefix takes precedence
  });

  test("categorizes openclaw_lens_ webhook metrics", () => {
    expect(categorizeMetric("openclaw_lens_alert_webhooks_received")).toBe("webhook");
    expect(categorizeMetric("openclaw_lens_alert_webhooks_pending")).toBe("webhook");
  });

  test("categorizes openclaw_lens_ tool metrics", () => {
    expect(categorizeMetric("openclaw_lens_tool_calls_total")).toBe("tools");
    expect(categorizeMetric("openclaw_lens_tool_duration_ms_bucket")).toBe("tools");
    expect(categorizeMetric("openclaw_lens_tool_loops_active")).toBe("tools");
  });

  test("categorizes openclaw_lens_ agent metrics", () => {
    expect(categorizeMetric("openclaw_lens_subagents_spawned_total")).toBe("agent");
    expect(categorizeMetric("openclaw_lens_subagent_outcomes_total")).toBe("agent");
  });

  test("categorizes openclaw_lens_ custom metrics bookkeeping", () => {
    expect(categorizeMetric("openclaw_lens_custom_metrics_pushed_total")).toBe("custom");
  });

  test("categorizes core openclaw_ (non-lens) metrics", () => {
    expect(categorizeMetric("openclaw_tokens_total")).toBe("usage");
    expect(categorizeMetric("openclaw_cost_usd_total")).toBe("cost");
    expect(categorizeMetric("openclaw_session_state_total")).toBe("session");
    expect(categorizeMetric("openclaw_message_processed_total")).toBe("messaging");
    expect(categorizeMetric("openclaw_queue_depth_bucket")).toBe("queue");
    expect(categorizeMetric("openclaw_run_duration_ms_milliseconds_bucket")).toBe("agent");
    expect(categorizeMetric("openclaw_webhook_received_total")).toBe("webhook");
  });
});

// ── OTLP metadata fallback tests ──────────────────────────────────────

describe("OTLP metadata fallback (synthetic metadata)", () => {
  beforeEach(() => {
    listMetricNamesMock.mockReset();
    listLabelValuesMock.mockReset();
    getMetricMetadataMock.mockReset();
  });

  test("falls back to synthetic metadata when Prometheus metadata is empty", async () => {
    getMetricMetadataMock.mockResolvedValueOnce({}); // Empty — OTLP stack
    listMetricNamesMock.mockResolvedValueOnce([
      "openclaw_lens_sessions_active",
      "openclaw_lens_tokens_total",
      "openclaw_lens_daily_cost_usd",
    ]);

    const tool = createListMetricsToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-otlp1", { datasourceUid: "prom1", metadata: true });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.status).toBe("success");
    expect(parsed.metadataSource).toBe("synthetic");
    expect(parsed.count).toBe(3);
    expect(parsed.hint).toContain("OTLP");

    // Check that known metrics have type and help from registry
    const sessions = parsed.metrics.find((m: { name: string }) => m.name === "openclaw_lens_sessions_active");
    expect(sessions.type).toBe("gauge");
    expect(sessions.help).toBe("Currently active sessions by state");
    expect(sessions.category).toBe("session");
    expect(sessions.source).toBe("synthetic");

    const tokens = parsed.metrics.find((m: { name: string }) => m.name === "openclaw_lens_tokens_total");
    expect(tokens.type).toBe("counter");
    expect(tokens.help).toBe("Token usage by type, provider, and model");
    expect(tokens.category).toBe("usage");
  });

  test("deduplicates histogram sub-metrics (_bucket/_count/_sum)", async () => {
    getMetricMetadataMock.mockResolvedValueOnce({});
    listMetricNamesMock.mockResolvedValueOnce([
      "openclaw_lens_session_duration_ms_bucket",
      "openclaw_lens_session_duration_ms_count",
      "openclaw_lens_session_duration_ms_sum",
      "openclaw_lens_sessions_active",
    ]);

    const tool = createListMetricsToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-otlp2", { datasourceUid: "prom1", metadata: true });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.count).toBe(2); // 1 histogram base + 1 gauge, not 4
    const names = parsed.metrics.map((m: { name: string }) => m.name).sort();
    expect(names).toEqual(["openclaw_lens_session_duration_ms", "openclaw_lens_sessions_active"]);

    const histogram = parsed.metrics.find((m: { name: string }) => m.name === "openclaw_lens_session_duration_ms");
    expect(histogram.type).toBe("histogram");
    expect(histogram.help).toBe("Session duration in milliseconds");
  });

  test("metadataSource is 'prometheus' when metadata endpoint has data", async () => {
    getMetricMetadataMock.mockResolvedValueOnce({
      up: [{ type: "gauge", help: "Target is up", unit: "" }],
    });

    const tool = createListMetricsToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-otlp3", { datasourceUid: "prom1", metadata: true });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.metadataSource).toBe("prometheus");
    expect(parsed.hint).toBeUndefined(); // No hint when Prometheus metadata works
  });

  test("synthetic mode applies prefix filter via match[]", async () => {
    getMetricMetadataMock.mockResolvedValueOnce({});
    listMetricNamesMock.mockResolvedValueOnce([
      "openclaw_lens_cost_by_model_total",
      "openclaw_lens_daily_cost_usd",
    ]);

    const tool = createListMetricsToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-otlp4", { datasourceUid: "prom1", metadata: true, prefix: "openclaw_lens_" });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.metadataSource).toBe("synthetic");
    expect(parsed.count).toBe(2);
    expect(listMetricNamesMock).toHaveBeenCalledWith("prom1", { match: '{__name__=~"openclaw_lens_.*"}' });
  });

  test("synthetic mode applies search filter via match[]", async () => {
    getMetricMetadataMock.mockResolvedValueOnce({});
    listMetricNamesMock.mockResolvedValueOnce([
      "openclaw_lens_daily_cost_usd",
      "openclaw_lens_cost_by_model_total",
      "openclaw_lens_cost_by_token_type_total",
    ]);

    const tool = createListMetricsToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-otlp5", { datasourceUid: "prom1", metadata: true, search: "cost" });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.metadataSource).toBe("synthetic");
    expect(parsed.count).toBe(3);
    expect(listMetricNamesMock).toHaveBeenCalledWith("prom1", { match: '{__name__=~".*cost.*"}' });
  });

  test("synthetic mode works with purpose filter", async () => {
    getMetricMetadataMock.mockResolvedValueOnce({});
    listMetricNamesMock.mockResolvedValueOnce([
      "openclaw_lens_tokens_total",
      "openclaw_lens_cost_by_token_type_total",
      "openclaw_lens_sessions_active",
      "openclaw_lens_tool_calls_total",
    ]);

    const tool = createListMetricsToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-otlp6", { datasourceUid: "prom1", metadata: true, purpose: "cost" });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.metadataSource).toBe("synthetic");
    expect(parsed.purpose).toBe("cost");
    expect(parsed.count).toBe(2);
    const names = parsed.metrics.map((m: { name: string }) => m.name).sort();
    expect(names).toEqual(["openclaw_lens_cost_by_token_type_total", "openclaw_lens_tokens_total"]);
  });

  test("synthetic mode merges custom store entries", async () => {
    getMetricMetadataMock.mockResolvedValueOnce({});
    listMetricNamesMock.mockResolvedValueOnce([
      "openclaw_lens_sessions_active",
    ]);

    const mockStore = {
      listMetrics: () => [
        { name: "openclaw_ext_steps_today", type: "gauge", help: "Daily steps", labelNames: ["source"], createdAt: 0, updatedAt: 0 },
      ],
    };
    const getStore = () => mockStore as never;

    const tool = createListMetricsToolFactory(makeRegistry(), getStore)({} as never);
    const result = await tool!.execute("call-otlp7", { datasourceUid: "prom1", metadata: true });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.count).toBe(2);
    const synthetic = parsed.metrics.find((m: { name: string }) => m.name === "openclaw_lens_sessions_active");
    expect(synthetic.source).toBe("synthetic");
    const custom = parsed.metrics.find((m: { name: string }) => m.name === "openclaw_ext_steps_today");
    expect(custom.source).toBe("custom");
  });

  test("synthetic mode includes categorySummary", async () => {
    getMetricMetadataMock.mockResolvedValueOnce({});
    listMetricNamesMock.mockResolvedValueOnce([
      "openclaw_lens_tokens_total",
      "openclaw_lens_sessions_active",
      "openclaw_lens_queue_depth",
    ]);

    const tool = createListMetricsToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-otlp8", { datasourceUid: "prom1", metadata: true });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.categorySummary).toEqual({ usage: 1, session: 1, queue: 1 });
  });

  test("synthetic mode with compact=true returns minimal fields", async () => {
    getMetricMetadataMock.mockResolvedValueOnce({});
    listMetricNamesMock.mockResolvedValueOnce([
      "openclaw_lens_sessions_active",
      "openclaw_lens_tokens_total",
    ]);

    const tool = createListMetricsToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-otlp9", { datasourceUid: "prom1", metadata: true, compact: true });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.metadataSource).toBe("synthetic");
    const sessions = parsed.metrics.find((m: { name: string }) => m.name === "openclaw_lens_sessions_active");
    expect(sessions.name).toBe("openclaw_lens_sessions_active");
    expect(sessions.type).toBe("gauge");
    expect(sessions.category).toBe("session");
    expect(sessions.help).toBeUndefined(); // compact strips help
    expect(sessions.source).toBeUndefined(); // compact strips source
  });

  test("unknown metrics get type inferred from suffix", async () => {
    getMetricMetadataMock.mockResolvedValueOnce({});
    listMetricNamesMock.mockResolvedValueOnce([
      "some_custom_counter_total",
      "some_custom_gauge",
    ]);

    const tool = createListMetricsToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-otlp10", { datasourceUid: "prom1", metadata: true });

    const parsed = JSON.parse(getTextContent(result));
    const counter = parsed.metrics.find((m: { name: string }) => m.name === "some_custom_counter_total");
    expect(counter.type).toBe("counter"); // inferred from _total suffix

    const gauge = parsed.metrics.find((m: { name: string }) => m.name === "some_custom_gauge");
    expect(gauge.type).toBe("gauge"); // default fallback
  });
});

// ── deduplicateAndEnrich() unit tests ─────────────────────────────────

describe("deduplicateAndEnrich", () => {
  test("coalesces histogram _bucket/_count/_sum into base name", () => {
    const result = deduplicateAndEnrich([
      "openclaw_lens_tool_duration_ms_bucket",
      "openclaw_lens_tool_duration_ms_count",
      "openclaw_lens_tool_duration_ms_sum",
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("openclaw_lens_tool_duration_ms");
    expect(result[0].type).toBe("histogram");
    expect(result[0].help).toBe("Tool call duration in milliseconds by tool name");
    expect(result[0].source).toBe("synthetic");
  });

  test("preserves non-histogram metrics alongside histograms", () => {
    const result = deduplicateAndEnrich([
      "openclaw_lens_queue_wait_ms_bucket",
      "openclaw_lens_queue_wait_ms_count",
      "openclaw_lens_queue_wait_ms_sum",
      "openclaw_lens_queue_depth",
      "openclaw_lens_queue_lane_enqueue_total",
    ]);
    expect(result).toHaveLength(3);
    const names = result.map((e) => e.name).sort();
    expect(names).toEqual([
      "openclaw_lens_queue_depth",
      "openclaw_lens_queue_lane_enqueue_total",
      "openclaw_lens_queue_wait_ms",
    ]);
  });

  test("infers counter type from _total suffix for unknown metrics", () => {
    const result = deduplicateAndEnrich(["unknown_metric_total"]);
    expect(result[0].type).toBe("counter");
    expect(result[0].help).toBe(""); // not in registry
  });

  test("defaults to gauge for unknown metrics without suffix", () => {
    const result = deduplicateAndEnrich(["unknown_gauge_metric"]);
    expect(result[0].type).toBe("gauge");
  });

  test("returns empty array for empty input", () => {
    expect(deduplicateAndEnrich([])).toEqual([]);
  });

  test("enriches known metrics with help text from registry", () => {
    const result = deduplicateAndEnrich(["openclaw_lens_daily_cost_usd"]);
    expect(result[0].type).toBe("gauge");
    expect(result[0].help).toBe("Cost accumulated since last daily reset");
    expect(result[0].category).toBe("cost");
  });
});

// ── KNOWN_LENS_METRICS registry tests ─────────────────────────────────

describe("KNOWN_LENS_METRICS", () => {
  test("contains all expected counter metrics", () => {
    const counters = [...KNOWN_LENS_METRICS.entries()].filter(([, v]) => v.type === "counter");
    expect(counters.length).toBeGreaterThanOrEqual(16);
    for (const [name] of counters) {
      expect(name).toMatch(/_total$/);
    }
  });

  test("contains all expected histogram metrics", () => {
    const histograms = [...KNOWN_LENS_METRICS.entries()].filter(([, v]) => v.type === "histogram");
    expect(histograms.length).toBeGreaterThanOrEqual(5);
    // Histogram base names should NOT end in _bucket/_count/_sum
    for (const [name] of histograms) {
      expect(name).not.toMatch(/_(bucket|count|sum)$/);
    }
  });

  test("contains all expected gauge metrics", () => {
    const gauges = [...KNOWN_LENS_METRICS.entries()].filter(([, v]) => v.type === "gauge");
    expect(gauges.length).toBeGreaterThanOrEqual(15);
  });

  test("every entry has non-empty help text", () => {
    for (const [name, meta] of KNOWN_LENS_METRICS) {
      expect(meta.help, `${name} should have help text`).toBeTruthy();
    }
  });
});
