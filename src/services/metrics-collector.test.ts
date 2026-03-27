import { beforeEach, describe, expect, test, vi } from "vitest";

// ── Hoisted mocks ────────────────────────────────────────────────────

const onDiagnosticEventMock = vi.hoisted(() => vi.fn());

/** Track all OTel instrument operations */
const otelState = vi.hoisted(() => {
  const counters = new Map<string, { add: ReturnType<typeof vi.fn> }>();
  const histograms = new Map<string, { record: ReturnType<typeof vi.fn> }>();
  const upDownCounters = new Map<string, { add: ReturnType<typeof vi.fn> }>();
  const observableGauges = new Map<string, { callbacks: Array<(result: { observe: ReturnType<typeof vi.fn> }) => void> }>();

  return {
    counters,
    histograms,
    upDownCounters,
    observableGauges,
    mockMeter: {
      createCounter(name: string) {
        const mock = { add: vi.fn() };
        counters.set(name, mock);
        return mock;
      },
      createHistogram(name: string) {
        const mock = { record: vi.fn() };
        histograms.set(name, mock);
        return mock;
      },
      createUpDownCounter(name: string) {
        const mock = { add: vi.fn() };
        upDownCounters.set(name, mock);
        return mock;
      },
      createObservableGauge(name: string) {
        const entry = { callbacks: [] as Array<(result: { observe: ReturnType<typeof vi.fn> }) => void> };
        observableGauges.set(name, entry);
        return {
          addCallback(cb: (result: { observe: ReturnType<typeof vi.fn> }) => void) {
            entry.callbacks.push(cb);
          },
        };
      },
    },
    mockForceFlush: vi.fn().mockResolvedValue(undefined),
    mockShutdown: vi.fn().mockResolvedValue(undefined),
  };
});

/** Track OTel log emissions */
const mockLogEmit = vi.hoisted(() => vi.fn());
const mockLogsForceFlush = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockLogsShutdown = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

/** Track OTel trace emissions */
const mockSpanEnd = vi.hoisted(() => vi.fn());
const mockSpanSetStatus = vi.hoisted(() => vi.fn());
const mockSpanContext = vi.hoisted(() => vi.fn().mockReturnValue({ traceId: "test-trace-id-123" }));
const mockStartSpan = vi.hoisted(() => vi.fn().mockReturnValue({
  end: mockSpanEnd,
  setStatus: mockSpanSetStatus,
  spanContext: mockSpanContext,
}));
const mockTracesForceFlush = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockTracesShutdown = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

const registerLogTransportMock = vi.hoisted(() => vi.fn());

vi.mock("../sdk-compat.js", async () => {
  const actual = await vi.importActual<typeof import("../sdk-compat.js")>("../sdk-compat.js");
  return {
    ...actual,
    resolveDiagnosticHooks: vi.fn().mockResolvedValue({
      onDiagnosticEvent: onDiagnosticEventMock,
      registerLogTransport: registerLogTransportMock,
    }),
  };
});

vi.mock("./otel-metrics.js", () => ({
  createOtelMetrics: () => ({
    meter: otelState.mockMeter,
    forceFlush: otelState.mockForceFlush,
    shutdown: otelState.mockShutdown,
  }),
}));

vi.mock("./otel-logs.js", () => ({
  createOtelLogs: () => ({
    logger: { emit: mockLogEmit },
    forceFlush: mockLogsForceFlush,
    shutdown: mockLogsShutdown,
  }),
  SeverityNumber: {
    TRACE: 1,
    DEBUG: 5,
    INFO: 9,
    WARN: 13,
    ERROR: 17,
    FATAL: 21,
  },
}));

vi.mock("./otel-traces.js", () => ({
  createOtelTraces: () => ({
    tracer: { startSpan: mockStartSpan },
    forceFlush: mockTracesForceFlush,
    shutdown: mockTracesShutdown,
  }),
  SpanKind: { INTERNAL: 0, SERVER: 1, CLIENT: 2 },
  SpanStatusCode: { UNSET: 0, OK: 1, ERROR: 2 },
}));

// Mock CustomMetricsStore to avoid real OTel interactions
vi.mock("./custom-metrics-store.js", () => ({
  CustomMetricsStore: class {
    load = vi.fn().mockResolvedValue(undefined);
    startPeriodicFlush = vi.fn();
    stopPeriodicFlush = vi.fn().mockResolvedValue(undefined);
  },
}));

// Mock @opentelemetry/api for trace/ROOT_CONTEXT imports
const mockTraceSetSpan = vi.hoisted(() => vi.fn().mockReturnValue({ _type: "SPAN_CONTEXT" }));
vi.mock("@opentelemetry/api", () => ({
  trace: { setSpan: mockTraceSetSpan },
  ROOT_CONTEXT: { _type: "ROOT_CONTEXT" },
}));

// Mock lifecycle-telemetry to avoid real OTel context propagation
const mockLifecycleDestroy = vi.hoisted(() => vi.fn());
const mockLifecycleFlushAll = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockGetSessionContextByAny = vi.hoisted(() => vi.fn());
vi.mock("./lifecycle-telemetry.js", () => ({
  createLifecycleTelemetry: () => ({
    destroy: mockLifecycleDestroy,
    flushAll: mockLifecycleFlushAll,
    onSessionStart: vi.fn(),
    onSessionEnd: vi.fn(),
    onLlmInput: vi.fn(),
    onLlmOutput: vi.fn(),
    onAgentEnd: vi.fn(),
    onMessageReceived: vi.fn(),
    onMessageSent: vi.fn(),
    onBeforeCompaction: vi.fn(),
    onAfterCompaction: vi.fn(),
    onSubagentSpawned: vi.fn(),
    onSubagentEnded: vi.fn(),
    onAfterToolCall: vi.fn(),
    getSessionContext: vi.fn(),
    getSessionContextByAny: mockGetSessionContextByAny,
    getAvgLatencyMs: vi.fn().mockReturnValue(0),
  }),
}));

// ── Imports (after mocks) ────────────────────────────────────────────

import { createMetricsCollectorService } from "./metrics-collector.js";
import type { ValidatedGrafanaLensConfig } from "../config.js";

function makeConfig(overrides?: Partial<ValidatedGrafanaLensConfig>): ValidatedGrafanaLensConfig {
  return {
    grafana: {
      instances: { default: { url: "http://localhost:3000", apiKey: "test-key" } },
      defaultInstance: "default",
    },
    metrics: { enabled: true },
    ...overrides,
  } as ValidatedGrafanaLensConfig;
}

function makeCtx() {
  return {
    config: { diagnostics: { enabled: true, otel: { enabled: true } } },
    stateDir: "/tmp/grafana-lens-test",
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
}

/** Helper to invoke observable gauge callbacks and return observed values */
function observeGauge(name: string): Array<{ value: number; labels?: Record<string, string> }> {
  const gauge = otelState.observableGauges.get(name);
  if (!gauge) return [];
  const observed: Array<{ value: number; labels?: Record<string, string> }> = [];
  const mockResult = {
    observe: vi.fn((value: number, labels?: Record<string, string>) => {
      observed.push({ value, labels });
    }),
  };
  for (const cb of gauge.callbacks) cb(mockResult);
  return observed;
}

describe("MetricsCollector service", () => {
  let eventListener: ((evt: Record<string, unknown>) => void) | null = null;
  const unsubscribeMock = vi.fn();

  beforeEach(() => {
    eventListener = null;
    otelState.counters.clear();
    otelState.histograms.clear();
    otelState.upDownCounters.clear();
    otelState.observableGauges.clear();
    onDiagnosticEventMock.mockReset();
    onDiagnosticEventMock.mockImplementation((listener: (evt: Record<string, unknown>) => void) => {
      eventListener = listener;
      return unsubscribeMock;
    });
    unsubscribeMock.mockClear();
    otelState.mockShutdown.mockClear();
    mockLogEmit.mockClear();
    mockStartSpan.mockClear();
    mockSpanEnd.mockClear();
    mockSpanSetStatus.mockClear();
    mockSpanContext.mockClear();
    mockLogsShutdown.mockClear();
    mockTracesShutdown.mockClear();
    mockLifecycleDestroy.mockClear();
    mockLifecycleFlushAll.mockClear();
    mockGetSessionContextByAny.mockReset();
    mockLogsForceFlush.mockClear();
    mockTracesForceFlush.mockClear();
    mockTraceSetSpan.mockClear();
    registerLogTransportMock.mockReset();
    registerLogTransportMock.mockReturnValue(vi.fn()); // return unsubscribe fn
  });

  // ══════════════════════════════════════════════════════════════════
  // Existing metric tests (unchanged behavior)
  // ══════════════════════════════════════════════════════════════════

  test("subscribes to diagnostic events on start", async () => {
    const { service } = createMetricsCollectorService(makeConfig());

    await service.start(makeCtx());

    expect(onDiagnosticEventMock).toHaveBeenCalledTimes(1);
  });

  test("creates only unique OTel instruments (no duplicated counters/histograms)", async () => {
    const { service } = createMetricsCollectorService(makeConfig());

    await service.start(makeCtx());

    // These should NOT exist (provided by diagnostics-otel)
    expect(otelState.counters.has("openclaw_lens_tokens_total")).toBe(false);
    expect(otelState.counters.has("openclaw_lens_cost_usd_total")).toBe(false);
    expect(otelState.counters.has("openclaw_lens_messages_processed_total")).toBe(false);
    expect(otelState.counters.has("openclaw_lens_webhooks_total")).toBe(false);
    expect(otelState.histograms.has("openclaw_lens_llm_duration_seconds")).toBe(false);
    expect(otelState.histograms.has("openclaw_lens_message_duration_seconds")).toBe(false);

    // These SHOULD exist (unique to grafana-lens)
    expect(otelState.upDownCounters.has("openclaw_lens_sessions_active")).toBe(true);
    expect(otelState.observableGauges.has("openclaw_lens_queue_depth")).toBe(true);
    expect(otelState.observableGauges.has("openclaw_lens_daily_cost_usd")).toBe(true);
    expect(otelState.observableGauges.has("openclaw_lens_context_tokens")).toBe(true);
    expect(otelState.counters.has("openclaw_lens_custom_metrics_pushed_total")).toBe(true);

    // New operational gauges
    expect(otelState.observableGauges.has("openclaw_lens_sessions_active_snapshot")).toBe(true);
    expect(otelState.observableGauges.has("openclaw_lens_sessions_stuck")).toBe(true);
    expect(otelState.observableGauges.has("openclaw_lens_stuck_session_max_age_ms")).toBe(true);
    expect(otelState.observableGauges.has("openclaw_lens_cache_read_ratio")).toBe(true);
    expect(otelState.observableGauges.has("openclaw_lens_tool_loops_active")).toBe(true);
    expect(otelState.observableGauges.has("openclaw_lens_queue_lane_depth")).toBe(true);
  });

  test("model.usage event accumulates daily cost and context (no counter/histogram)", async () => {
    const { service } = createMetricsCollectorService(makeConfig());

    await service.start(makeCtx());

    eventListener!({
      type: "model.usage",
      model: "claude-3",
      provider: "anthropic",
      channel: "whatsapp",
      usage: { input: 100, output: 50, cacheRead: 30 },
      costUsd: 0.01,
      durationMs: 2500,
      context: { limit: 200000, used: 50000 },
    });

    // Daily cost should accumulate
    const dailyCost = observeGauge("openclaw_lens_daily_cost_usd");
    expect(dailyCost).toEqual([{ value: 0.01 }]);

    // Context tokens should update
    const context = observeGauge("openclaw_lens_context_tokens");
    expect(context).toEqual(
      expect.arrayContaining([
        { value: 200000, labels: { type: "limit" } },
        { value: 50000, labels: { type: "used" } },
      ]),
    );

    // Cache read ratio should reflect 30 / (100 + 30)
    const cacheRatio = observeGauge("openclaw_lens_cache_read_ratio");
    expect(cacheRatio.length).toBe(1);
    expect(cacheRatio[0].value).toBeCloseTo(30 / 130, 5);
  });

  test("session.state event uses UpDownCounter and clears stuck/loop tracking", async () => {
    const { service } = createMetricsCollectorService(makeConfig());

    await service.start(makeCtx());

    // First, mark a session as stuck
    eventListener!({
      type: "session.stuck",
      sessionKey: "sess-1",
      state: "active",
      ageMs: 45000,
    });
    expect(observeGauge("openclaw_lens_sessions_stuck")).toEqual([{ value: 1 }]);

    // Mark same session in a tool loop
    eventListener!({
      type: "tool.loop",
      sessionKey: "sess-1",
      level: "warning",
      action: "warn",
      detector: "generic_repeat",
      count: 5,
      message: "test loop",
      toolName: "test_tool",
    });
    expect(observeGauge("openclaw_lens_tool_loops_active")).toEqual(
      expect.arrayContaining([{ value: 1, labels: { level: "warning" } }]),
    );

    // Session state change should clear stuck and loop tracking
    eventListener!({
      type: "session.state",
      state: "active",
      prevState: "idle",
      sessionKey: "sess-1",
    });

    const sessions = otelState.upDownCounters.get("openclaw_lens_sessions_active");
    expect(sessions?.add).toHaveBeenCalledWith(1, { state: "active" });
    expect(sessions?.add).toHaveBeenCalledWith(-1, { state: "idle" });

    // Stuck and loop maps should be cleared
    expect(observeGauge("openclaw_lens_sessions_stuck")).toEqual([{ value: 0 }]);
    expect(observeGauge("openclaw_lens_tool_loops_active")).toEqual(
      expect.arrayContaining([
        { value: 0, labels: { level: "warning" } },
        { value: 0, labels: { level: "critical" } },
      ]),
    );
  });

  test("session.stuck event tracks stuck sessions and max age", async () => {
    const { service } = createMetricsCollectorService(makeConfig());

    await service.start(makeCtx());

    eventListener!({
      type: "session.stuck",
      sessionKey: "sess-1",
      state: "active",
      ageMs: 30000,
    });
    eventListener!({
      type: "session.stuck",
      sessionKey: "sess-2",
      state: "active",
      ageMs: 60000,
    });

    expect(observeGauge("openclaw_lens_sessions_stuck")).toEqual([{ value: 2 }]);
    expect(observeGauge("openclaw_lens_stuck_session_max_age_ms")).toEqual([{ value: 60000 }]);
  });

  test("diagnostic.heartbeat updates queue depth AND active snapshot", async () => {
    const { service } = createMetricsCollectorService(makeConfig());

    await service.start(makeCtx());

    eventListener!({
      type: "diagnostic.heartbeat",
      webhooks: { received: 10, processed: 9, errors: 1 },
      active: 3,
      waiting: 2,
      queued: 5,
    });

    const queueDepth = observeGauge("openclaw_lens_queue_depth");
    expect(queueDepth).toEqual([{ value: 5 }]);

    const snapshot = observeGauge("openclaw_lens_sessions_active_snapshot");
    expect(snapshot).toEqual([{ value: 3 }]);
  });

  test("tool.loop event tracks looping sessions by level", async () => {
    const { service } = createMetricsCollectorService(makeConfig());

    await service.start(makeCtx());

    eventListener!({
      type: "tool.loop",
      sessionKey: "sess-1",
      level: "warning",
      action: "warn",
      detector: "generic_repeat",
      count: 3,
      message: "loop detected",
      toolName: "test_tool",
    });
    eventListener!({
      type: "tool.loop",
      sessionKey: "sess-2",
      level: "critical",
      action: "block",
      detector: "global_circuit_breaker",
      count: 10,
      message: "circuit breaker",
      toolName: "test_tool",
    });

    const loops = observeGauge("openclaw_lens_tool_loops_active");
    expect(loops).toEqual(
      expect.arrayContaining([
        { value: 1, labels: { level: "warning" } },
        { value: 1, labels: { level: "critical" } },
      ]),
    );
  });

  test("queue.lane.enqueue/dequeue events update per-lane depth", async () => {
    const { service } = createMetricsCollectorService(makeConfig());

    await service.start(makeCtx());

    eventListener!({
      type: "queue.lane.enqueue",
      lane: "default",
      queueSize: 3,
    });
    eventListener!({
      type: "queue.lane.enqueue",
      lane: "priority",
      queueSize: 1,
    });

    const lanes = observeGauge("openclaw_lens_queue_lane_depth");
    expect(lanes).toEqual(
      expect.arrayContaining([
        { value: 3, labels: { lane: "default" } },
        { value: 1, labels: { lane: "priority" } },
      ]),
    );

    // Dequeue should update depth
    eventListener!({
      type: "queue.lane.dequeue",
      lane: "default",
      queueSize: 2,
      waitMs: 50,
    });

    const lanesAfter = observeGauge("openclaw_lens_queue_lane_depth");
    expect(lanesAfter).toEqual(
      expect.arrayContaining([
        { value: 2, labels: { lane: "default" } },
        { value: 1, labels: { lane: "priority" } },
      ]),
    );
  });

  test("cache read ratio computes correctly over multiple events", async () => {
    const { service } = createMetricsCollectorService(makeConfig());

    await service.start(makeCtx());

    eventListener!({
      type: "model.usage",
      usage: { input: 100, cacheRead: 50 },
    });
    eventListener!({
      type: "model.usage",
      usage: { input: 200, cacheRead: 100 },
    });

    // Total input: 300, total cacheRead: 150 → ratio: 150 / (300 + 150) = 0.333...
    const ratio = observeGauge("openclaw_lens_cache_read_ratio");
    expect(ratio.length).toBe(1);
    expect(ratio[0].value).toBeCloseTo(150 / 450, 5);
  });

  test("stop() calls unsubscribe and shuts down all OTel providers", async () => {
    const { service } = createMetricsCollectorService(makeConfig());

    await service.start(makeCtx());

    expect(onDiagnosticEventMock).toHaveBeenCalledTimes(1);

    await service.stop!(makeCtx());

    expect(unsubscribeMock).toHaveBeenCalledTimes(1);
    expect(otelState.mockShutdown).toHaveBeenCalledTimes(1);
    expect(mockLogsShutdown).toHaveBeenCalledTimes(1);
    expect(mockTracesShutdown).toHaveBeenCalledTimes(1);
  });

  test("disabled config skips registration", async () => {
    const config = makeConfig({ metrics: { enabled: false } });
    const { service } = createMetricsCollectorService(config);
    const ctx = makeCtx();

    await service.start(ctx);

    expect(onDiagnosticEventMock).not.toHaveBeenCalled();
    expect(ctx.logger.info).toHaveBeenCalledWith(
      "grafana-lens: metrics collection disabled",
    );
  });

  test("logs info when diagnostics-otel is not enabled (self-sufficient)", async () => {
    const { service } = createMetricsCollectorService(makeConfig());
    const ctx = {
      ...makeCtx(),
      config: { diagnostics: { enabled: false } },
    };

    await service.start(ctx);

    expect(ctx.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("dashboards are self-sufficient"),
    );
  });

  test("logs info when diagnostics-otel is enabled", async () => {
    const { service } = createMetricsCollectorService(makeConfig());
    const ctx = makeCtx(); // has diagnostics.otel.enabled: true

    await service.start(ctx);

    expect(ctx.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("diagnostics-otel detected"),
    );
  });

  // ── Custom metrics store lifecycle ────────────────────────────────

  test("returns getCustomMetricsStore getter", () => {
    const { getCustomMetricsStore } = createMetricsCollectorService(makeConfig());
    // Before start(), store is null
    expect(getCustomMetricsStore()).toBeNull();
  });

  test("getCustomMetricsStore returns store after start()", async () => {
    const { service, getCustomMetricsStore } = createMetricsCollectorService(makeConfig());
    await service.start(makeCtx());

    expect(getCustomMetricsStore()).not.toBeNull();
  });

  test("getCustomMetricsStore returns null after stop()", async () => {
    const { service, getCustomMetricsStore } = createMetricsCollectorService(makeConfig());
    await service.start(makeCtx());
    expect(getCustomMetricsStore()).not.toBeNull();

    await service.stop!(makeCtx());
    expect(getCustomMetricsStore()).toBeNull();
  });

  // ══════════════════════════════════════════════════════════════════
  // Log emission tests
  // ══════════════════════════════════════════════════════════════════

  test("model.usage emits a structured log record with all fields", async () => {
    const { service } = createMetricsCollectorService(makeConfig());
    await service.start(makeCtx());
    mockLogEmit.mockClear(); // clear init confirmation log

    eventListener!({
      type: "model.usage",
      model: "claude-3",
      provider: "anthropic",
      channel: "whatsapp",
      usage: { input: 100, output: 50, cacheRead: 30, cacheWrite: 10 },
      costUsd: 0.01,
      durationMs: 2500,
      context: { limit: 200000, used: 50000 },
      sessionKey: "sess-1",
    });

    expect(mockLogEmit).toHaveBeenCalledTimes(1);
    const logCall = mockLogEmit.mock.calls[0][0];
    expect(logCall.body).toMatch(/^LLM claude-3/);
    expect(logCall.body).toContain("$0.01");
    expect(logCall.severityNumber).toBe(9); // INFO
    expect(logCall.attributes["event_name"]).toBe("model.usage");
    expect(logCall.attributes["openclaw_model"]).toBe("claude-3");
    expect(logCall.attributes["openclaw_provider"]).toBe("anthropic");
    expect(logCall.attributes["openclaw_cost_usd"]).toBe(0.01);
    expect(logCall.attributes["openclaw_tokens_total"]).toBe(190);
    expect(logCall.attributes["openclaw_session_key"]).toBe("sess-1");
    // model.usage no longer creates spans (handled by lifecycle) — trace_id comes from session context
    // Without an active session in lifecycle mock, no trace_id is present
  });

  test("session.stuck emits WARN severity log", async () => {
    const { service } = createMetricsCollectorService(makeConfig());
    await service.start(makeCtx());
    mockLogEmit.mockClear(); // clear init confirmation log

    eventListener!({
      type: "session.stuck",
      sessionKey: "sess-1",
      state: "active",
      ageMs: 45000,
    });

    const logCall = mockLogEmit.mock.calls[0][0];
    expect(logCall.severityNumber).toBe(13); // WARN
    expect(logCall.severityText).toBe("WARN");
    expect(logCall.attributes["openclaw_age_ms"]).toBe(45000);
  });

  test("webhook.error emits ERROR severity log", async () => {
    const { service } = createMetricsCollectorService(makeConfig());
    await service.start(makeCtx());
    mockLogEmit.mockClear(); // clear init confirmation log

    eventListener!({
      type: "webhook.error",
      channel: "telegram",
      updateType: "message",
      error: "Connection refused",
    });

    const logCall = mockLogEmit.mock.calls[0][0];
    expect(logCall.severityNumber).toBe(17); // ERROR
    expect(logCall.severityText).toBe("ERROR");
    expect(logCall.attributes["openclaw_error"]).toBe("Connection refused");
  });

  test("message.processed with error outcome emits ERROR log", async () => {
    const { service } = createMetricsCollectorService(makeConfig());
    await service.start(makeCtx());
    mockLogEmit.mockClear(); // clear init confirmation log

    eventListener!({
      type: "message.processed",
      outcome: "error",
      channel: "whatsapp",
      durationMs: 1000,
    });

    const logCall = mockLogEmit.mock.calls[0][0];
    expect(logCall.severityNumber).toBe(17); // ERROR
    expect(logCall.attributes["openclaw_outcome"]).toBe("error");
  });

  test("diagnostic.heartbeat emits log with all operational fields", async () => {
    const { service } = createMetricsCollectorService(makeConfig());
    await service.start(makeCtx());
    mockLogEmit.mockClear(); // clear init confirmation log

    eventListener!({
      type: "diagnostic.heartbeat",
      webhooks: { received: 10, processed: 9 },
      active: 3,
      waiting: 2,
      queued: 5,
    });

    const logCall = mockLogEmit.mock.calls[0][0];
    expect(logCall.body).toMatch(/^Heartbeat:/);
    expect(logCall.body).toContain("3 active");
    expect(logCall.attributes["openclaw_active"]).toBe(3);
    expect(logCall.attributes["openclaw_queued"]).toBe(5);
  });

  test("tool.loop critical emits ERROR severity log", async () => {
    const { service } = createMetricsCollectorService(makeConfig());
    await service.start(makeCtx());
    mockLogEmit.mockClear(); // clear init confirmation log

    eventListener!({
      type: "tool.loop",
      sessionKey: "sess-1",
      level: "critical",
      action: "block",
      detector: "global_circuit_breaker",
      count: 10,
      message: "circuit breaker triggered",
      toolName: "test_tool",
    });

    const logCall = mockLogEmit.mock.calls[0][0];
    expect(logCall.severityNumber).toBe(17); // ERROR
    expect(logCall.attributes["openclaw_detector"]).toBe("global_circuit_breaker");
  });

  test("run.attempt emits log with run_id and attempt", async () => {
    const { service } = createMetricsCollectorService(makeConfig());
    await service.start(makeCtx());
    mockLogEmit.mockClear(); // clear init confirmation log

    eventListener!({
      type: "run.attempt",
      runId: "run-abc",
      attempt: 2,
    });

    const logCall = mockLogEmit.mock.calls[0][0];
    expect(logCall.body).toBe("Run attempt #2 (run-abc)");
    expect(logCall.attributes["openclaw_run_id"]).toBe("run-abc");
    expect(logCall.attributes["openclaw_attempt"]).toBe(2);
  });

  // ══════════════════════════════════════════════════════════════════
  // Trace emission tests
  // ══════════════════════════════════════════════════════════════════

  test("model.usage does NOT create a trace span (handled by lifecycle telemetry)", async () => {
    const { service } = createMetricsCollectorService(makeConfig());
    await service.start(makeCtx());

    eventListener!({
      type: "model.usage",
      model: "claude-3",
      provider: "anthropic",
      usage: { input: 100, output: 50 },
      costUsd: 0.01,
      durationMs: 2500,
    });

    // model.usage span was removed — lifecycle creates `chat {model}` spans from llm_output
    expect(mockStartSpan).not.toHaveBeenCalled();
  });

  test("session.state does NOT create a trace span (removed — logged via Loki only)", async () => {
    const { service } = createMetricsCollectorService(makeConfig());
    await service.start(makeCtx());

    eventListener!({
      type: "session.state",
      state: "running",
      prevState: "idle",
      sessionKey: "sess-1",
      queueDepth: 3,
    });

    // session.state no longer creates trace spans — state transitions are logged via emitLogRecord
    expect(mockStartSpan).not.toHaveBeenCalled();
  });

  test("tool.loop creates a trace span with ERROR status when critical", async () => {
    const { service } = createMetricsCollectorService(makeConfig());
    await service.start(makeCtx());

    eventListener!({
      type: "tool.loop",
      sessionKey: "sess-1",
      level: "critical",
      action: "block",
      detector: "global_circuit_breaker",
      count: 10,
      message: "circuit breaker triggered",
      toolName: "grafana_query",
    });

    expect(mockStartSpan).toHaveBeenCalledWith(
      "openclaw.tool.loop grafana_query",
      expect.objectContaining({
        attributes: expect.objectContaining({
          "openclaw.tool_name": "grafana_query",
          "openclaw.level": "critical",
        }),
      }),
      expect.anything(), // parent context
    );
    expect(mockSpanSetStatus).toHaveBeenCalledWith({
      code: 2, // ERROR
      message: "circuit breaker triggered",
    });
  });

  test("webhook.error does NOT create a trace span (handled by diagnostics-otel)", async () => {
    const { service } = createMetricsCollectorService(makeConfig());
    await service.start(makeCtx());

    eventListener!({
      type: "webhook.error",
      channel: "telegram",
      updateType: "message",
      error: "timeout",
    });

    // Span was removed to avoid duplicate with diagnostics-otel
    expect(mockStartSpan).not.toHaveBeenCalled();
  });

  test("session.stuck does NOT create a trace span (handled by diagnostics-otel)", async () => {
    const { service } = createMetricsCollectorService(makeConfig());
    await service.start(makeCtx());

    eventListener!({
      type: "session.stuck",
      sessionKey: "sess-1",
      state: "active",
      ageMs: 60000,
    });

    // Span was removed to avoid duplicate with diagnostics-otel
    expect(mockStartSpan).not.toHaveBeenCalled();
  });

  test("events without spans do not create trace spans (e.g., diagnostic.heartbeat)", async () => {
    const { service } = createMetricsCollectorService(makeConfig());
    await service.start(makeCtx());

    eventListener!({
      type: "diagnostic.heartbeat",
      webhooks: { received: 1, processed: 1 },
      active: 1,
      waiting: 0,
      queued: 0,
    });

    expect(mockStartSpan).not.toHaveBeenCalled();
  });

  test("log-to-trace correlation includes trace_id and OTel context for span events", async () => {
    const { service } = createMetricsCollectorService(makeConfig());
    await service.start(makeCtx());
    mockLogEmit.mockClear(); // clear init confirmation log

    // Use tool.loop which still creates a trace span
    eventListener!({
      type: "tool.loop",
      sessionKey: "sess-1",
      level: "warning",
      action: "warn",
      detector: "single_tool_detector",
      count: 3,
      message: "tool repeating",
      toolName: "grafana_query",
    });

    // Log should have both string trace_id AND proto-level OTel context
    const logCall = mockLogEmit.mock.calls[0][0];
    expect(logCall.attributes["trace_id"]).toBe("test-trace-id-123");
    expect(logCall.context).toEqual({ _type: "SPAN_CONTEXT" });
  });

  test("diagnostic log uses session trace_id and context from lifecycle when available", async () => {
    const { service } = createMetricsCollectorService(makeConfig());
    await service.start(makeCtx());
    mockLogEmit.mockClear(); // clear init confirmation log

    // Mock lifecycle returning session context
    const mockSessionSpan = {
      spanContext: () => ({ traceId: "session-trace-123", spanId: "session-span-456" }),
    };
    mockGetSessionContextByAny.mockReturnValue({ span: mockSessionSpan, ctx: {} });

    eventListener!({
      type: "model.usage",
      model: "claude-3",
      provider: "anthropic",
      usage: { input: 100, output: 50 },
      costUsd: 0.01,
      sessionKey: "sess-1",
    });

    const logCall = mockLogEmit.mock.calls[0][0];
    // Should use session trace_id (not orphaned span)
    expect(logCall.attributes["trace_id"]).toBe("session-trace-123");
    expect(logCall.attributes["span_id"]).toBe("session-span-456");
    // Should also pass OTel context (from trace.setSpan with session span)
    expect(logCall.context).toEqual({ _type: "SPAN_CONTEXT" });
  });

  test("log for non-span events without session has no trace_id", async () => {
    const { service } = createMetricsCollectorService(makeConfig());
    await service.start(makeCtx());
    mockLogEmit.mockClear(); // clear init confirmation log

    eventListener!({
      type: "diagnostic.heartbeat",
      webhooks: { received: 1, processed: 1 },
      active: 1,
      waiting: 0,
      queued: 0,
    });

    const logCall = mockLogEmit.mock.calls[0][0];
    expect(logCall.attributes["trace_id"]).toBeUndefined();
  });

  // ══════════════════════════════════════════════════════════════════
  // Logs/traces disabled config
  // ══════════════════════════════════════════════════════════════════

  test("logs disabled when otlp.logs = false", async () => {
    const config = makeConfig({ otlp: { logs: false } });
    const { service } = createMetricsCollectorService(config);
    const ctx = makeCtx();

    await service.start(ctx);

    // Should NOT log the logs-enabled message
    const logCalls = ctx.logger.info.mock.calls.map((c: unknown[]) => c[0]);
    expect(logCalls).not.toEqual(expect.arrayContaining([
      expect.stringContaining("logs push enabled"),
    ]));

    // Emit an event — should not call log emit since logs are disabled
    // (But the mock still creates the otelLogs object since createOtelLogs is mocked.
    //  The real test is that the config flag controls initialization.)
  });

  test("traces disabled when otlp.traces = false", async () => {
    const config = makeConfig({ otlp: { traces: false } });
    const { service } = createMetricsCollectorService(config);
    const ctx = makeCtx();

    await service.start(ctx);

    const logCalls = ctx.logger.info.mock.calls.map((c: unknown[]) => c[0]);
    expect(logCalls).not.toEqual(expect.arrayContaining([
      expect.stringContaining("traces push enabled"),
    ]));
  });

  // ══════════════════════════════════════════════════════════════════
  // Getters for OTel providers
  // ══════════════════════════════════════════════════════════════════

  test("getOtelTraces returns tracer after start", async () => {
    const { service, getOtelTraces } = createMetricsCollectorService(makeConfig());
    expect(getOtelTraces()).toBeNull();

    await service.start(makeCtx());
    expect(getOtelTraces()).not.toBeNull();
  });

  test("getOtelLogs returns logger after start", async () => {
    const { service, getOtelLogs } = createMetricsCollectorService(makeConfig());
    expect(getOtelLogs()).toBeNull();

    await service.start(makeCtx());
    expect(getOtelLogs()).not.toBeNull();
  });

  test("getOtelTraces returns null after stop", async () => {
    const { service, getOtelTraces } = createMetricsCollectorService(makeConfig());
    await service.start(makeCtx());
    expect(getOtelTraces()).not.toBeNull();

    await service.stop!(makeCtx());
    expect(getOtelTraces()).toBeNull();
  });

  test("getOtelLogs returns null after stop", async () => {
    const { service, getOtelLogs } = createMetricsCollectorService(makeConfig());
    await service.start(makeCtx());
    expect(getOtelLogs()).not.toBeNull();

    await service.stop!(makeCtx());
    expect(getOtelLogs()).toBeNull();
  });

  // ══════════════════════════════════════════════════════════════════
  // gen_ai standard metrics + lifecycle instruments
  // ══════════════════════════════════════════════════════════════════

  test("creates gen_ai standard metric instruments", async () => {
    const { service } = createMetricsCollectorService(makeConfig());
    await service.start(makeCtx());

    // gen_ai.client.token.usage histogram
    expect(otelState.histograms.has("gen_ai.client.token.usage")).toBe(true);
    // gen_ai.client.operation.duration histogram
    expect(otelState.histograms.has("gen_ai.client.operation.duration")).toBe(true);
  });

  test("creates lifecycle custom metric instruments", async () => {
    const { service } = createMetricsCollectorService(makeConfig());
    await service.start(makeCtx());

    expect(otelState.counters.has("openclaw_lens_sessions_started_total")).toBe(true);
    expect(otelState.histograms.has("openclaw_lens_session_duration_ms")).toBe(true);
    expect(otelState.counters.has("openclaw_lens_compactions_total")).toBe(true);
    expect(otelState.histograms.has("openclaw_lens_compaction_messages_removed")).toBe(true);
    expect(otelState.counters.has("openclaw_lens_subagents_spawned_total")).toBe(true);
    expect(otelState.counters.has("openclaw_lens_subagent_outcomes_total")).toBe(true);
    expect(otelState.counters.has("openclaw_lens_message_delivery_total")).toBe(true);

    // SRE tool + cost metrics
    expect(otelState.counters.has("openclaw_lens_tool_calls_total")).toBe(true);
    expect(otelState.histograms.has("openclaw_lens_tool_duration_ms")).toBe(true);
    expect(otelState.counters.has("openclaw_lens_cost_by_model")).toBe(true);
  });

  test("model.usage records cost_by_model counter", async () => {
    const { service } = createMetricsCollectorService(makeConfig());
    await service.start(makeCtx());

    eventListener!({
      type: "model.usage",
      model: "claude-opus-4",
      provider: "anthropic",
      usage: { input: 100, output: 50 },
      costUsd: 0.05,
    });

    const costCounter = otelState.counters.get("openclaw_lens_cost_by_model");
    expect(costCounter?.add).toHaveBeenCalledWith(0.05, {
      model: "claude-opus-4",
      provider: "anthropic",
    });
  });

  test("getLifecycleTelemetry returns instance after start", async () => {
    const { service, getLifecycleTelemetry } = createMetricsCollectorService(makeConfig());
    expect(getLifecycleTelemetry()).toBeNull();

    await service.start(makeCtx());
    expect(getLifecycleTelemetry()).not.toBeNull();
  });

  test("getLifecycleTelemetry returns null after stop", async () => {
    const { service, getLifecycleTelemetry } = createMetricsCollectorService(makeConfig());
    await service.start(makeCtx());
    expect(getLifecycleTelemetry()).not.toBeNull();

    await service.stop!(makeCtx());
    expect(getLifecycleTelemetry()).toBeNull();
    expect(mockLifecycleDestroy).toHaveBeenCalledTimes(1);
  });

  // ══════════════════════════════════════════════════════════════════
  // Cost fallback estimation
  // ══════════════════════════════════════════════════════════════════

  test("model.usage uses fallback cost when costUsd is undefined", async () => {
    const { service } = createMetricsCollectorService(makeConfig());
    await service.start(makeCtx());

    eventListener!({
      type: "model.usage",
      model: "claude-opus-4-6",
      provider: "anthropic",
      usage: { input: 1000, output: 500, cacheRead: 200, cacheWrite: 100 },
      // costUsd intentionally omitted — fallback should kick in
    });

    // Fallback cost: (1000*15 + 500*75 + 200*1.5 + 100*18.75) / 1_000_000 = 0.054675
    const dailyCost = observeGauge("openclaw_lens_daily_cost_usd");
    expect(dailyCost[0].value).toBeCloseTo(0.054675, 5);

    // Cost-by-model counter should also fire
    const costCounter = otelState.counters.get("openclaw_lens_cost_by_model");
    expect(costCounter?.add).toHaveBeenCalledWith(
      expect.closeTo(0.054675, 5),
      expect.objectContaining({ model: "claude-opus-4-6", provider: "anthropic" }),
    );

    // Cost is now estimated directly in onLlmOutput via costEstimator callback
    // (no longer piped via accumulateCost from model.usage diagnostic events)
  });

  test("model.usage prefers evt.costUsd over fallback", async () => {
    const { service } = createMetricsCollectorService(makeConfig());
    await service.start(makeCtx());

    eventListener!({
      type: "model.usage",
      model: "claude-opus-4-6",
      provider: "anthropic",
      usage: { input: 1000, output: 500 },
      costUsd: 0.99, // Explicit cost provided — should be used
    });

    const dailyCost = observeGauge("openclaw_lens_daily_cost_usd");
    expect(dailyCost[0].value).toBe(0.99);
  });

  test("model.usage with unknown model and no costUsd has zero cost", async () => {
    const { service } = createMetricsCollectorService(makeConfig());
    await service.start(makeCtx());

    eventListener!({
      type: "model.usage",
      model: "gpt-4o",
      provider: "openai",
      usage: { input: 1000, output: 500 },
      // costUsd omitted, and openai not in fallback table
    });

    const dailyCost = observeGauge("openclaw_lens_daily_cost_usd");
    expect(dailyCost[0].value).toBe(0);
  });

  // ══════════════════════════════════════════════════════════════════
  // forceFlush after critical events
  // ══════════════════════════════════════════════════════════════════

  test("forceFlush NOT called after model.usage event (batched for efficiency)", async () => {
    const { service } = createMetricsCollectorService(makeConfig());
    await service.start(makeCtx());

    eventListener!({
      type: "model.usage",
      model: "claude-3",
      provider: "anthropic",
      usage: { input: 100, output: 50 },
    });

    expect(mockLogsForceFlush).not.toHaveBeenCalled();
  });

  test("forceFlush called for logs only after session.state event (no trace span)", async () => {
    const { service } = createMetricsCollectorService(makeConfig());
    await service.start(makeCtx());

    eventListener!({
      type: "session.state",
      state: "active",
      prevState: "idle",
      sessionKey: "sess-1",
    });

    // session.state no longer creates a trace span, so only logs flush
    expect(mockLogsForceFlush).toHaveBeenCalledTimes(1);
    expect(mockTracesForceFlush).not.toHaveBeenCalled();
  });

  test("forceFlush called after message.processed event (logs only, no trace span)", async () => {
    const { service } = createMetricsCollectorService(makeConfig());
    await service.start(makeCtx());

    eventListener!({
      type: "message.processed",
      outcome: "completed",
      channel: "whatsapp",
      durationMs: 500,
    });

    // message.processed no longer creates a trace span (removed to avoid diagnostics-otel dupe),
    // but logs are still emitted and flushed
    expect(mockLogsForceFlush).toHaveBeenCalledTimes(1);
    // Traces flush is NOT called because no span was created for this event
    expect(mockTracesForceFlush).toHaveBeenCalledTimes(0);
  });

  test("forceFlush NOT called for non-critical events (e.g., diagnostic.heartbeat)", async () => {
    const { service } = createMetricsCollectorService(makeConfig());
    await service.start(makeCtx());

    eventListener!({
      type: "diagnostic.heartbeat",
      webhooks: { received: 1, processed: 1 },
      active: 1,
      waiting: 0,
      queued: 0,
    });

    expect(mockLogsForceFlush).not.toHaveBeenCalled();
    expect(mockTracesForceFlush).not.toHaveBeenCalled();
  });

  // ══════════════════════════════════════════════════════════════════
  // Severity downgrades (Part 7)
  // ══════════════════════════════════════════════════════════════════

  test("diagnostic.heartbeat emits DEBUG severity (downgraded from INFO)", async () => {
    const { service } = createMetricsCollectorService(makeConfig());
    await service.start(makeCtx());
    mockLogEmit.mockClear(); // clear init confirmation log

    eventListener!({
      type: "diagnostic.heartbeat",
      webhooks: { received: 1, processed: 1 },
      active: 1,
      waiting: 0,
      queued: 0,
    });

    const logCall = mockLogEmit.mock.calls[0][0];
    expect(logCall.severityNumber).toBe(5); // DEBUG
    expect(logCall.severityText).toBe("DEBUG");
  });

  test("queue.lane.enqueue emits DEBUG severity", async () => {
    const { service } = createMetricsCollectorService(makeConfig());
    await service.start(makeCtx());
    mockLogEmit.mockClear(); // clear init confirmation log

    eventListener!({
      type: "queue.lane.enqueue",
      lane: "default",
      queueSize: 3,
    });

    const logCall = mockLogEmit.mock.calls[0][0];
    expect(logCall.severityNumber).toBe(5); // DEBUG
    expect(logCall.severityText).toBe("DEBUG");
  });

  test("message.queued emits DEBUG severity", async () => {
    const { service } = createMetricsCollectorService(makeConfig());
    await service.start(makeCtx());

    // Clear logs from startup (init confirmation log)
    mockLogEmit.mockClear();

    eventListener!({
      type: "message.queued",
      source: "webhook",
      channel: "telegram",
      queueDepth: 2,
    });

    const logCall = mockLogEmit.mock.calls[0][0];
    expect(logCall.severityNumber).toBe(5); // DEBUG
    expect(logCall.severityText).toBe("DEBUG");
  });

  test("run.attempt #1 emits DEBUG severity, retry emits WARN", async () => {
    const { service } = createMetricsCollectorService(makeConfig());
    await service.start(makeCtx());

    // Clear logs from startup (init confirmation log)
    mockLogEmit.mockClear();

    // First attempt → DEBUG
    eventListener!({ type: "run.attempt", runId: "run-1", attempt: 1 });
    expect(mockLogEmit.mock.calls[0][0].severityNumber).toBe(5); // DEBUG

    // Retry (attempt > 1) → WARN
    eventListener!({ type: "run.attempt", runId: "run-1", attempt: 2 });
    expect(mockLogEmit.mock.calls[1][0].severityNumber).toBe(13); // WARN
    expect(mockLogEmit.mock.calls[1][0].severityText).toBe("WARN");
  });

  // ══════════════════════════════════════════════════════════════════
  // Component labels (Part 8)
  // ══════════════════════════════════════════════════════════════════

  test("all diagnostic log emissions include component=diagnostic label", async () => {
    const { service } = createMetricsCollectorService(makeConfig());
    await service.start(makeCtx());

    eventListener!({
      type: "model.usage",
      model: "claude-3",
      provider: "anthropic",
      usage: { input: 100, output: 50 },
    });

    // Find the diagnostic log (skip the app init confirmation log)
    const diagLog = mockLogEmit.mock.calls.find(
      (c: unknown[]) => (c[0] as Record<string, Record<string, unknown>>)?.attributes?.["component"] === "diagnostic",
    );
    expect(diagLog).toBeTruthy();
    expect((diagLog![0] as Record<string, Record<string, unknown>>).attributes["component"]).toBe("diagnostic");
  });

  // ══════════════════════════════════════════════════════════════════
  // App log forwarding (Part 3)
  // ══════════════════════════════════════════════════════════════════

  test("registerLogTransport is called on start (app log forwarding)", async () => {
    const { service } = createMetricsCollectorService(makeConfig());
    await service.start(makeCtx());

    expect(registerLogTransportMock).toHaveBeenCalledTimes(1);
    expect(registerLogTransportMock).toHaveBeenCalledWith(expect.any(Function));
  });

  test("app log forwarding is disabled when forwardAppLogs=false", async () => {
    const config = makeConfig({ otlp: { forwardAppLogs: false } });
    const { service } = createMetricsCollectorService(config);
    await service.start(makeCtx());

    expect(registerLogTransportMock).not.toHaveBeenCalled();
  });

  test("app log transport callback emits log records with component=app", async () => {
    let transportCallback: ((obj: unknown) => void) | null = null;
    registerLogTransportMock.mockImplementation((cb: (obj: unknown) => void) => {
      transportCallback = cb;
      return vi.fn();
    });

    const { service } = createMetricsCollectorService(makeConfig());
    await service.start(makeCtx());

    expect(transportCallback).not.toBeNull();

    // Simulate a tslog call
    transportCallback!({
      _meta: {
        logLevelName: "INFO",
        name: "gateway",
        parentNames: ["openclaw"],
        date: new Date(),
        path: { filePath: "src/gateway.ts", lineNumber: 42, functionName: "start" },
      },
      0: "Gateway started successfully",
    });

    // Find the log emission from the transport (not the init confirmation log)
    const logCalls = mockLogEmit.mock.calls;
    const appLog = logCalls.find(
      (c: unknown[]) => (c[0] as Record<string, Record<string, unknown>>)?.attributes?.["event_name"] === "app.log",
    );
    expect(appLog).toBeTruthy();
    const attrs = (appLog![0] as Record<string, Record<string, unknown>>).attributes;
    expect(attrs["event_name"]).toBe("app.log");
    expect(attrs["openclaw_logger"]).toBe("gateway");
    expect(attrs["code_filepath"]).toBe("src/gateway.ts");
    expect(attrs["code_lineno"]).toBe(42);
  });

  test("stop() unsubscribes log transport", async () => {
    const unsubLogMock = vi.fn();
    registerLogTransportMock.mockReturnValue(unsubLogMock);

    const { service } = createMetricsCollectorService(makeConfig());
    await service.start(makeCtx());
    await service.stop!(makeCtx());

    expect(unsubLogMock).toHaveBeenCalledTimes(1);
  });

  // ══════════════════════════════════════════════════════════════════
  // H1: ObservableGauge callback error resilience
  // ══════════════════════════════════════════════════════════════════

  test("gauge callback error does not propagate (safeCallback)", async () => {
    // Use an alertStore mock that throws in totalReceived()
    const throwingAlertStore = {
      totalReceived: () => { throw new Error("boom"); },
      getPendingAlerts: () => { throw new Error("boom2"); },
    };
    const { service } = createMetricsCollectorService(makeConfig(), throwingAlertStore as never);
    const ctx = makeCtx();

    await service.start(ctx);

    // Observe the alert_webhooks_received gauge — should not throw
    expect(() => observeGauge("openclaw_lens_alert_webhooks_received")).not.toThrow();
    expect(() => observeGauge("openclaw_lens_alert_webhooks_pending")).not.toThrow();

    // Warning should have been logged
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("gauge callback error (alert_webhooks_received)"),
    );

    await service.stop!(ctx);
  });

  // ══════════════════════════════════════════════════════════════════
  // H3: Midnight cost reset uses setTimeout targeting next midnight
  // ══════════════════════════════════════════════════════════════════

  test("midnight reset timeout targets approximately ms-until-midnight", async () => {
    vi.useFakeTimers();
    try {
      const setTimeoutSpy = vi.spyOn(global, "setTimeout");
      const { service } = createMetricsCollectorService(makeConfig());
      await service.start(makeCtx());

      // Find the setTimeout call for midnight reset (the one with large ms value)
      // It should be approximately ms-until-midnight (+100ms margin)
      const now = new Date();
      const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      const expectedMs = tomorrow.getTime() - now.getTime() + 100;

      const midnightCall = setTimeoutSpy.mock.calls.find(
        (call) => typeof call[1] === "number" && call[1] > 60_000,
      );
      expect(midnightCall).toBeTruthy();
      // Should be within 1 second of expected (timer precision)
      expect(midnightCall![1]).toBeGreaterThan(expectedMs - 1000);
      expect(midnightCall![1]).toBeLessThanOrEqual(expectedMs + 1000);

      await service.stop!(makeCtx());
      setTimeoutSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // M2: Warn when lifecycle telemetry disabled
  // ══════════════════════════════════════════════════════════════════

  test("warns when otlp.logs is disabled (lifecycle telemetry disabled)", async () => {
    const config = makeConfig({ otlp: { logs: false } });
    const { service } = createMetricsCollectorService(config);
    const ctx = makeCtx();

    await service.start(ctx);

    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("lifecycle telemetry disabled"),
    );
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("otlp.logs"),
    );

    await service.stop!(ctx);
  });

  test("warns when otlp.traces is disabled (lifecycle telemetry disabled)", async () => {
    const config = makeConfig({ otlp: { traces: false } });
    const { service } = createMetricsCollectorService(config);
    const ctx = makeCtx();

    await service.start(ctx);

    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("lifecycle telemetry disabled"),
    );
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("otlp.traces"),
    );

    await service.stop!(ctx);
  });

  // ══════════════════════════════════════════════════════════════════
  // Issue #4: daily_cost_usd gauge — costUsd=0 falls through to fallback
  // ══════════════════════════════════════════════════════════════════

  test("model.usage with costUsd=0 falls through to fallback pricing", async () => {
    const { service } = createMetricsCollectorService(makeConfig());
    await service.start(makeCtx());

    // Send model.usage with costUsd: 0 — should trigger fallback pricing.
    // Use "claude-opus-4-6" which is in the KNOWN_MODEL_PRICING table.
    eventListener!({
      type: "model.usage",
      model: "claude-opus-4-6",
      provider: "anthropic",
      usage: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 },
      costUsd: 0, // This is the bug — || operator treats 0 as falsy
    });

    // Daily cost should NOT be 0 — fallback pricing should kick in
    const dailyCost = observeGauge("openclaw_lens_daily_cost_usd");
    expect(dailyCost.length).toBe(1);
    // The fallback pricing for claude-opus-4-6 is known — should produce > 0
    expect(dailyCost[0].value).toBeGreaterThan(0);
  });

  test("model.usage emits debug log when cost is zero", async () => {
    const { service } = createMetricsCollectorService(makeConfig());
    await service.start(makeCtx());

    // Send model.usage with unknown model and costUsd: 0 — neither resolves
    eventListener!({
      type: "model.usage",
      model: "completely-unknown-model-xyz",
      provider: "unknown-provider",
      usage: { input: 100, output: 50 },
      costUsd: 0,
    });

    // Should emit a debug log about cost=0
    const debugLogCalls = mockLogEmit.mock.calls.filter(
      (call: unknown[]) => {
        const log = call[0] as Record<string, unknown>;
        const attrs = log.attributes as Record<string, unknown>;
        return attrs?.["event_name"] === "cost.zero";
      },
    );
    expect(debugLogCalls.length).toBe(1);
    const debugLog = debugLogCalls[0][0] as Record<string, unknown>;
    expect(debugLog.body).toMatch(/cost=0/);
    expect((debugLog.attributes as Record<string, unknown>)["openclaw_model"]).toBe("completely-unknown-model-xyz");
  });

  // ══════════════════════════════════════════════════════════════════
  // Issue #3: App log forwarding confirmation log
  // ══════════════════════════════════════════════════════════════════

  test("app log forwarding emits confirmation log on init", async () => {
    const { service } = createMetricsCollectorService(makeConfig());
    await service.start(makeCtx());

    // After start(), the app log forwarding init log should have been emitted
    const initLogCalls = mockLogEmit.mock.calls.filter(
      (call: unknown[]) => {
        const log = call[0] as Record<string, unknown>;
        const attrs = log.attributes as Record<string, unknown>;
        return attrs?.["event_name"] === "app.log_forwarding.init";
      },
    );
    expect(initLogCalls.length).toBe(1);
    const initLog = initLogCalls[0][0] as Record<string, unknown>;
    expect(initLog.body).toMatch(/App log forwarding initialized/);
    expect((initLog.attributes as Record<string, unknown>)["component"]).toBe("app");
    expect((initLog.attributes as Record<string, unknown>)["event_domain"]).toBe("openclaw");

    await service.stop!(makeCtx());
  });

  // ══════════════════════════════════════════════════════════════════
  // Self-sufficient counters/histograms (replacing diagnostics-otel)
  // ══════════════════════════════════════════════════════════════════

  test("creates all 8 self-sufficient instruments", async () => {
    const { service } = createMetricsCollectorService(makeConfig());
    await service.start(makeCtx());

    // Counters
    expect(otelState.counters.has("openclaw_lens_tokens")).toBe(true);
    expect(otelState.counters.has("openclaw_lens_messages_processed")).toBe(true);
    expect(otelState.counters.has("openclaw_lens_webhook_received")).toBe(true);
    expect(otelState.counters.has("openclaw_lens_webhook_error")).toBe(true);
    expect(otelState.counters.has("openclaw_lens_queue_lane_enqueue")).toBe(true);
    expect(otelState.counters.has("openclaw_lens_queue_lane_dequeue")).toBe(true);

    // Histograms
    expect(otelState.histograms.has("openclaw_lens_webhook_duration_ms")).toBe(true);
    expect(otelState.histograms.has("openclaw_lens_queue_wait_ms")).toBe(true);
  });

  test("model.usage records openclaw_lens_tokens counter for each token type", async () => {
    const { service } = createMetricsCollectorService(makeConfig());
    await service.start(makeCtx());

    eventListener!({
      type: "model.usage",
      model: "claude-opus-4-6",
      provider: "anthropic",
      channel: "telegram",
      usage: { input: 1000, output: 500, cacheRead: 200, cacheWrite: 100 },
      costUsd: 0.05,
    });

    const tokens = otelState.counters.get("openclaw_lens_tokens");
    expect(tokens?.add).toHaveBeenCalledWith(1000, { provider: "anthropic", model: "claude-opus-4-6", token: "input" });
    expect(tokens?.add).toHaveBeenCalledWith(500, { provider: "anthropic", model: "claude-opus-4-6", token: "output" });
    expect(tokens?.add).toHaveBeenCalledWith(200, { provider: "anthropic", model: "claude-opus-4-6", token: "cacheRead" });
    expect(tokens?.add).toHaveBeenCalledWith(100, { provider: "anthropic", model: "claude-opus-4-6", token: "cacheWrite" });
  });

  test("message.processed records openclaw_lens_messages_processed counter", async () => {
    const { service } = createMetricsCollectorService(makeConfig());
    await service.start(makeCtx());

    eventListener!({
      type: "message.processed",
      outcome: "completed",
      channel: "whatsapp",
      durationMs: 500,
    });

    const msgs = otelState.counters.get("openclaw_lens_messages_processed");
    expect(msgs?.add).toHaveBeenCalledWith(1, { outcome: "completed", channel: "whatsapp" });
  });

  test("message.processed with error outcome records counter", async () => {
    const { service } = createMetricsCollectorService(makeConfig());
    await service.start(makeCtx());

    eventListener!({
      type: "message.processed",
      outcome: "error",
      channel: "telegram",
      durationMs: 1000,
    });

    const msgs = otelState.counters.get("openclaw_lens_messages_processed");
    expect(msgs?.add).toHaveBeenCalledWith(1, { outcome: "error", channel: "telegram" });
  });

  test("webhook.received records openclaw_lens_webhook_received counter", async () => {
    const { service } = createMetricsCollectorService(makeConfig());
    await service.start(makeCtx());

    eventListener!({
      type: "webhook.received",
      channel: "telegram",
      updateType: "message",
    });

    const wh = otelState.counters.get("openclaw_lens_webhook_received");
    expect(wh?.add).toHaveBeenCalledWith(1, { channel: "telegram", update_type: "message" });
  });

  test("webhook.error records openclaw_lens_webhook_error counter", async () => {
    const { service } = createMetricsCollectorService(makeConfig());
    await service.start(makeCtx());

    eventListener!({
      type: "webhook.error",
      channel: "slack",
      updateType: "callback",
      error: "Connection refused",
    });

    const whErr = otelState.counters.get("openclaw_lens_webhook_error");
    expect(whErr?.add).toHaveBeenCalledWith(1, { channel: "slack", update_type: "callback" });
  });

  test("webhook.processed records openclaw_lens_webhook_duration_ms histogram", async () => {
    const { service } = createMetricsCollectorService(makeConfig());
    await service.start(makeCtx());

    eventListener!({
      type: "webhook.processed",
      channel: "telegram",
      updateType: "message",
      durationMs: 250,
    });

    const whDur = otelState.histograms.get("openclaw_lens_webhook_duration_ms");
    expect(whDur?.record).toHaveBeenCalledWith(250, { channel: "telegram", update_type: "message" });
  });

  test("queue.lane.enqueue records openclaw_lens_queue_lane_enqueue counter", async () => {
    const { service } = createMetricsCollectorService(makeConfig());
    await service.start(makeCtx());

    eventListener!({
      type: "queue.lane.enqueue",
      lane: "priority",
      queueSize: 3,
    });

    const enq = otelState.counters.get("openclaw_lens_queue_lane_enqueue");
    expect(enq?.add).toHaveBeenCalledWith(1, { lane: "priority" });
  });

  test("queue.lane.dequeue records counter and histogram", async () => {
    const { service } = createMetricsCollectorService(makeConfig());
    await service.start(makeCtx());

    eventListener!({
      type: "queue.lane.dequeue",
      lane: "default",
      queueSize: 2,
      waitMs: 150,
    });

    const deq = otelState.counters.get("openclaw_lens_queue_lane_dequeue");
    expect(deq?.add).toHaveBeenCalledWith(1, { lane: "default" });

    const waitHist = otelState.histograms.get("openclaw_lens_queue_wait_ms");
    expect(waitHist?.record).toHaveBeenCalledWith(150, { lane: "default" });
  });

  // ══════════════════════════════════════════════════════════════════
  // Config-based pricing fallback
  // ══════════════════════════════════════════════════════════════════

  test("model.usage uses config-based pricing when costUsd is absent and model is in config", async () => {
    const { service } = createMetricsCollectorService(makeConfig());
    const ctx = makeCtx();
    // Override config with model pricing (cast to bypass strict OpenClaw types)
    (ctx as Record<string, unknown>).config = {
      diagnostics: { enabled: true, otel: { enabled: true } },
      models: {
        providers: {
          openai: {
            models: [
              { id: "gpt-4o", cost: { input: 5, output: 15, cacheRead: 2.5, cacheWrite: 6.25 } },
            ],
          },
        },
      },
    };

    await service.start(ctx);

    // gpt-4o is NOT in the hardcoded KNOWN_MODEL_PRICING table,
    // but IS in ctx.config — config-based pricing should resolve it
    eventListener!({
      type: "model.usage",
      model: "gpt-4o",
      provider: "openai",
      usage: { input: 1000, output: 500 },
      // costUsd intentionally omitted
    });

    // Expected: (1000*5 + 500*15) / 1_000_000 = 0.0125
    const dailyCost = observeGauge("openclaw_lens_daily_cost_usd");
    expect(dailyCost[0].value).toBeCloseTo(0.0125, 5);
  });

  test("model.usage falls to hardcoded pricing when both costUsd and config are absent", async () => {
    const { service } = createMetricsCollectorService(makeConfig());
    const ctx = {
      ...makeCtx(),
      config: {
        diagnostics: { enabled: true, otel: { enabled: true } },
        // No models.providers configured
      },
    };

    await service.start(ctx);

    // claude-opus-4-6 IS in the hardcoded KNOWN_MODEL_PRICING table
    eventListener!({
      type: "model.usage",
      model: "claude-opus-4-6",
      provider: "anthropic",
      usage: { input: 1000, output: 500 },
      // costUsd intentionally omitted, no config pricing either
    });

    // Hardcoded: (1000*15 + 500*75) / 1_000_000 = 0.0525
    const dailyCost = observeGauge("openclaw_lens_daily_cost_usd");
    expect(dailyCost[0].value).toBeCloseTo(0.0525, 5);
  });
});
