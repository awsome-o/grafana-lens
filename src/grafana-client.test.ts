import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GrafanaClient, parseDateMathToNs, parseDateMathToSeconds } from "./grafana-client.js";

describe("GrafanaClient", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("renderPanel constructs correct URL with viewPanel and kiosk params", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
    });

    const client = new GrafanaClient({
      url: "http://localhost:3000",
      apiKey: "test-key",
    });

    await client.renderPanel("dash-uid", 5, { theme: "dark", scale: 2 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain("/render/d/dash-uid?");
    expect(calledUrl).toContain("viewPanel=5");
    expect(calledUrl).toContain("kiosk=true");
    expect(calledUrl).toContain("theme=dark");
    expect(calledUrl).toContain("scale=2");
    expect(calledUrl).not.toContain("d-solo");
  });

  test("createDashboard sends correct POST body", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          id: 1,
          uid: "new-uid",
          url: "/d/new-uid",
          status: "success",
          version: 1,
        }),
    });

    const client = new GrafanaClient({
      url: "http://localhost:3000",
      apiKey: "test-key",
    });

    const result = await client.createDashboard({
      dashboard: { title: "Test Dashboard" },
      folderUid: "folder1",
      overwrite: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:3000/api/dashboards/db");
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body);
    expect(body.dashboard.title).toBe("Test Dashboard");
    expect(body.folderUid).toBe("folder1");
    expect(result.uid).toBe("new-uid");
  });

  test("404 and 502 errors produce descriptive messages", async () => {
    const client = new GrafanaClient({
      url: "http://localhost:3000",
      apiKey: "test-key",
    });

    // 404 on render
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: () => Promise.resolve("not found"),
    });
    await expect(client.renderPanel("bad-uid", 1)).rejects.toThrow(
      "Panel or dashboard not found (uid: bad-uid, panel: 1)",
    );

    // 502 on render
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 502,
      text: () => Promise.resolve("bad gateway"),
    });
    await expect(client.renderPanel("uid", 1)).rejects.toThrow(
      "Image Renderer not available",
    );

    // 401 on API
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: () => Promise.resolve("unauthorized"),
    });
    await expect(client.searchDashboards("test")).rejects.toThrow(
      "authentication failed",
    );
  });

  test("healthCheck returns false on network error", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const client = new GrafanaClient({
      url: "http://localhost:3000",
      apiKey: "test-key",
    });

    const ok = await client.healthCheck();
    expect(ok).toBe(false);
  });

  // ── Datasource methods ────────────────────────────────────────────

  test("listDatasources calls correct endpoint", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve([
          { id: 1, uid: "prom1", name: "Prometheus", type: "prometheus", url: "http://prom:9090", isDefault: true, access: "proxy" },
        ]),
    });

    const client = new GrafanaClient({ url: "http://localhost:3000", apiKey: "test-key" });
    const result = await client.listDatasources();

    expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:3000/api/datasources");
    expect(result).toHaveLength(1);
    expect(result[0].uid).toBe("prom1");
  });

  // ── Prometheus query methods ──────────────────────────────────────

  test("queryPrometheus constructs correct URL with query params", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          status: "success",
          data: { resultType: "vector", result: [{ metric: { __name__: "up" }, value: [1234, "1"] }] },
        }),
    });

    const client = new GrafanaClient({ url: "http://localhost:3000", apiKey: "test-key" });
    const result = await client.queryPrometheus("prom1", "up", "1234567890");

    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain("/api/datasources/proxy/uid/prom1/api/v1/query?");
    expect(calledUrl).toContain("query=up");
    expect(calledUrl).toContain("time=1234567890");
    expect(result.data.result[0].value[1]).toBe("1");
  });

  test("queryPrometheusRange converts date math to seconds in URL params", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          status: "success",
          data: { resultType: "matrix", result: [] },
        }),
    });

    const client = new GrafanaClient({ url: "http://localhost:3000", apiKey: "test-key" });
    await client.queryPrometheusRange("prom1", "rate(up[5m])", "1700000000", "1700003600", "60");

    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain("/api/v1/query_range?");
    // Unix seconds should pass through as-is (converted back to same value)
    expect(calledUrl).toContain("start=1700000000");
    expect(calledUrl).toContain("end=1700003600");
    expect(calledUrl).toContain("step=60");
  });

  test("queryPrometheusRange converts 'now-1h' date math to numeric seconds", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          status: "success",
          data: { resultType: "matrix", result: [] },
        }),
    });

    const client = new GrafanaClient({ url: "http://localhost:3000", apiKey: "test-key" });
    await client.queryPrometheusRange("prom1", "rate(up[5m])", "now-1h", "now", "60");

    const calledUrl = fetchMock.mock.calls[0][0] as string;
    // Should contain numeric timestamps, not "now-1h" / "now"
    const url = new URL(calledUrl);
    const start = url.searchParams.get("start")!;
    const end = url.searchParams.get("end")!;
    expect(start).toMatch(/^\d+$/);
    expect(end).toMatch(/^\d+$/);
    expect(Number(end) - Number(start)).toBeCloseTo(3600, -1);
  });

  test("listMetricNames returns string array from .data", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ status: "success", data: ["up", "process_cpu_seconds_total"] }),
    });

    const client = new GrafanaClient({ url: "http://localhost:3000", apiKey: "test-key" });
    const result = await client.listMetricNames("prom1");

    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain("/api/v1/label/__name__/values");
    expect(result).toEqual(["up", "process_cpu_seconds_total"]);
  });

  test("listLabelValues encodes label name in URL path", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ status: "success", data: ["val1", "val2"] }),
    });

    const client = new GrafanaClient({ url: "http://localhost:3000", apiKey: "test-key" });
    const result = await client.listLabelValues("prom1", "instance");

    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain("/api/v1/label/instance/values");
    expect(result).toEqual(["val1", "val2"]);
  });

  // ── Metric metadata methods ──────────────────────────────────────

  test("getMetricMetadata calls correct endpoint", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          status: "success",
          data: {
            up: [{ type: "gauge", help: "Target is up", unit: "" }],
            process_cpu_seconds_total: [{ type: "counter", help: "Total CPU time", unit: "" }],
          },
        }),
    });

    const client = new GrafanaClient({ url: "http://localhost:3000", apiKey: "test-key" });
    const result = await client.getMetricMetadata("prom1");

    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toBe("http://localhost:3000/api/datasources/proxy/uid/prom1/api/v1/metadata");
    expect(result.up[0].type).toBe("gauge");
    expect(result.process_cpu_seconds_total[0].type).toBe("counter");
  });

  test("getMetricMetadata passes metric filter param", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          status: "success",
          data: { up: [{ type: "gauge", help: "Target is up", unit: "" }] },
        }),
    });

    const client = new GrafanaClient({ url: "http://localhost:3000", apiKey: "test-key" });
    await client.getMetricMetadata("prom1", { metric: "up", limit: 10 });

    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain("metric=up");
    expect(calledUrl).toContain("limit=10");
  });

  // ── Annotation methods ────────────────────────────────────────────

  test("createAnnotation sends POST with correct body", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ id: 42, message: "Annotation added" }),
    });

    const client = new GrafanaClient({ url: "http://localhost:3000", apiKey: "test-key" });
    const result = await client.createAnnotation({
      text: "Deployment v2",
      tags: ["deploy"],
      time: 1700000000000,
    });

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:3000/api/annotations");
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body);
    expect(body.text).toBe("Deployment v2");
    expect(body.tags).toEqual(["deploy"]);
    expect(result.id).toBe(42);
  });

  test("getAnnotations builds query params including multi-tag", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([]),
    });

    const client = new GrafanaClient({ url: "http://localhost:3000", apiKey: "test-key" });
    await client.getAnnotations({ from: 1000, to: 2000, tags: ["deploy", "rollback"], limit: 10 });

    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain("from=1000");
    expect(calledUrl).toContain("to=2000");
    expect(calledUrl).toContain("limit=10");
    // Tags should be appended multiple times
    const url = new URL(calledUrl);
    expect(url.searchParams.getAll("tags")).toEqual(["deploy", "rollback"]);
  });

  // ── Alert rule methods ────────────────────────────────────────────

  test("createAlertRule sends X-Disable-Provenance header", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          uid: "alert-1",
          title: "Cost Alert",
          folderUID: "folder1",
          ruleGroup: "group1",
          condition: "B",
          data: [],
          for: "5m",
          noDataState: "NoData",
          execErrState: "Alerting",
          labels: {},
          annotations: {},
          updated: "2026-01-01",
          provenance: "",
        }),
    });

    const client = new GrafanaClient({ url: "http://localhost:3000", apiKey: "test-key" });
    await client.createAlertRule({
      title: "Cost Alert",
      folderUID: "folder1",
      ruleGroup: "group1",
      condition: "B",
      data: [],
    });

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:3000/api/v1/provisioning/alert-rules");
    expect(opts.headers["X-Disable-Provenance"]).toBe("true");
    expect(opts.method).toBe("POST");
  });

  test("listAlertRules calls correct endpoint", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([]),
    });

    const client = new GrafanaClient({ url: "http://localhost:3000", apiKey: "test-key" });
    await client.listAlertRules();

    expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:3000/api/v1/provisioning/alert-rules");
  });

  test("deleteAlertRule sends DELETE and does not parse body", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
    });

    const client = new GrafanaClient({ url: "http://localhost:3000", apiKey: "test-key" });
    await client.deleteAlertRule("alert-uid-1");

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:3000/api/v1/provisioning/alert-rules/alert-uid-1");
    expect(opts.method).toBe("DELETE");
  });

  // ── Folder methods ────────────────────────────────────────────────

  test("createFolder sends POST with title", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ id: 1, uid: "folder-uid", title: "My Folder", url: "/dashboards/f/folder-uid" }),
    });

    const client = new GrafanaClient({ url: "http://localhost:3000", apiKey: "test-key" });
    const result = await client.createFolder({ title: "My Folder" });

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:3000/api/folders");
    expect(opts.method).toBe("POST");
    expect(result.uid).toBe("folder-uid");
  });

  test("listFolders includes limit=100", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([]),
    });

    const client = new GrafanaClient({ url: "http://localhost:3000", apiKey: "test-key" });
    await client.listFolders();

    expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:3000/api/folders?limit=100");
  });

  // ── Contact point methods ─────────────────────────────────────────

  test("listContactPoints calls provisioning endpoint", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([{ uid: "cp1", name: "email", type: "email", settings: {}, disableResolveMessage: false }]),
    });

    const client = new GrafanaClient({ url: "http://localhost:3000", apiKey: "test-key" });
    const result = await client.listContactPoints();

    expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:3000/api/v1/provisioning/contact-points");
    expect(result[0].name).toBe("email");
  });

  // ── Contact point CRUD methods ──────────────────────────────────

  test("createContactPoint sends POST with X-Disable-Provenance", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ uid: "cp-new", name: "webhook", type: "webhook", settings: { url: "http://hook" }, disableResolveMessage: false }),
    });

    const client = new GrafanaClient({ url: "http://localhost:3000", apiKey: "test-key" });
    const result = await client.createContactPoint({ name: "webhook", type: "webhook", settings: { url: "http://hook" } });

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:3000/api/v1/provisioning/contact-points");
    expect(opts.method).toBe("POST");
    expect(opts.headers["X-Disable-Provenance"]).toBe("true");
    expect(result.uid).toBe("cp-new");
  });

  test("updateContactPoint sends PUT to uid path", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true });

    const client = new GrafanaClient({ url: "http://localhost:3000", apiKey: "test-key" });
    await client.updateContactPoint("cp-1", { name: "updated", type: "webhook", settings: {} });

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:3000/api/v1/provisioning/contact-points/cp-1");
    expect(opts.method).toBe("PUT");
    expect(opts.headers["X-Disable-Provenance"]).toBe("true");
  });

  test("deleteContactPoint sends DELETE to uid path", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true });

    const client = new GrafanaClient({ url: "http://localhost:3000", apiKey: "test-key" });
    await client.deleteContactPoint("cp-1");

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:3000/api/v1/provisioning/contact-points/cp-1");
    expect(opts.method).toBe("DELETE");
  });

  // ── Notification policy methods ─────────────────────────────────

  test("getNotificationPolicies calls provisioning policies endpoint", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ receiver: "grafana-default-email", routes: [] }),
    });

    const client = new GrafanaClient({ url: "http://localhost:3000", apiKey: "test-key" });
    const result = await client.getNotificationPolicies();

    expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:3000/api/v1/provisioning/policies");
    expect(result.receiver).toBe("grafana-default-email");
  });

  // ── Enhanced error classification ────────────────────────────────

  test("409 error produces descriptive message", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      text: () => Promise.resolve("conflict"),
    });

    const client = new GrafanaClient({ url: "http://localhost:3000", apiKey: "test-key" });
    await expect(client.createFolder({ title: "Existing" })).rejects.toThrow(
      "Resource already exists",
    );
  });

  test("422 error includes body in message", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 422,
      text: () => Promise.resolve("invalid field: expr"),
    });

    const client = new GrafanaClient({ url: "http://localhost:3000", apiKey: "test-key" });
    await expect(client.createAlertRule({ title: "bad", folderUID: "f", ruleGroup: "g", condition: "C", data: [] })).rejects.toThrow(
      "Validation error",
    );
  });

  test("429 error suggests retry", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: () => Promise.resolve("too many requests"),
    });

    const client = new GrafanaClient({ url: "http://localhost:3000", apiKey: "test-key" });
    await expect(client.listDatasources()).rejects.toThrow(
      "Rate limited",
    );
  });

  // ── Dashboard delete ────────────────────────────────────────────

  test("deleteDashboard sends DELETE to uid path", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ title: "Deleted Dashboard" }),
    });

    const client = new GrafanaClient({ url: "http://localhost:3000", apiKey: "test-key" });
    const result = await client.deleteDashboard("dash-1");

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:3000/api/dashboards/uid/dash-1");
    expect(opts.method).toBe("DELETE");
    expect(result.title).toBe("Deleted Dashboard");
  });

  // ── Enhanced search ──────────────────────────────────────────────

  test("searchDashboards passes optional params (tags, starred, sort, limit)", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([]),
    });

    const client = new GrafanaClient({ url: "http://localhost:3000", apiKey: "test-key" });
    await client.searchDashboards("test", {
      tags: ["production", "api"],
      starred: true,
      sort: "alpha-desc",
      limit: 10,
    });

    const calledUrl = fetchMock.mock.calls[0][0] as string;
    const url = new URL(calledUrl);
    expect(url.searchParams.getAll("tag")).toEqual(["production", "api"]);
    expect(url.searchParams.get("starred")).toBe("true");
    expect(url.searchParams.get("sort")).toBe("alpha-desc");
    expect(url.searchParams.get("limit")).toBe("10");
  });

  test("searchDashboards works without optional params", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([]),
    });

    const client = new GrafanaClient({ url: "http://localhost:3000", apiKey: "test-key" });
    await client.searchDashboards("test");

    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).not.toContain("tag=");
    expect(calledUrl).not.toContain("starred=");
  });

  // ── Silence methods ──────────────────────────────────────────────

  test("createSilence sends POST to alertmanager silences endpoint", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ silenceID: "silence-123" }),
    });

    const client = new GrafanaClient({ url: "http://localhost:3000", apiKey: "test-key" });
    const result = await client.createSilence(
      [{ name: "alertname", value: "HighCost", isRegex: false }],
      "2h",
      "Investigating",
    );

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:3000/api/alertmanager/grafana/api/v2/silences");
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body);
    expect(body.matchers).toEqual([{ name: "alertname", value: "HighCost", isRegex: false }]);
    expect(body.comment).toBe("Investigating");
    expect(body.createdBy).toBe("grafana-lens");
    expect(result.silenceID).toBe("silence-123");
  });

  test("listSilences calls correct endpoint", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([{ id: "s1", status: { state: "active" }, matchers: [], comment: "", createdBy: "test", endsAt: "2026-01-01T00:00:00Z" }]),
    });

    const client = new GrafanaClient({ url: "http://localhost:3000", apiKey: "test-key" });
    const result = await client.listSilences();

    expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:3000/api/alertmanager/grafana/api/v2/silences");
    expect(result[0].id).toBe("s1");
  });

  test("deleteSilence sends DELETE to silence path", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true });

    const client = new GrafanaClient({ url: "http://localhost:3000", apiKey: "test-key" });
    await client.deleteSilence("silence-123");

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:3000/api/alertmanager/grafana/api/v2/silence/silence-123");
    expect(opts.method).toBe("DELETE");
  });

  // ── Timeout behavior ──────────────────────────────────────────────

  test("fetch timeout produces descriptive error message", async () => {
    const abortError = new DOMException("The operation was aborted", "AbortError");
    fetchMock.mockRejectedValueOnce(abortError);

    const client = new GrafanaClient({ url: "http://localhost:3000", apiKey: "test-key" });
    await expect(client.searchDashboards("test")).rejects.toThrow(
      "timed out",
    );
  });

  test("non-abort fetch errors are rethrown as-is", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const client = new GrafanaClient({ url: "http://localhost:3000", apiKey: "test-key" });
    await expect(client.searchDashboards("test")).rejects.toThrow(
      "ECONNREFUSED",
    );
  });

  test("queryPrometheus converts date math 'time' param to seconds", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          status: "success",
          data: { resultType: "vector", result: [] },
        }),
    });

    const client = new GrafanaClient({ url: "http://localhost:3000", apiKey: "test-key" });
    await client.queryPrometheus("prom1", "up", "now-1h");

    const calledUrl = fetchMock.mock.calls[0][0] as string;
    const url = new URL(calledUrl);
    const time = url.searchParams.get("time")!;
    expect(time).toMatch(/^\d+$/);
  });

  test("queryLokiRange converts date math to nanoseconds in URL params", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          status: "success",
          data: { resultType: "streams", result: [] },
        }),
    });

    const client = new GrafanaClient({ url: "http://localhost:3000", apiKey: "test-key" });
    await client.queryLokiRange("loki1", '{job="api"}', "now-1h", "now");

    const calledUrl = fetchMock.mock.calls[0][0] as string;
    const url = new URL(calledUrl);
    const start = url.searchParams.get("start")!;
    const end = url.searchParams.get("end")!;
    // Should be numeric nanosecond timestamps (16+ digits), not "now-1h" / "now"
    expect(start).toMatch(/^\d{16,}$/);
    expect(end).toMatch(/^\d{16,}$/);
  });

  test("updateNotificationPolicies sends PUT with X-Disable-Provenance", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true });

    const client = new GrafanaClient({ url: "http://localhost:3000", apiKey: "test-key" });
    await client.updateNotificationPolicies({
      receiver: "grafana-default-email",
      routes: [{ receiver: "my-webhook", matchers: [{ name: "managed_by", type: "=", value: "openclaw" }] }],
    });

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:3000/api/v1/provisioning/policies");
    expect(opts.method).toBe("PUT");
    expect(opts.headers["X-Disable-Provenance"]).toBe("true");
    const body = JSON.parse(opts.body);
    expect(body.routes[0].receiver).toBe("my-webhook");
  });
});

// ── parseDateMathToNs / parseDateMathToSeconds ───────────────────────

describe("parseDateMathToNs", () => {
  test("'now' returns current time in nanoseconds", () => {
    const before = Date.now() * 1_000_000;
    const result = Number(parseDateMathToNs("now"));
    const after = Date.now() * 1_000_000;
    expect(result).toBeGreaterThanOrEqual(before);
    expect(result).toBeLessThanOrEqual(after);
  });

  test("'now-1h' returns ~1 hour ago in nanoseconds", () => {
    const expected = (Date.now() - 3600_000) * 1_000_000;
    const result = Number(parseDateMathToNs("now-1h"));
    expect(Math.abs(result - expected)).toBeLessThan(100_000_000);
  });

  test("'now-30m' returns ~30 minutes ago", () => {
    const expected = (Date.now() - 1800_000) * 1_000_000;
    const result = Number(parseDateMathToNs("now-30m"));
    expect(Math.abs(result - expected)).toBeLessThan(100_000_000);
  });

  test("'now-7d' returns ~7 days ago", () => {
    const expected = (Date.now() - 7 * 86400_000) * 1_000_000;
    const result = Number(parseDateMathToNs("now-7d"));
    expect(Math.abs(result - expected)).toBeLessThan(100_000_000);
  });

  test("'now-2w' returns ~2 weeks ago", () => {
    const expected = (Date.now() - 14 * 86400_000) * 1_000_000;
    const result = Number(parseDateMathToNs("now-2w"));
    expect(Math.abs(result - expected)).toBeLessThan(100_000_000);
  });

  test("Unix seconds are converted to nanoseconds", () => {
    expect(parseDateMathToNs("1700000000")).toBe("1700000000000000000");
  });

  test("Unix milliseconds are converted to nanoseconds", () => {
    expect(parseDateMathToNs("1700000000000")).toBe("1700000000000000000");
  });

  test("Unix nanoseconds pass through unchanged", () => {
    expect(parseDateMathToNs("1700000000000000000")).toBe("1700000000000000000");
  });

  test("RFC3339 string is converted to nanoseconds", () => {
    const result = parseDateMathToNs("2023-11-14T22:13:20.000Z");
    expect(result).toBe("1700000000000000000");
  });

  test("invalid format throws with actionable guidance", () => {
    expect(() => parseDateMathToNs("last tuesday")).toThrow("Invalid time format");
    expect(() => parseDateMathToNs("last tuesday")).toThrow("Accepted:");
  });
});

describe("parseDateMathToSeconds", () => {
  test("converts nanosecond string to seconds", () => {
    expect(parseDateMathToSeconds("1700000000000000000")).toBe("1700000000");
  });

  test("'now-1h' returns ~1 hour ago in seconds", () => {
    const expected = Math.floor((Date.now() - 3600_000) / 1000);
    const result = Number(parseDateMathToSeconds("now-1h"));
    expect(Math.abs(result - expected)).toBeLessThan(1);
  });

  test("Unix seconds pass through correctly", () => {
    expect(parseDateMathToSeconds("1700000000")).toBe("1700000000");
  });
});
