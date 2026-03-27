import { beforeEach, describe, expect, test, vi } from "vitest";

// ── Hoisted mocks ────────────────────────────────────────────────────

const searchTracesMock = vi.hoisted(() => vi.fn());
const getTraceMock = vi.hoisted(() => vi.fn());
const getDashboardMock = vi.hoisted(() => vi.fn());
const listDatasourcesMock = vi.hoisted(() => vi.fn());

vi.mock("../grafana-client.js", () => ({
  GrafanaClient: class {
    searchTraces = searchTracesMock;
    getTrace = getTraceMock;
    getDashboard = getDashboardMock;
    listDatasources = listDatasourcesMock;
    getUrl() { return "http://localhost:3000"; }
  },
}));

// ── Imports (after mocks) ────────────────────────────────────────────

import { createQueryTracesToolFactory, MAX_SEARCH_TRACES, MAX_TRACE_SPANS } from "./query-traces.js";
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

function parse(result: unknown) {
  return JSON.parse(getTextContent(result as { content: Array<{ type: string; text?: string }> }));
}

// ── Fixtures ─────────────────────────────────────────────────────────

function makeSearchResult(count: number) {
  return {
    traces: Array.from({ length: count }, (_, i) => ({
      traceID: `trace${String(i).padStart(30, "0")}aa`,
      rootServiceName: "openclaw",
      rootTraceName: `chat claude-3-opus`,
      startTimeUnixNano: String(1700000000000000000n + BigInt(i) * 1000000000n),
      durationMs: 100 + i * 10,
      spanSets: [{ spans: [], matched: 5 + i }],
    })),
  };
}

function makeTraceResult(spanCount: number) {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "openclaw" } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: "grafana-lens" },
            spans: Array.from({ length: spanCount }, (_, i) => ({
              traceId: "abc123def456" + "0".repeat(20),
              spanId: `span${i}` + "0".repeat(10),
              parentSpanId: i === 0 ? "" : `span${i - 1}` + "0".repeat(10),
              name: i === 0 ? "invoke_agent openclaw" : `chat claude-3-opus-${i}`,
              startTimeUnixNano: String(1700000000000000000n + BigInt(i) * 500000000n),
              endTimeUnixNano: String(1700000000500000000n + BigInt(i) * 500000000n),
              status: { code: i === 2 ? 2 : 1 },
              kind: i === 0 ? 1 : 3,
              attributes: [
                { key: "gen_ai.system", value: { stringValue: "anthropic" } },
                { key: "gen_ai.request.model", value: { stringValue: "claude-3-opus" } },
                { key: "gen_ai.usage.input_tokens", value: { intValue: "1500" } },
                { key: "gen_ai.usage.output_tokens", value: { intValue: "500" } },
                { key: "gen_ai.response.finish_reason", value: { stringValue: "stop" } },
                { key: "is_cached", value: { boolValue: true } },
                { key: "latency_s", value: { doubleValue: 1.23 } },
              ],
            })),
          },
        ],
      },
    ],
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("grafana_query_traces tool", () => {
  beforeEach(() => {
    searchTracesMock.mockReset();
    getTraceMock.mockReset();
    getDashboardMock.mockReset();
    listDatasourcesMock.mockReset();
  });

  test("search returns formatted trace summaries", async () => {
    searchTracesMock.mockResolvedValueOnce(makeSearchResult(3));

    const tool = createQueryTracesToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-1", {
      datasourceUid: "tempo1",
      query: '{ resource.service.name = "openclaw" }',
    });

    const parsed = parse(result);
    expect(parsed.status).toBe("success");
    expect(parsed.queryType).toBe("search");
    expect(parsed.totalTraces).toBe(3);
    expect(parsed.traces).toHaveLength(3);
    expect(parsed.traces[0]).toMatchObject({
      traceId: expect.any(String),
      rootServiceName: "openclaw",
      rootTraceName: "chat claude-3-opus",
      durationMs: expect.any(Number),
      startTime: expect.stringMatching(/^\d{4}-\d{2}/),
      spanCount: 5,
    });
    expect(parsed.truncated).toBeUndefined();
  });

  test("search truncates at MAX_SEARCH_TRACES", async () => {
    searchTracesMock.mockResolvedValueOnce(makeSearchResult(60));

    const tool = createQueryTracesToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-1", {
      datasourceUid: "tempo1",
      query: "{ }",
    });

    const parsed = parse(result);
    expect(parsed.totalTraces).toBe(60);
    expect(parsed.traces).toHaveLength(MAX_SEARCH_TRACES);
    expect(parsed.truncated).toBe(true);
    expect(parsed.truncationHint).toContain("50 of 60");
  });

  // ── correlationHint ─────────────────────────────────────────────────

  test("search with results includes correlationHint", async () => {
    searchTracesMock.mockResolvedValueOnce(makeSearchResult(3));

    const tool = createQueryTracesToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-1", {
      datasourceUid: "tempo1",
      query: '{ resource.service.name = "openclaw" }',
    });

    const parsed = parse(result);
    expect(parsed.correlationHint).toBeDefined();
    expect(parsed.correlationHint.tool).toBe("grafana_query_logs");
    expect(parsed.correlationHint.logQuery).toContain("| json | trace_id =");
    expect(parsed.correlationHint.logQuery).toContain(parsed.traces[0].traceId);
    expect(parsed.correlationHint.tip).toContain("|=");
  });

  test("search with no results omits correlationHint", async () => {
    searchTracesMock.mockResolvedValueOnce({ traces: [] });

    const tool = createQueryTracesToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-1", {
      datasourceUid: "tempo1",
      query: '{ resource.service.name = "nonexistent" }',
    });

    const parsed = parse(result);
    expect(parsed.correlationHint).toBeUndefined();
    expect(parsed.hint).toBeDefined();
  });

  test("get trace includes correlationHint", async () => {
    getTraceMock.mockResolvedValueOnce(makeTraceResult(3));
    const traceId = "abc123def456" + "0".repeat(20);

    const tool = createQueryTracesToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-1", {
      datasourceUid: "tempo1",
      query: traceId,
      queryType: "get",
    });

    const parsed = parse(result);
    expect(parsed.correlationHint).toBeDefined();
    expect(parsed.correlationHint.tool).toBe("grafana_query_logs");
    expect(parsed.correlationHint.logQuery).toContain(traceId);
    expect(parsed.correlationHint.logQuery).toContain("| json | trace_id =");
  });

  test("get trace returns flattened spans with resolved attributes", async () => {
    getTraceMock.mockResolvedValueOnce(makeTraceResult(3));

    const tool = createQueryTracesToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-1", {
      datasourceUid: "tempo1",
      query: "abc123def456" + "0".repeat(20),
      queryType: "get",
    });

    const parsed = parse(result);
    expect(parsed.status).toBe("success");
    expect(parsed.queryType).toBe("get");
    expect(parsed.totalSpans).toBe(3);
    expect(parsed.spans).toHaveLength(3);

    const firstSpan = parsed.spans[0];
    expect(firstSpan.serviceName).toBe("openclaw");
    expect(firstSpan.operationName).toBe("invoke_agent openclaw");
    expect(firstSpan.status).toBe("ok");
    expect(firstSpan.kind).toBe("internal");
    expect(firstSpan.durationMs).toBe(500);
    expect(firstSpan.startTime).toMatch(/^\d{4}-\d{2}/);

    // Attribute resolution
    expect(firstSpan.attributes["gen_ai.system"]).toBe("anthropic");
    expect(firstSpan.attributes["gen_ai.usage.input_tokens"]).toBe(1500);
    expect(firstSpan.attributes["is_cached"]).toBe(true);
    expect(firstSpan.attributes["latency_s"]).toBe(1.23);
  });

  test("get trace truncates at MAX_TRACE_SPANS", async () => {
    getTraceMock.mockResolvedValueOnce(makeTraceResult(250));

    const tool = createQueryTracesToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-1", {
      datasourceUid: "tempo1",
      query: "abc123",
      queryType: "get",
    });

    const parsed = parse(result);
    expect(parsed.totalSpans).toBe(250);
    expect(parsed.spans).toHaveLength(MAX_TRACE_SPANS);
    expect(parsed.truncated).toBe(true);
  });

  test("status code mapping (0=unset, 1=ok, 2=error)", async () => {
    getTraceMock.mockResolvedValueOnce(makeTraceResult(3));

    const tool = createQueryTracesToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-1", {
      datasourceUid: "tempo1",
      query: "trace-id",
      queryType: "get",
    });

    const parsed = parse(result);
    // Span 0 has code 1 (ok), span 2 has code 2 (error)
    expect(parsed.spans[0].status).toBe("ok");
    expect(parsed.spans[2].status).toBe("error");
  });

  test("BigInt duration calculation", async () => {
    getTraceMock.mockResolvedValueOnce({
      resourceSpans: [
        {
          resource: { attributes: [] },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: "t1",
                  spanId: "s1",
                  name: "test",
                  startTimeUnixNano: "1700000000000000000",
                  endTimeUnixNano: "1700000001234000000",
                  status: { code: 0 },
                  attributes: [],
                },
              ],
            },
          ],
        },
      ],
    });

    const tool = createQueryTracesToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-1", {
      datasourceUid: "tempo1",
      query: "t1",
      queryType: "get",
    });

    const parsed = parse(result);
    expect(parsed.spans[0].durationMs).toBe(1234);
    expect(parsed.spans[0].status).toBe("unset");
  });

  test("panel resolution for Tempo panels", async () => {
    getDashboardMock.mockResolvedValueOnce({
      dashboard: {
        panels: [
          {
            id: 5,
            title: "Session Traces",
            type: "traces",
            datasource: { type: "tempo", uid: "tempo1" },
            targets: [{ query: '{ resource.service.name = "openclaw" }' }],
          },
        ],
      },
    });
    listDatasourcesMock.mockResolvedValueOnce([
      { uid: "tempo1", name: "Tempo", type: "tempo", isDefault: false },
    ]);
    searchTracesMock.mockResolvedValueOnce(makeSearchResult(2));

    const tool = createQueryTracesToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-1", {
      dashboardUid: "dash1",
      panelId: 5,
    });

    const parsed = parse(result);
    expect(parsed.status).toBe("success");
    expect(parsed.resolvedFrom).toBe("panel");
    expect(parsed.panelTitle).toBe("Session Traces");
    expect(parsed.totalTraces).toBe(2);
  });

  test("panel resolution redirects non-Tempo panels", async () => {
    getDashboardMock.mockResolvedValueOnce({
      dashboard: {
        panels: [
          {
            id: 1,
            title: "CPU Usage",
            type: "timeseries",
            datasource: { type: "prometheus", uid: "prom1" },
            targets: [{ expr: "rate(cpu_usage[5m])" }],
          },
        ],
      },
    });
    listDatasourcesMock.mockResolvedValueOnce([
      { uid: "prom1", name: "Prometheus", type: "prometheus", isDefault: true },
    ]);

    const tool = createQueryTracesToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-1", {
      dashboardUid: "dash1",
      panelId: 1,
    });

    const parsed = parse(result);
    expect(parsed.error).toContain("grafana_query");
    expect(parsed.error).toContain("prometheus");
  });

  test("missing datasourceUid returns error", async () => {
    const tool = createQueryTracesToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-1", {
      query: "{ }",
    });

    const parsed = parse(result);
    expect(parsed.error).toContain("Missing 'datasourceUid'");
  });

  test("missing query returns error", async () => {
    const tool = createQueryTracesToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-1", {
      datasourceUid: "tempo1",
    });

    const parsed = parse(result);
    expect(parsed.error).toContain("Missing 'query'");
  });

  test("API error with guidance", async () => {
    searchTracesMock.mockRejectedValueOnce(new Error("Not found: search traces"));

    const tool = createQueryTracesToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-1", {
      datasourceUid: "bad-uid",
      query: "{ }",
    });

    const parsed = parse(result);
    expect(parsed.error).toContain("Trace query failed");
    expect(parsed.guidance).toBeDefined();
    expect(parsed.guidance.cause).toContain("not a Tempo datasource");
  });

  test("default time range applied for search", async () => {
    searchTracesMock.mockResolvedValueOnce(makeSearchResult(0));

    const tool = createQueryTracesToolFactory(makeRegistry())({} as never);
    await tool!.execute("call-1", {
      datasourceUid: "tempo1",
      query: "{ }",
    });

    expect(searchTracesMock).toHaveBeenCalledWith(
      "tempo1",
      "{ }",
      expect.objectContaining({
        start: "now-1h",
        end: "now",
        limit: 20,
      }),
    );
  });

  test("search with no results returns hint", async () => {
    searchTracesMock.mockResolvedValueOnce({ traces: [] });

    const tool = createQueryTracesToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-1", {
      datasourceUid: "tempo1",
      query: '{ resource.service.name = "nonexistent" }',
    });

    const parsed = parse(result);
    expect(parsed.totalTraces).toBe(0);
    expect(parsed.hint).toBeDefined();
    expect(parsed.hint.cause).toContain("No traces found");
  });

  test("search passes minDuration and maxDuration", async () => {
    searchTracesMock.mockResolvedValueOnce(makeSearchResult(1));

    const tool = createQueryTracesToolFactory(makeRegistry())({} as never);
    await tool!.execute("call-1", {
      datasourceUid: "tempo1",
      query: "{ }",
      minDuration: "1s",
      maxDuration: "10s",
    });

    expect(searchTracesMock).toHaveBeenCalledWith(
      "tempo1",
      "{ }",
      expect.objectContaining({
        minDuration: "1s",
        maxDuration: "10s",
      }),
    );
  });

  test("get trace extracts service.name from resource attributes", async () => {
    getTraceMock.mockResolvedValueOnce({
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: "my-custom-service" } },
            ],
          },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: "t1",
                  spanId: "s1",
                  name: "test-op",
                  startTimeUnixNano: "1700000000000000000",
                  endTimeUnixNano: "1700000001000000000",
                  status: { code: 1 },
                  attributes: [],
                },
              ],
            },
          ],
        },
        {
          resource: { attributes: [] },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: "t1",
                  spanId: "s2",
                  name: "child-op",
                  startTimeUnixNano: "1700000000100000000",
                  endTimeUnixNano: "1700000000500000000",
                  status: { code: 0 },
                  attributes: [],
                },
              ],
            },
          ],
        },
      ],
    });

    const tool = createQueryTracesToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-1", {
      datasourceUid: "tempo1",
      query: "t1",
      queryType: "get",
    });

    const parsed = parse(result);
    expect(parsed.spans[0].serviceName).toBe("my-custom-service");
    expect(parsed.spans[1].serviceName).toBe("unknown");
  });

  // ── Tempo protobuf-JSON format (batches, base64 IDs, string kind/status) ──

  test("get trace handles Tempo v2 protobuf-JSON format (batches key)", async () => {
    getTraceMock.mockResolvedValueOnce({
      batches: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: "openclaw" } },
            ],
          },
          scopeSpans: [
            {
              scope: { name: "grafana-lens" },
              spans: [
                {
                  traceId: "U4J0HDUSQg3pgFUePUCPww==",  // base64
                  spanId: "PcV4E2B9W5k=",                // base64
                  name: "invoke_agent openclaw",
                  startTimeUnixNano: "1700000000000000000",
                  endTimeUnixNano: "1700000001000000000",
                  status: { code: "STATUS_CODE_OK" },
                  kind: "SPAN_KIND_INTERNAL",
                  attributes: [
                    { key: "gen_ai.system", value: { stringValue: "anthropic" } },
                  ],
                },
                {
                  traceId: "U4J0HDUSQg3pgFUePUCPww==",
                  spanId: "bWXMHxQT3Jg=",
                  parentSpanId: "PcV4E2B9W5k=",
                  name: "chat claude-3-opus",
                  startTimeUnixNano: "1700000000100000000",
                  endTimeUnixNano: "1700000000800000000",
                  status: { code: "STATUS_CODE_ERROR" },
                  kind: "SPAN_KIND_CLIENT",
                  attributes: [],
                },
              ],
            },
          ],
        },
      ],
    });

    const tool = createQueryTracesToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-1", {
      datasourceUid: "tempo1",
      query: "5382741c3512420de980551e3d408fc3",
      queryType: "get",
    });

    const parsed = parse(result);
    expect(parsed.status).toBe("success");
    expect(parsed.totalSpans).toBe(2);

    // Base64 IDs decoded to hex
    expect(parsed.spans[0].traceId).toBe("5382741c3512420de980551e3d408fc3");
    expect(parsed.spans[0].spanId).toBe("3dc57813607d5b99");
    expect(parsed.spans[1].parentSpanId).toBe("3dc57813607d5b99");

    // String status resolved
    expect(parsed.spans[0].status).toBe("ok");
    expect(parsed.spans[1].status).toBe("error");

    // String kind resolved
    expect(parsed.spans[0].kind).toBe("internal");
    expect(parsed.spans[1].kind).toBe("client");

    // Attributes still resolve
    expect(parsed.spans[0].attributes["gen_ai.system"]).toBe("anthropic");
    expect(parsed.spans[0].serviceName).toBe("openclaw");
  });

  test("get trace handles unset string status code", async () => {
    getTraceMock.mockResolvedValueOnce({
      batches: [
        {
          resource: { attributes: [] },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: "AAAAAAAAAAAAAAAAAAAAAA==",
                  spanId: "AAAAAAAAAAA=",
                  name: "test",
                  startTimeUnixNano: "1700000000000000000",
                  endTimeUnixNano: "1700000001000000000",
                  status: { code: "STATUS_CODE_UNSET" },
                  kind: "SPAN_KIND_SERVER",
                  attributes: [],
                },
              ],
            },
          ],
        },
      ],
    });

    const tool = createQueryTracesToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-1", {
      datasourceUid: "tempo1",
      query: "t1",
      queryType: "get",
    });

    const parsed = parse(result);
    expect(parsed.spans[0].status).toBe("unset");
    expect(parsed.spans[0].kind).toBe("server");
  });

  test("get trace passes through hex IDs unchanged", async () => {
    getTraceMock.mockResolvedValueOnce({
      resourceSpans: [
        {
          resource: { attributes: [] },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: "abc123def456" + "0".repeat(20),
                  spanId: "span0" + "0".repeat(11),
                  name: "test",
                  startTimeUnixNano: "1700000000000000000",
                  endTimeUnixNano: "1700000001000000000",
                  status: { code: 1 },
                  attributes: [],
                },
              ],
            },
          ],
        },
      ],
    });

    const tool = createQueryTracesToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-1", {
      datasourceUid: "tempo1",
      query: "abc123def456" + "0".repeat(20),
      queryType: "get",
    });

    const parsed = parse(result);
    // Hex IDs pass through unchanged
    expect(parsed.spans[0].traceId).toBe("abc123def456" + "0".repeat(20));
  });
});
