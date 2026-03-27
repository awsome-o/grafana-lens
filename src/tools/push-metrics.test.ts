import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Meter, Counter as OtelCounter } from "@opentelemetry/api";
import { CustomMetricsStore } from "../services/custom-metrics-store.js";
import { createPushMetricsToolFactory } from "./push-metrics.js";
import type { ValidatedGrafanaLensConfig } from "../config.js";
import { GrafanaClientRegistry } from "../grafana-client-registry.js";
import type { OtlpJsonWriter } from "../services/otlp-json-writer.js";

// ── Mock Meter ──────────────────────────────────────────────────────

function makeMockMeter() {
  const meter = {
    createCounter(name: string) {
      return { add: vi.fn(), name } as unknown as OtelCounter;
    },
    createObservableGauge(_name: string) {
      return {
        addCallback: vi.fn(),
      };
    },
    createHistogram: vi.fn(),
    createUpDownCounter: vi.fn(),
    createObservableCounter: vi.fn(),
    createObservableUpDownCounter: vi.fn(),
  } as unknown as Meter;
  return meter;
}

// ── Helpers ──────────────────────────────────────────────────────────

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

function makeMockWriter() {
  return {
    write: vi.fn().mockResolvedValue(undefined),
    buildPayload: vi.fn(),
  } as unknown as OtlpJsonWriter & { write: ReturnType<typeof vi.fn> };
}

function makeStore() {
  const meter = makeMockMeter();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const forceFlush = vi.fn().mockResolvedValue(undefined);
  return new CustomMetricsStore(meter, forceFlush, "/tmp/push-metrics-test", logger);
}

function makeStoreWithWriter() {
  const meter = makeMockMeter();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const forceFlush = vi.fn().mockResolvedValue(undefined);
  const writer = makeMockWriter();
  const store = new CustomMetricsStore(meter, forceFlush, "/tmp/push-metrics-test", logger, undefined, writer);
  return { store, writer };
}

function getTextContent(result: { content: Array<{ type: string; text?: string }> }): string {
  const first = result.content[0];
  if (first.type === "text" && first.text) return first.text;
  throw new Error("Expected text content");
}

function parse(result: unknown): Record<string, unknown> {
  return JSON.parse(getTextContent(result as { content: Array<{ type: string; text?: string }> }));
}

// ── Tests ────────────────────────────────────────────────────────────

describe("grafana_push_metrics tool", () => {
  let store: CustomMetricsStore;

  beforeEach(() => {
    store = makeStore();
  });

  // ── Push action ─────────────────────────────────────────────────

  test("push single metric", async () => {
    const tool = createPushMetricsToolFactory(makeRegistry(), () => store)({} as never);
    const result = await tool!.execute("call-1", {
      metrics: [{ name: "steps_today", value: 8000 }],
    });

    const parsed = parse(result);
    expect(parsed.status).toBe("ok");
    expect(parsed.accepted).toBe(1);
    expect(store.listMetrics()).toHaveLength(1);
    expect(store.listMetrics()[0].name).toBe("openclaw_ext_steps_today");
  });

  test("push batch of 3 metrics", async () => {
    const tool = createPushMetricsToolFactory(makeRegistry(), () => store)({} as never);
    const result = await tool!.execute("call-2", {
      metrics: [
        { name: "temperature", value: 22.5 },
        { name: "humidity", value: 65 },
        { name: "pressure", value: 1013.25 },
      ],
    });

    const parsed = parse(result);
    expect(parsed.accepted).toBe(3);
    expect(store.listMetrics()).toHaveLength(3);
  });

  test("push with auto-registration", async () => {
    const tool = createPushMetricsToolFactory(makeRegistry(), () => store)({} as never);
    await tool!.execute("call-3", {
      metrics: [{ name: "openclaw_ext_new_metric", value: 42 }],
    });

    const defs = store.listMetrics();
    expect(defs).toHaveLength(1);
    expect(defs[0].type).toBe("gauge");
  });

  test("push partial success — 2 accepted, 1 rejected", async () => {
    const tool = createPushMetricsToolFactory(makeRegistry(), () => store)({} as never);
    const result = await tool!.execute("call-4", {
      metrics: [
        { name: "good_one", value: 1 },
        { name: "bad_one", value: NaN },
        { name: "another_good", value: 2 },
      ],
    });

    const parsed = parse(result);
    expect(parsed.accepted).toBe(2);
    expect(parsed.rejected).toHaveLength(1);
    expect((parsed.rejected as Array<{ name: string }>)[0].name).toBe("bad_one");
  });

  test("push empty metrics array returns error", async () => {
    const tool = createPushMetricsToolFactory(makeRegistry(), () => store)({} as never);
    const result = await tool!.execute("call-5", { metrics: [] });

    const parsed = parse(result);
    expect(parsed.error).toContain("No metrics provided");
  });

  test("push without metrics param returns error", async () => {
    const tool = createPushMetricsToolFactory(makeRegistry(), () => store)({} as never);
    const result = await tool!.execute("call-6", {});

    const parsed = parse(result);
    expect(parsed.error).toContain("No metrics provided");
  });

  test("push auto-prepends openclaw_ext_ prefix", async () => {
    const tool = createPushMetricsToolFactory(makeRegistry(), () => store)({} as never);
    await tool!.execute("call-7", {
      metrics: [{ name: "calendar_meetings", value: 5 }],
    });

    expect(store.listMetrics()[0].name).toBe("openclaw_ext_calendar_meetings");
  });

  test("push response includes queryNames", async () => {
    const tool = createPushMetricsToolFactory(makeRegistry(), () => store)({} as never);
    const result = await tool!.execute("call-8", {
      metrics: [{ name: "test", value: 1 }],
    });

    const parsed = parse(result);
    expect(parsed.message).toContain("queryNames");
    expect(parsed.queryNames).toEqual({ openclaw_ext_test: "openclaw_ext_test" });
  });

  test("push counter includes _total in queryNames", async () => {
    const tool = createPushMetricsToolFactory(makeRegistry(), () => store)({} as never);
    const result = await tool!.execute("call-qn1", {
      metrics: [
        { name: "api_calls", value: 10, type: "counter", help: "API calls" },
        { name: "temperature", value: 22.5 },
      ],
    });

    const parsed = parse(result);
    expect(parsed.queryNames).toEqual({
      openclaw_ext_api_calls: "openclaw_ext_api_calls_total",
      openclaw_ext_temperature: "openclaw_ext_temperature",
    });
  });

  test("rejected metrics excluded from queryNames", async () => {
    const tool = createPushMetricsToolFactory(makeRegistry(), () => store)({} as never);
    const result = await tool!.execute("call-qn2", {
      metrics: [
        { name: "good", value: 1 },
        { name: "bad", value: NaN },
      ],
    });

    const parsed = parse(result);
    expect(parsed.queryNames).toEqual({ openclaw_ext_good: "openclaw_ext_good" });
  });

  test("push calls trackPush with accepted and rejected counts", async () => {
    const trackPushSpy = vi.spyOn(store, "trackPush");
    const tool = createPushMetricsToolFactory(makeRegistry(), () => store)({} as never);

    await tool!.execute("call-tp1", {
      metrics: [
        { name: "good", value: 1 },
        { name: "bad", value: NaN },
        { name: "also_good", value: 2 },
      ],
    });

    expect(trackPushSpy).toHaveBeenCalledWith(2, 1);
    trackPushSpy.mockRestore();
  });

  // ── Register action ─────────────────────────────────────────────

  test("register creates metric with explicit schema", async () => {
    const tool = createPushMetricsToolFactory(makeRegistry(), () => store)({} as never);
    const result = await tool!.execute("call-r1", {
      action: "register",
      name: "weight_kg",
      type: "gauge",
      help: "Body weight in kg",
      labelNames: ["person"],
    });

    const parsed = parse(result);
    expect(parsed.status).toBe("registered");

    const defs = store.listMetrics();
    expect(defs).toHaveLength(1);
    expect(defs[0].help).toBe("Body weight in kg");
    expect(defs[0].labelNames).toEqual(["person"]);
  });

  test("register with ttlDays", async () => {
    const tool = createPushMetricsToolFactory(makeRegistry(), () => store)({} as never);
    const result = await tool!.execute("call-r2", {
      action: "register",
      name: "temp_metric",
      ttlDays: 7,
    });

    const parsed = parse(result);
    expect(parsed.status).toBe("registered");
    const metric = (parsed.metric as { ttlMs: number });
    expect(metric.ttlMs).toBe(7 * 86_400_000);
  });

  test("register counter includes queryName with _total", async () => {
    const tool = createPushMetricsToolFactory(makeRegistry(), () => store)({} as never);
    const result = await tool!.execute("call-r-qn", {
      action: "register",
      name: "events",
      type: "counter",
      help: "Total events",
    });

    const parsed = parse(result);
    expect(parsed.queryName).toBe("openclaw_ext_events_total");
  });

  test("register gauge includes queryName without _total", async () => {
    const tool = createPushMetricsToolFactory(makeRegistry(), () => store)({} as never);
    const result = await tool!.execute("call-r-qn2", {
      action: "register",
      name: "weight_kg",
      type: "gauge",
    });

    const parsed = parse(result);
    expect(parsed.queryName).toBe("openclaw_ext_weight_kg");
  });

  test("register adds auto-prefix note", async () => {
    const tool = createPushMetricsToolFactory(makeRegistry(), () => store)({} as never);
    const result = await tool!.execute("call-r3", {
      action: "register",
      name: "no_prefix",
    });

    const parsed = parse(result);
    expect(parsed.note).toContain("auto-prefixed");
    expect(parsed.note).toContain("openclaw_ext_no_prefix");
  });

  // ── List action ─────────────────────────────────────────────────

  test("list returns all custom metrics with queryName", async () => {
    store.registerMetric({ name: "openclaw_ext_events", type: "counter", help: "events", labelNames: [] });
    store.pushValues([
      { name: "openclaw_ext_steps", value: 8000 },
      { name: "openclaw_ext_events", value: 5, type: "counter" },
    ]);

    const tool = createPushMetricsToolFactory(makeRegistry(), () => store)({} as never);
    const result = await tool!.execute("call-l1", { action: "list" });

    const parsed = parse(result);
    expect(parsed.count).toBe(2);
    const metrics = parsed.metrics as Array<{ name: string; queryName: string }>;
    const steps = metrics.find((m) => m.name === "openclaw_ext_steps");
    const events = metrics.find((m) => m.name === "openclaw_ext_events");
    expect(steps?.queryName).toBe("openclaw_ext_steps");
    expect(events?.queryName).toBe("openclaw_ext_events_total");
  });

  // ── Delete action ───────────────────────────────────────────────

  test("delete removes a metric", async () => {
    store.pushValues([{ name: "openclaw_ext_removable", value: 1 }]);

    const tool = createPushMetricsToolFactory(makeRegistry(), () => store)({} as never);
    const result = await tool!.execute("call-d1", {
      action: "delete",
      name: "removable",
    });

    const parsed = parse(result);
    expect(parsed.status).toBe("deleted");
    expect(parsed.note).toContain("Historical data already in Grafana remains queryable");
    expect(store.listMetrics()).toHaveLength(0);
  });

  test("delete returns error for unknown metric", async () => {
    const tool = createPushMetricsToolFactory(makeRegistry(), () => store)({} as never);
    const result = await tool!.execute("call-d2", {
      action: "delete",
      name: "nonexistent",
    });

    const parsed = parse(result);
    expect(parsed.error).toContain("not found");
  });

  // ── Error handling ──────────────────────────────────────────────

  test("returns error when store not initialized", async () => {
    const tool = createPushMetricsToolFactory(makeRegistry(), () => null)({} as never);
    const result = await tool!.execute("call-e1", {
      metrics: [{ name: "test", value: 1 }],
    });

    const parsed = parse(result);
    expect(parsed.error).toContain("Custom metrics service not started");
  });

  test("unknown action returns error", async () => {
    const tool = createPushMetricsToolFactory(makeRegistry(), () => store)({} as never);
    const result = await tool!.execute("call-e2", { action: "invalid" });

    const parsed = parse(result);
    expect(parsed.error).toContain("Unknown action 'invalid'");
  });

  // ── Timestamped push ─────────────────────────────────────────────

  test("push with timestamps routes to timestamped path", async () => {
    const { store: tsStore, writer } = makeStoreWithWriter();
    const tool = createPushMetricsToolFactory(makeRegistry(), () => tsStore)({} as never);

    const result = await tool!.execute("call-ts1", {
      metrics: [
        { name: "steps", value: 8000, timestamp: "2025-01-15" },
        { name: "steps", value: 10500, timestamp: "2025-01-16" },
      ],
    });

    const parsed = parse(result);
    expect(parsed.status).toBe("ok");
    expect(parsed.accepted).toBe(2);
    expect(writer.write).toHaveBeenCalledTimes(1);
  });

  test("push mixed batch — some timestamped, some real-time", async () => {
    const { store: tsStore } = makeStoreWithWriter();
    const tool = createPushMetricsToolFactory(makeRegistry(), () => tsStore)({} as never);

    const result = await tool!.execute("call-ts2", {
      metrics: [
        { name: "steps", value: 8000, timestamp: "2025-01-15" },
        { name: "heart_rate", value: 72 },
        { name: "steps", value: 10500, timestamp: "2025-01-16" },
      ],
    });

    const parsed = parse(result);
    expect(parsed.status).toBe("ok");
    expect(parsed.accepted).toBe(3);
    expect(parsed.queryNames).toHaveProperty("openclaw_ext_steps");
    expect(parsed.queryNames).toHaveProperty("openclaw_ext_heart_rate");
  });

  test("push counter with timestamp is rejected", async () => {
    const { store: tsStore } = makeStoreWithWriter();
    const tool = createPushMetricsToolFactory(makeRegistry(), () => tsStore)({} as never);

    const result = await tool!.execute("call-ts3", {
      metrics: [
        { name: "events", value: 5, type: "counter", timestamp: "2025-01-15" },
      ],
    });

    const parsed = parse(result);
    expect(parsed.accepted).toBe(0);
    expect(parsed.rejected).toHaveLength(1);
    expect((parsed.rejected as Array<{ reason: string }>)[0].reason).toContain("gauge type");
  });

  test("push with invalid timestamp is rejected", async () => {
    const { store: tsStore } = makeStoreWithWriter();
    const tool = createPushMetricsToolFactory(makeRegistry(), () => tsStore)({} as never);

    const result = await tool!.execute("call-ts4", {
      metrics: [
        { name: "steps", value: 8000, timestamp: "not-a-date" },
      ],
    });

    const parsed = parse(result);
    expect(parsed.accepted).toBe(0);
    expect(parsed.rejected).toHaveLength(1);
    expect((parsed.rejected as Array<{ reason: string }>)[0].reason).toContain("Invalid timestamp");
  });

  test("timestamped push includes queryNames in response", async () => {
    const { store: tsStore } = makeStoreWithWriter();
    const tool = createPushMetricsToolFactory(makeRegistry(), () => tsStore)({} as never);

    const result = await tool!.execute("call-ts5", {
      metrics: [
        { name: "fitness_steps", value: 8000, timestamp: "2025-01-15" },
      ],
    });

    const parsed = parse(result);
    expect(parsed.queryNames).toEqual({
      openclaw_ext_fitness_steps: "openclaw_ext_fitness_steps",
    });
  });

  // ── Old-timestamp note ────────────────────────────────────────────

  test("adds note when timestamped data is >10m old", async () => {
    const { store: tsStore } = makeStoreWithWriter();
    const tool = createPushMetricsToolFactory(makeRegistry(), () => tsStore)({} as never);

    // Timestamp from a day ago — clearly >10m old
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    const result = await tool!.execute("call-note1", {
      metrics: [{ name: "steps", value: 8000, timestamp: yesterday }],
    });

    const parsed = parse(result);
    expect(parsed.status).toBe("ok");
    expect(parsed.note).toContain("Some timestamps are >10m old");
    expect(parsed.note).toContain("out_of_order_time_window");
  });

  test("no note when timestamps are within 10m window", async () => {
    const { store: tsStore } = makeStoreWithWriter();
    const tool = createPushMetricsToolFactory(makeRegistry(), () => tsStore)({} as never);

    // Timestamp from 5 minutes ago — within 10m window
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const result = await tool!.execute("call-note2", {
      metrics: [{ name: "steps", value: 8000, timestamp: fiveMinAgo }],
    });

    const parsed = parse(result);
    expect(parsed.status).toBe("ok");
    expect(parsed.note).toBeUndefined();
  });

  test("no note for real-time pushes (no timestamps)", async () => {
    const tool = createPushMetricsToolFactory(makeRegistry(), () => store)({} as never);

    const result = await tool!.execute("call-note3", {
      metrics: [{ name: "steps", value: 8000 }],
    });

    const parsed = parse(result);
    expect(parsed.status).toBe("ok");
    expect(parsed.note).toBeUndefined();
  });

  // ── Suggested workflow ──────────────────────────────────────────────

  test("push response includes suggestedWorkflow with verify and visualize steps", async () => {
    const tool = createPushMetricsToolFactory(makeRegistry(), () => store)({} as never);
    const result = await tool!.execute("call-sw1", {
      metrics: [{ name: "meditation_minutes", value: 30 }],
    });

    const parsed = parse(result);
    const workflow = parsed.suggestedWorkflow as Array<{ tool: string; action: string; example: Record<string, unknown> }>;
    expect(workflow).toHaveLength(3); // verify + visualize + alert (single metric)
    expect(workflow[0].tool).toBe("grafana_query");
    expect(workflow[0].action).toBe("Verify data landed");
    expect(workflow[0].example).toEqual({ expr: "openclaw_ext_meditation_minutes" });
    expect(workflow[1].tool).toBe("grafana_create_dashboard");
    expect(workflow[1].example).toEqual({
      template: "metric-explorer",
      variables: { metric: "openclaw_ext_meditation_minutes" },
    });
    expect(workflow[2].tool).toBe("grafana_create_alert");
    expect(workflow[2].example.expr).toBe("openclaw_ext_meditation_minutes");
  });

  test("push multi-metric batch omits alert suggestion (ambiguous threshold)", async () => {
    const tool = createPushMetricsToolFactory(makeRegistry(), () => store)({} as never);
    const result = await tool!.execute("call-sw2", {
      metrics: [
        { name: "steps", value: 8000 },
        { name: "heart_rate", value: 72 },
      ],
    });

    const parsed = parse(result);
    const workflow = parsed.suggestedWorkflow as Array<{ tool: string }>;
    expect(workflow).toHaveLength(2); // verify + visualize only
    expect(workflow.every((s) => s.tool !== "grafana_create_alert")).toBe(true);
  });

  test("push with all rejected does not include suggestedWorkflow", async () => {
    const tool = createPushMetricsToolFactory(makeRegistry(), () => store)({} as never);
    const result = await tool!.execute("call-sw3", {
      metrics: [{ name: "bad", value: NaN }],
    });

    const parsed = parse(result);
    expect(parsed.suggestedWorkflow).toBeUndefined();
  });

  test("register response includes suggestedWorkflow with push and query steps", async () => {
    const tool = createPushMetricsToolFactory(makeRegistry(), () => store)({} as never);
    const result = await tool!.execute("call-sw4", {
      action: "register",
      name: "weight_kg",
      type: "gauge",
      labelNames: ["person"],
    });

    const parsed = parse(result);
    const workflow = parsed.suggestedWorkflow as Array<{ tool: string; action: string; example: Record<string, unknown> }>;
    expect(workflow).toHaveLength(2); // push + query
    expect(workflow[0].tool).toBe("grafana_push_metrics");
    expect(workflow[0].action).toBe("Push data points");
    // Should include label placeholder
    const pushMetrics = (workflow[0].example.metrics as Array<Record<string, unknown>>);
    expect(pushMetrics[0].labels).toEqual({ person: "<person>" });
    expect(workflow[1].tool).toBe("grafana_query");
    expect(workflow[1].example).toEqual({ expr: "openclaw_ext_weight_kg" });
  });

  test("register counter includes rate() in query example", async () => {
    const tool = createPushMetricsToolFactory(makeRegistry(), () => store)({} as never);
    const result = await tool!.execute("call-sw5", {
      action: "register",
      name: "api_calls",
      type: "counter",
    });

    const parsed = parse(result);
    const workflow = parsed.suggestedWorkflow as Array<{ tool: string; example: Record<string, unknown> }>;
    expect(workflow[1].example).toEqual({ expr: "rate(openclaw_ext_api_calls_total[5m])" });
  });

  test("note appears in mixed batch when any timestamp is old", async () => {
    const { store: tsStore } = makeStoreWithWriter();
    const tool = createPushMetricsToolFactory(makeRegistry(), () => tsStore)({} as never);

    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    const result = await tool!.execute("call-note4", {
      metrics: [
        { name: "heart_rate", value: 72 }, // real-time
        { name: "steps", value: 8000, timestamp: yesterday }, // old
      ],
    });

    const parsed = parse(result);
    expect(parsed.status).toBe("ok");
    expect(parsed.accepted).toBe(2);
    expect(parsed.note).toContain("Some timestamps are >10m old");
  });
});
