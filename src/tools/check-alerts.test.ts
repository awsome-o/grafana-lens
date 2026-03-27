import { beforeEach, describe, expect, test, vi } from "vitest";

// ── Hoisted mocks ────────────────────────────────────────────────────

const listContactPointsMock = vi.hoisted(() => vi.fn());
const createContactPointMock = vi.hoisted(() => vi.fn());
const getNotificationPoliciesMock = vi.hoisted(() => vi.fn());
const updateNotificationPoliciesMock = vi.hoisted(() => vi.fn());
const createSilenceMock = vi.hoisted(() => vi.fn());
const deleteSilenceMock = vi.hoisted(() => vi.fn());
const listAlertRulesMock = vi.hoisted(() => vi.fn());
const deleteAlertRuleMock = vi.hoisted(() => vi.fn());
const getAlertRuleStatesMock = vi.hoisted(() => vi.fn());
const listDatasourcesMock = vi.hoisted(() => vi.fn());

vi.mock("../grafana-client.js", () => ({
  GrafanaClient: class {
    listContactPoints = listContactPointsMock;
    createContactPoint = createContactPointMock;
    getNotificationPolicies = getNotificationPoliciesMock;
    updateNotificationPolicies = updateNotificationPoliciesMock;
    createSilence = createSilenceMock;
    deleteSilence = deleteSilenceMock;
    listAlertRules = listAlertRulesMock;
    deleteAlertRule = deleteAlertRuleMock;
    getAlertRuleStates = getAlertRuleStatesMock;
    listDatasources = listDatasourcesMock;
    getUrl() { return "http://localhost:3000"; }
  },
}));

// ── Imports (after mocks) ────────────────────────────────────────────

import { createCheckAlertsToolFactory, extractRuleUidFromGeneratorUrl } from "./check-alerts.js";
import { createAlertStore, type GrafanaAlertNotification } from "../services/alert-webhook.js";
import type { ValidatedGrafanaLensConfig } from "../config.js";
import { GrafanaClientRegistry } from "../grafana-client-registry.js";

function makeConfig(): ValidatedGrafanaLensConfig {
  return {
    grafana: {
      instances: { default: { url: "http://localhost:3000", apiKey: "test-key" } },
      defaultInstance: "default",
    },
    proactive: { enabled: true },
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

function makeNotification(overrides?: Partial<GrafanaAlertNotification>): GrafanaAlertNotification {
  return {
    receiver: "openclaw-webhook",
    status: "firing",
    orgId: 1,
    alerts: [
      {
        status: "firing",
        labels: { alertname: "HighCost", managed_by: "openclaw" },
        annotations: { summary: "Daily cost > $5" },
        startsAt: "2026-02-18T10:00:00Z",
        endsAt: "0001-01-01T00:00:00Z",
        generatorURL: "http://localhost:3000/alerting/alert-1/edit",
        fingerprint: "abc123",
        values: { B: 7.5 },
      },
    ],
    groupLabels: { alertname: "HighCost" },
    commonLabels: { managed_by: "openclaw" },
    externalURL: "http://localhost:3000",
    title: "[FIRING:1] HighCost",
    state: "alerting",
    message: "Daily cost exceeded $5",
    ...overrides,
  };
}

describe("grafana_check_alerts tool", () => {
  beforeEach(() => {
    listContactPointsMock.mockReset();
    createContactPointMock.mockReset();
    getNotificationPoliciesMock.mockReset();
    updateNotificationPoliciesMock.mockReset();
    createSilenceMock.mockReset();
    deleteSilenceMock.mockReset();
    listAlertRulesMock.mockReset();
    deleteAlertRuleMock.mockReset();
    getAlertRuleStatesMock.mockReset();
    listDatasourcesMock.mockReset();

    // Default: list action fetches rules + datasources for enrichment
    listAlertRulesMock.mockResolvedValue([]);
    getAlertRuleStatesMock.mockResolvedValue(new Map());
    listDatasourcesMock.mockResolvedValue([]);
  });

  // ── List action ──────────────────────────────────────────────────

  test("list returns empty when no alerts", async () => {
    const store = createAlertStore();
    const tool = createCheckAlertsToolFactory(makeRegistry(), store)({} as never);
    const result = await tool!.execute("call-1", {});

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.alerts).toEqual([]);
    expect(parsed.message).toContain("No pending");
  });

  test("list returns pending alerts with details", async () => {
    const store = createAlertStore();
    store.addAlert(makeNotification());

    const tool = createCheckAlertsToolFactory(makeRegistry(), store)({} as never);
    const result = await tool!.execute("call-2", { action: "list" });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.alertCount).toBe(1);
    expect(parsed.alerts[0].id).toBe("alert-1");
    expect(parsed.alerts[0].status).toBe("firing");
    expect(parsed.alerts[0].instances).toHaveLength(1);
    expect(parsed.alerts[0].instances[0].values.B).toBe(7.5);
  });

  // ── Acknowledge action ───────────────────────────────────────────

  test("acknowledge marks alert as investigated", async () => {
    const store = createAlertStore();
    store.addAlert(makeNotification());

    const tool = createCheckAlertsToolFactory(makeRegistry(), store)({} as never);
    const result = await tool!.execute("call-3", { action: "acknowledge", alertId: "alert-1" });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.status).toBe("acknowledged");
    expect(store.getPendingAlerts()).toHaveLength(0);
  });

  test("acknowledge returns error for unknown alert", async () => {
    const store = createAlertStore();
    const tool = createCheckAlertsToolFactory(makeRegistry(), store)({} as never);
    const result = await tool!.execute("call-4", { action: "acknowledge", alertId: "nonexistent" });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.error).toContain("not found");
  });

  // ── List rules action ────────────────────────────────────────────

  test("list_rules returns empty when no rules configured", async () => {
    listAlertRulesMock.mockResolvedValueOnce([]);

    const store = createAlertStore();
    const tool = createCheckAlertsToolFactory(makeRegistry(), store)({} as never);
    const result = await tool!.execute("call-lr-1", { action: "list_rules" });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.status).toBe("success");
    expect(parsed.rules).toEqual([]);
    expect(parsed.message).toContain("No alert rules");
  });

  test("list_rules returns rule details with condition extraction and eval state", async () => {
    listAlertRulesMock.mockResolvedValueOnce([
      {
        uid: "rule-abc",
        title: "High Cost Alert",
        folderUID: "folder-1",
        ruleGroup: "cost-alerts",
        condition: "C",
        data: [
          {
            refId: "A",
            datasourceUid: "prom-1",
            model: { expr: "rate(openclaw_lens_cost_by_token_type[5m]) > 0.1" },
            relativeTimeRange: { from: 600, to: 0 },
          },
          { refId: "B", datasourceUid: "__expr__", model: { type: "reduce" } },
          { refId: "C", datasourceUid: "__expr__", model: { type: "threshold" } },
        ],
        for: "5m",
        noDataState: "NoData",
        execErrState: "Alerting",
        labels: { managed_by: "openclaw", severity: "warning" },
        annotations: { summary: "Cost rate too high" },
        updated: "2026-02-20T10:00:00Z",
        provenance: "",
      },
    ]);
    getAlertRuleStatesMock.mockResolvedValueOnce(new Map([
      ["rule-abc", {
        uid: "rule-abc",
        state: "firing",
        health: "ok",
        lastEvaluation: "2026-02-20T12:00:00Z",
        evaluationTime: 0.003,
        isPaused: false,
      }],
    ]));

    const store = createAlertStore();
    const tool = createCheckAlertsToolFactory(makeRegistry(), store)({} as never);
    const result = await tool!.execute("call-lr-2", { action: "list_rules" });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.status).toBe("success");
    expect(parsed.ruleCount).toBe(1);
    expect(parsed.rules[0].uid).toBe("rule-abc");
    expect(parsed.rules[0].title).toBe("High Cost Alert");
    expect(parsed.rules[0].condition).toBe("rate(openclaw_lens_cost_by_token_type[5m]) > 0.1");
    expect(parsed.rules[0].labels.managed_by).toBe("openclaw");
    expect(parsed.rules[0].folder).toBe("folder-1");
    expect(parsed.rules[0].state).toBe("firing");
    expect(parsed.rules[0].health).toBe("ok");
    expect(parsed.rules[0].lastEvaluation).toBe("2026-02-20T12:00:00Z");
  });

  test("list_rules falls back to condition refId when no PromQL expr", async () => {
    listAlertRulesMock.mockResolvedValueOnce([
      {
        uid: "rule-xyz",
        title: "Custom Alert",
        folderUID: "folder-1",
        ruleGroup: "group-1",
        condition: "C",
        data: [{ refId: "A", datasourceUid: "ds-1", model: {} }],
        for: "5m",
        noDataState: "NoData",
        execErrState: "Alerting",
        labels: {},
        annotations: {},
        updated: "2026-02-20T10:00:00Z",
        provenance: "",
      },
    ]);

    const store = createAlertStore();
    const tool = createCheckAlertsToolFactory(makeRegistry(), store)({} as never);
    const result = await tool!.execute("call-lr-3", { action: "list_rules" });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.rules[0].condition).toBe("C");
  });

  test("list_rules handles API errors gracefully", async () => {
    listAlertRulesMock.mockRejectedValueOnce(new Error("Grafana API error 403: forbidden"));

    const store = createAlertStore();
    const tool = createCheckAlertsToolFactory(makeRegistry(), store)({} as never);
    const result = await tool!.execute("call-lr-4", { action: "list_rules" });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.error).toContain("Failed to list alert rules");
  });

  test("list_rules maps Grafana 'inactive' state to 'normal'", async () => {
    listAlertRulesMock.mockResolvedValueOnce([
      {
        uid: "rule-n",
        title: "Normal Rule",
        folderUID: "f1",
        ruleGroup: "g1",
        condition: "C",
        data: [{ refId: "A", datasourceUid: "prom-1", model: { expr: "up" } }],
        for: "5m",
        noDataState: "NoData",
        execErrState: "Alerting",
        labels: {},
        annotations: {},
        updated: "2026-02-20T10:00:00Z",
        provenance: "",
      },
    ]);
    getAlertRuleStatesMock.mockResolvedValueOnce(new Map([
      ["rule-n", {
        uid: "rule-n",
        state: "inactive",
        health: "ok",
        lastEvaluation: "2026-02-20T12:00:00Z",
        evaluationTime: 0.001,
        isPaused: false,
      }],
    ]));

    const store = createAlertStore();
    const tool = createCheckAlertsToolFactory(makeRegistry(), store)({} as never);
    const result = await tool!.execute("call-lr-5", { action: "list_rules" });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.rules[0].state).toBe("normal");
  });

  test("list_rules returns unknown state when eval state API fails", async () => {
    listAlertRulesMock.mockResolvedValueOnce([
      {
        uid: "rule-u",
        title: "Unknown State Rule",
        folderUID: "f1",
        ruleGroup: "g1",
        condition: "C",
        data: [{ refId: "A", datasourceUid: "prom-1", model: { expr: "up" } }],
        for: "5m",
        noDataState: "NoData",
        execErrState: "Alerting",
        labels: {},
        annotations: {},
        updated: "2026-02-20T10:00:00Z",
        provenance: "",
      },
    ]);
    getAlertRuleStatesMock.mockRejectedValueOnce(new Error("eval state endpoint unreachable"));

    const store = createAlertStore();
    const tool = createCheckAlertsToolFactory(makeRegistry(), store)({} as never);
    const result = await tool!.execute("call-lr-6", { action: "list_rules" });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.status).toBe("success");
    expect(parsed.ruleCount).toBe(1);
    expect(parsed.rules[0].state).toBe("unknown");
    expect(parsed.rules[0].health).toBe("unknown");
    expect(parsed.rules[0].lastEvaluation).toBeNull();
  });

  // ── Compact list_rules mode ──────────────────────────────────────

  test("list_rules compact returns only uid, title, state, condition", async () => {
    listAlertRulesMock.mockResolvedValueOnce([
      {
        uid: "rule-abc",
        title: "High Cost Alert",
        folderUID: "folder-1",
        ruleGroup: "cost-alerts",
        condition: "C",
        data: [
          {
            refId: "A",
            datasourceUid: "prom-1",
            model: { expr: "rate(openclaw_lens_cost_by_token_type[5m]) > 0.1" },
            relativeTimeRange: { from: 600, to: 0 },
          },
          { refId: "B", datasourceUid: "__expr__", model: { type: "reduce" } },
          { refId: "C", datasourceUid: "__expr__", model: { type: "threshold" } },
        ],
        for: "5m",
        noDataState: "NoData",
        execErrState: "Alerting",
        labels: { managed_by: "openclaw", severity: "warning" },
        annotations: { summary: "Cost rate too high" },
        updated: "2026-02-20T10:00:00Z",
        provenance: "",
      },
    ]);
    getAlertRuleStatesMock.mockResolvedValueOnce(new Map([
      ["rule-abc", {
        uid: "rule-abc",
        state: "firing",
        health: "ok",
        lastEvaluation: "2026-02-20T12:00:00Z",
        evaluationTime: 0.003,
        isPaused: false,
      }],
    ]));

    const store = createAlertStore();
    const tool = createCheckAlertsToolFactory(makeRegistry(), store)({} as never);
    const result = await tool!.execute("call-lr-compact1", { action: "list_rules", compact: true });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.status).toBe("success");
    expect(parsed.ruleCount).toBe(1);

    const rule = parsed.rules[0];
    expect(rule.uid).toBe("rule-abc");
    expect(rule.title).toBe("High Cost Alert");
    expect(rule.state).toBe("firing");
    expect(rule.condition).toBe("rate(openclaw_lens_cost_by_token_type[5m]) > 0.1");

    // These fields should be absent in compact mode
    expect(rule.folder).toBeUndefined();
    expect(rule.ruleGroup).toBeUndefined();
    expect(rule.health).toBeUndefined();
    expect(rule.lastEvaluation).toBeUndefined();
    expect(rule.for).toBeUndefined();
    expect(rule.labels).toBeUndefined();
    expect(rule.annotations).toBeUndefined();
    expect(rule.updated).toBeUndefined();
  });

  test("list_rules compact=false returns full fields (default behavior)", async () => {
    listAlertRulesMock.mockResolvedValueOnce([
      {
        uid: "rule-def",
        title: "Test Alert",
        folderUID: "folder-2",
        ruleGroup: "test-group",
        condition: "C",
        data: [{ refId: "A", datasourceUid: "prom-1", model: { expr: "up == 0" }, relativeTimeRange: { from: 600, to: 0 } }],
        for: "5m",
        noDataState: "NoData",
        execErrState: "Alerting",
        labels: { severity: "critical" },
        annotations: { summary: "Down" },
        updated: "2026-02-20T10:00:00Z",
        provenance: "",
      },
    ]);
    getAlertRuleStatesMock.mockResolvedValueOnce(new Map());

    const store = createAlertStore();
    const tool = createCheckAlertsToolFactory(makeRegistry(), store)({} as never);
    const result = await tool!.execute("call-lr-compact2", { action: "list_rules" });

    const parsed = JSON.parse(getTextContent(result));
    const rule = parsed.rules[0];
    // All fields should be present in non-compact mode
    expect(rule.folder).toBe("folder-2");
    expect(rule.ruleGroup).toBe("test-group");
    expect(rule.labels).toEqual({ severity: "critical" });
    expect(rule.annotations).toEqual({ summary: "Down" });
    expect(rule.updated).toBe("2026-02-20T10:00:00Z");
  });

  // ── Delete rule action ──────────────────────────────────────────

  test("delete_rule deletes rule by UID", async () => {
    deleteAlertRuleMock.mockResolvedValueOnce(undefined);

    const store = createAlertStore();
    const tool = createCheckAlertsToolFactory(makeRegistry(), store)({} as never);
    const result = await tool!.execute("call-dr-1", { action: "delete_rule", ruleUid: "rule-abc" });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.status).toBe("deleted");
    expect(parsed.ruleUid).toBe("rule-abc");
    expect(deleteAlertRuleMock).toHaveBeenCalledWith("rule-abc");
  });

  test("delete_rule handles API errors gracefully", async () => {
    deleteAlertRuleMock.mockRejectedValueOnce(new Error("Grafana API error 404: alert rule not found"));

    const store = createAlertStore();
    const tool = createCheckAlertsToolFactory(makeRegistry(), store)({} as never);
    const result = await tool!.execute("call-dr-2", { action: "delete_rule", ruleUid: "nonexistent" });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.error).toContain("Failed to delete alert rule");
    expect(parsed.error).toContain("404");
  });

  // ── Setup action ─────────────────────────────────────────────────

  test("setup creates contact point and notification policy route", async () => {
    listContactPointsMock.mockResolvedValueOnce([]);
    createContactPointMock.mockResolvedValueOnce({
      uid: "cp-new",
      name: "OpenClaw Alert Webhook",
      type: "webhook",
      settings: {},
      disableResolveMessage: false,
    });
    getNotificationPoliciesMock.mockResolvedValueOnce({
      receiver: "grafana-default-email",
      routes: [],
    });
    updateNotificationPoliciesMock.mockResolvedValueOnce(undefined);

    const store = createAlertStore();
    const tool = createCheckAlertsToolFactory(makeRegistry(), store)({} as never);
    const result = await tool!.execute("call-5", { action: "setup" });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.status).toBe("created");
    expect(parsed.contactPointUid).toBe("cp-new");

    // Verify contact point creation
    expect(createContactPointMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "OpenClaw Alert Webhook",
        type: "webhook",
      }),
    );

    // Verify notification policy update
    expect(updateNotificationPoliciesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        routes: [
          expect.objectContaining({
            receiver: "OpenClaw Alert Webhook",
            matchers: [{ name: "managed_by", type: "=", value: "openclaw" }],
          }),
        ],
      }),
    );
  });

  test("setup returns existing contact point if already created", async () => {
    listContactPointsMock.mockResolvedValueOnce([
      { uid: "cp-existing", name: "OpenClaw Alert Webhook", type: "webhook", settings: {}, disableResolveMessage: false },
    ]);

    const store = createAlertStore();
    const tool = createCheckAlertsToolFactory(makeRegistry(), store)({} as never);
    const result = await tool!.execute("call-6", { action: "setup" });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.status).toBe("already_exists");
    expect(parsed.contactPointUid).toBe("cp-existing");
    expect(createContactPointMock).not.toHaveBeenCalled();
  });

  test("setup uses custom webhookUrl when provided", async () => {
    listContactPointsMock.mockResolvedValueOnce([]);
    createContactPointMock.mockResolvedValueOnce({ uid: "cp-custom", name: "OpenClaw Alert Webhook" });
    getNotificationPoliciesMock.mockResolvedValueOnce({ receiver: "default", routes: [] });
    updateNotificationPoliciesMock.mockResolvedValueOnce(undefined);

    const store = createAlertStore();
    const tool = createCheckAlertsToolFactory(makeRegistry(), store)({} as never);
    await tool!.execute("call-7", { action: "setup", webhookUrl: "https://my.server.com/alerts" });

    const createArgs = createContactPointMock.mock.calls[0][0];
    expect(createArgs.settings.url).toBe("https://my.server.com/alerts");
  });

  test("setup skips policy update if route already exists", async () => {
    listContactPointsMock.mockResolvedValueOnce([]);
    createContactPointMock.mockResolvedValueOnce({ uid: "cp-new", name: "OpenClaw Alert Webhook" });
    getNotificationPoliciesMock.mockResolvedValueOnce({
      receiver: "default",
      routes: [
        {
          receiver: "OpenClaw Alert Webhook",
          matchers: [{ name: "managed_by", type: "=", value: "openclaw" }],
        },
      ],
    });

    const store = createAlertStore();
    const tool = createCheckAlertsToolFactory(makeRegistry(), store)({} as never);
    await tool!.execute("call-8", { action: "setup" });

    expect(updateNotificationPoliciesMock).not.toHaveBeenCalled();
  });

  test("setup handles API errors gracefully", async () => {
    listContactPointsMock.mockRejectedValueOnce(new Error("Grafana API error 500: internal"));

    const store = createAlertStore();
    const tool = createCheckAlertsToolFactory(makeRegistry(), store)({} as never);
    const result = await tool!.execute("call-9", { action: "setup" });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.error).toContain("Failed to set up alert webhook");
  });

  // ── Silence action ────────────────────────────────────────────────

  test("silence creates silence with matchers", async () => {
    createSilenceMock.mockResolvedValueOnce({ silenceID: "silence-abc" });

    const store = createAlertStore();
    const tool = createCheckAlertsToolFactory(makeRegistry(), store)({} as never);
    const result = await tool!.execute("call-10", {
      action: "silence",
      matchers: [{ name: "alertname", value: "HighCost" }],
      duration: "1h",
      comment: "Investigating cost spike",
    });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.status).toBe("silenced");
    expect(parsed.silenceId).toBe("silence-abc");
    expect(parsed.duration).toBe("1h");

    expect(createSilenceMock).toHaveBeenCalledWith(
      [{ name: "alertname", value: "HighCost", isRegex: false }],
      "1h",
      "Investigating cost spike",
    );
  });

  test("silence returns error when matchers missing", async () => {
    const store = createAlertStore();
    const tool = createCheckAlertsToolFactory(makeRegistry(), store)({} as never);
    const result = await tool!.execute("call-11", { action: "silence" });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.error).toContain("matchers");
  });

  test("silence uses defaults for duration and comment", async () => {
    createSilenceMock.mockResolvedValueOnce({ silenceID: "silence-def" });

    const store = createAlertStore();
    const tool = createCheckAlertsToolFactory(makeRegistry(), store)({} as never);
    await tool!.execute("call-12", {
      action: "silence",
      matchers: [{ name: "alertname", value: "Test" }],
    });

    expect(createSilenceMock).toHaveBeenCalledWith(
      [{ name: "alertname", value: "Test", isRegex: false }],
      "2h",
      "Silenced by agent during investigation",
    );
  });

  // ── Unsilence action ──────────────────────────────────────────────

  test("unsilence removes silence by ID", async () => {
    deleteSilenceMock.mockResolvedValueOnce(undefined);

    const store = createAlertStore();
    const tool = createCheckAlertsToolFactory(makeRegistry(), store)({} as never);
    const result = await tool!.execute("call-13", {
      action: "unsilence",
      silenceId: "silence-abc",
    });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.status).toBe("unsilenced");
    expect(parsed.silenceId).toBe("silence-abc");
    expect(deleteSilenceMock).toHaveBeenCalledWith("silence-abc");
  });

  test("unsilence returns error on API failure", async () => {
    deleteSilenceMock.mockRejectedValueOnce(new Error("Not found: delete silence bad-id"));

    const store = createAlertStore();
    const tool = createCheckAlertsToolFactory(makeRegistry(), store)({} as never);
    const result = await tool!.execute("call-14", {
      action: "unsilence",
      silenceId: "bad-id",
    });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.error).toContain("Failed to remove silence");
  });

  // ── Response consistency ──────────────────────────────────────────

  test("list includes status: success in response", async () => {
    const store = createAlertStore();
    store.addAlert(makeNotification());

    const tool = createCheckAlertsToolFactory(makeRegistry(), store)({} as never);
    const result = await tool!.execute("call-15", {});

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.status).toBe("success");
  });

  test("empty list includes status: success in response", async () => {
    const store = createAlertStore();
    const tool = createCheckAlertsToolFactory(makeRegistry(), store)({} as never);
    const result = await tool!.execute("call-16", {});

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.status).toBe("success");
  });

  // ── Instance truncation ───────────────────────────────────────────

  test("list truncates instances to 5 and reports totalInstances", async () => {
    const manyInstances = Array.from({ length: 8 }, (_, i) => ({
      status: "firing" as const,
      labels: { alertname: "Test", instance: `inst-${i}` },
      annotations: { summary: "test" },
      startsAt: "2026-02-18T10:00:00Z",
      endsAt: "0001-01-01T00:00:00Z",
      generatorURL: "http://localhost:3000",
      fingerprint: `fp-${i}`,
      values: { B: i },
    }));

    const store = createAlertStore();
    store.addAlert(makeNotification({ alerts: manyInstances }));

    const tool = createCheckAlertsToolFactory(makeRegistry(), store)({} as never);
    const result = await tool!.execute("call-17", {});

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.alerts[0].instances).toHaveLength(5);
    expect(parsed.alerts[0].totalInstances).toBe(8);
    expect(parsed.alerts[0].truncated).toBe(true);
  });

  test("list does not set truncated when instances <= 5", async () => {
    const store = createAlertStore();
    store.addAlert(makeNotification());

    const tool = createCheckAlertsToolFactory(makeRegistry(), store)({} as never);
    const result = await tool!.execute("call-18", {});

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.alerts[0].instances).toHaveLength(1);
    expect(parsed.alerts[0].totalInstances).toBe(1);
    expect(parsed.alerts[0].truncated).toBeUndefined();
  });

  // ── Investigation enrichment ──────────────────────────────────────

  test("list includes suggestedInvestigation when rule matches via generatorURL", async () => {
    listAlertRulesMock.mockResolvedValueOnce([
      {
        uid: "alert-1",
        title: "HighCost",
        folderUID: "folder-1",
        ruleGroup: "cost",
        condition: "C",
        data: [
          {
            refId: "A",
            datasourceUid: "prom-1",
            model: { expr: "sum(rate(openclaw_lens_cost_by_token_type[5m]))" },
            relativeTimeRange: { from: 600, to: 0 },
          },
          { refId: "B", datasourceUid: "__expr__", model: { type: "reduce" } },
          { refId: "C", datasourceUid: "__expr__", model: { type: "threshold" } },
        ],
        for: "5m",
        noDataState: "NoData",
        execErrState: "Alerting",
        labels: { managed_by: "openclaw" },
        annotations: {},
        updated: "2026-02-20T10:00:00Z",
        provenance: "",
      },
    ]);
    listDatasourcesMock.mockResolvedValueOnce([
      { id: 1, uid: "prom-1", name: "Mimir", type: "prometheus", url: "", isDefault: true, access: "proxy" },
    ]);

    const store = createAlertStore();
    store.addAlert(makeNotification());

    const tool = createCheckAlertsToolFactory(makeRegistry(), store)({} as never);
    const result = await tool!.execute("call-inv-1", { action: "list" });

    const parsed = JSON.parse(getTextContent(result));
    const inv = parsed.alerts[0].suggestedInvestigation;
    expect(inv).toBeDefined();
    expect(inv.datasourceUid).toBe("prom-1");
    expect(inv.condition).toBe("sum(rate(openclaw_lens_cost_by_token_type[5m]))");
    expect(inv.tool).toBe("grafana_query");
    expect(inv.queryLanguage).toBe("PromQL");
    expect(inv.hint).toContain("grafana_query");
  });

  test("list falls back to title matching when generatorURL has no rule UID", async () => {
    listAlertRulesMock.mockResolvedValueOnce([
      {
        uid: "rule-xyz",
        title: "HighCost",
        folderUID: "folder-1",
        ruleGroup: "cost",
        condition: "C",
        data: [
          { refId: "A", datasourceUid: "loki-1", model: { expr: '{job="openclaw"} |= "error"' }, relativeTimeRange: { from: 600, to: 0 } },
        ],
        for: "5m",
        noDataState: "NoData",
        execErrState: "Alerting",
        labels: {},
        annotations: {},
        updated: "2026-02-20T10:00:00Z",
        provenance: "",
      },
    ]);
    listDatasourcesMock.mockResolvedValueOnce([
      { id: 2, uid: "loki-1", name: "Loki", type: "loki", url: "", isDefault: false, access: "proxy" },
    ]);

    // generatorURL without /alerting/<uid>/edit pattern
    const store = createAlertStore();
    store.addAlert(makeNotification({
      alerts: [{
        status: "firing",
        labels: { alertname: "HighCost" },
        annotations: {},
        startsAt: "2026-02-18T10:00:00Z",
        endsAt: "0001-01-01T00:00:00Z",
        generatorURL: "http://localhost:3000/some-other-url",
        fingerprint: "abc",
        values: {},
      }],
    }));

    const tool = createCheckAlertsToolFactory(makeRegistry(), store)({} as never);
    const result = await tool!.execute("call-inv-2", { action: "list" });

    const parsed = JSON.parse(getTextContent(result));
    const inv = parsed.alerts[0].suggestedInvestigation;
    expect(inv).toBeDefined();
    expect(inv.datasourceUid).toBe("loki-1");
    expect(inv.tool).toBe("grafana_query_logs");
    expect(inv.queryLanguage).toBe("LogQL");
  });

  test("list omits suggestedInvestigation when no rule matches", async () => {
    // Rules don't match the alert
    listAlertRulesMock.mockResolvedValueOnce([
      {
        uid: "rule-other",
        title: "DifferentAlert",
        folderUID: "f1",
        ruleGroup: "g1",
        condition: "C",
        data: [{ refId: "A", datasourceUid: "prom-1", model: { expr: "up == 0" } }],
        for: "5m",
        noDataState: "NoData",
        execErrState: "Alerting",
        labels: {},
        annotations: {},
        updated: "2026-02-20T10:00:00Z",
        provenance: "",
      },
    ]);
    listDatasourcesMock.mockResolvedValueOnce([]);

    const store = createAlertStore();
    // generatorURL points to non-matching rule UID
    store.addAlert(makeNotification({
      alerts: [{
        status: "firing",
        labels: { alertname: "HighCost" },
        annotations: {},
        startsAt: "2026-02-18T10:00:00Z",
        endsAt: "0001-01-01T00:00:00Z",
        generatorURL: "http://localhost:3000/alerting/unknown-rule/edit",
        fingerprint: "abc",
        values: {},
      }],
      title: "[FIRING:1] NoMatch",
    }));

    const tool = createCheckAlertsToolFactory(makeRegistry(), store)({} as never);
    const result = await tool!.execute("call-inv-3", { action: "list" });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.alerts[0].suggestedInvestigation).toBeUndefined();
  });

  test("list still works when rule/datasource APIs fail (best-effort enrichment)", async () => {
    listAlertRulesMock.mockRejectedValueOnce(new Error("API error"));
    listDatasourcesMock.mockRejectedValueOnce(new Error("API error"));

    const store = createAlertStore();
    store.addAlert(makeNotification());

    const tool = createCheckAlertsToolFactory(makeRegistry(), store)({} as never);
    const result = await tool!.execute("call-inv-4", { action: "list" });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.status).toBe("success");
    expect(parsed.alertCount).toBe(1);
    expect(parsed.alerts[0].id).toBe("alert-1");
    // No investigation hint, but list still succeeds
    expect(parsed.alerts[0].suggestedInvestigation).toBeUndefined();
  });

  // ── extractRuleUidFromGeneratorUrl ────────────────────────────────

  test("extractRuleUidFromGeneratorUrl extracts UID from edit URL", () => {
    expect(extractRuleUidFromGeneratorUrl("http://localhost:3000/alerting/rule-abc/edit")).toBe("rule-abc");
  });

  test("extractRuleUidFromGeneratorUrl extracts UID from view URL", () => {
    expect(extractRuleUidFromGeneratorUrl("http://localhost:3000/alerting/my-rule-123/view")).toBe("my-rule-123");
  });

  test("extractRuleUidFromGeneratorUrl returns null for non-matching URL", () => {
    expect(extractRuleUidFromGeneratorUrl("http://localhost:3000/dashboards")).toBeNull();
    expect(extractRuleUidFromGeneratorUrl("")).toBeNull();
  });

  // ── Analyze action (alert fatigue) ──────────────────────────────────

  test("analyze returns healthy when all rules are normal", async () => {
    listAlertRulesMock.mockResolvedValueOnce([
      {
        uid: "rule-1",
        title: "Cost Alert",
        folderUID: "f1",
        ruleGroup: "g1",
        condition: "C",
        data: [{ refId: "A", datasourceUid: "prom-1", model: { expr: "up" } }],
        for: "5m",
        noDataState: "NoData",
        execErrState: "Alerting",
        labels: {},
        annotations: {},
        updated: "2026-02-20T10:00:00Z",
        provenance: "",
      },
    ]);
    getAlertRuleStatesMock.mockResolvedValueOnce(new Map([
      ["rule-1", {
        uid: "rule-1",
        state: "inactive",
        health: "ok",
        lastEvaluation: "2026-02-20T12:00:00Z",
        evaluationTime: 0.001,
        isPaused: false,
      }],
    ]));

    const store = createAlertStore();
    const tool = createCheckAlertsToolFactory(makeRegistry(), store)({} as never);
    const result = await tool!.execute("call-analyze-1", { action: "analyze" });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.status).toBe("success");
    expect(parsed.totalRules).toBe(1);
    expect(parsed.overallHealth).toBe("healthy");
    expect(parsed.fatigueReport.alwaysFiring).toHaveLength(0);
    expect(parsed.fatigueReport.flapping).toHaveLength(0);
    expect(parsed.fatigueReport.healthy).toBe(1);
  });

  test("analyze detects flapping rules with error health", async () => {
    listAlertRulesMock.mockResolvedValueOnce([
      {
        uid: "rule-err",
        title: "Broken Alert",
        folderUID: "f1",
        ruleGroup: "g1",
        condition: "C",
        data: [{ refId: "A", datasourceUid: "prom-1", model: { expr: "nonexistent_metric" } }],
        for: "5m",
        noDataState: "NoData",
        execErrState: "Alerting",
        labels: {},
        annotations: {},
        updated: "2026-02-20T10:00:00Z",
        provenance: "",
      },
    ]);
    getAlertRuleStatesMock.mockResolvedValueOnce(new Map([
      ["rule-err", {
        uid: "rule-err",
        state: "firing",
        health: "error",
        lastEvaluation: "2026-02-20T12:00:00Z",
        evaluationTime: 0.001,
        isPaused: false,
      }],
    ]));

    const store = createAlertStore();
    const tool = createCheckAlertsToolFactory(makeRegistry(), store)({} as never);
    const result = await tool!.execute("call-analyze-2", { action: "analyze" });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.overallHealth).toBe("moderate_fatigue");
    expect(parsed.fatigueReport.flapping).toHaveLength(1);
    expect(parsed.fatigueReport.flapping[0].uid).toBe("rule-err");
    expect(parsed.fatigueReport.flapping[0].suggestion).toContain("error");
  });

  test("analyze detects nodata rules as flapping", async () => {
    listAlertRulesMock.mockResolvedValueOnce([
      {
        uid: "rule-nodata",
        title: "Missing Data Alert",
        folderUID: "f1",
        ruleGroup: "g1",
        condition: "C",
        data: [{ refId: "A", datasourceUid: "prom-1", model: { expr: "missing_metric" } }],
        for: "5m",
        noDataState: "NoData",
        execErrState: "Alerting",
        labels: {},
        annotations: {},
        updated: "2026-02-20T10:00:00Z",
        provenance: "",
      },
    ]);
    getAlertRuleStatesMock.mockResolvedValueOnce(new Map([
      ["rule-nodata", {
        uid: "rule-nodata",
        state: "nodata",
        health: "nodata",
        lastEvaluation: "2026-02-20T12:00:00Z",
        evaluationTime: 0.001,
        isPaused: false,
      }],
    ]));

    const store = createAlertStore();
    const tool = createCheckAlertsToolFactory(makeRegistry(), store)({} as never);
    const result = await tool!.execute("call-analyze-3", { action: "analyze" });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.fatigueReport.flapping).toHaveLength(1);
    expect(parsed.fatigueReport.flapping[0].suggestion).toContain("no data");
  });

  test("analyze returns empty report when no rules exist", async () => {
    listAlertRulesMock.mockResolvedValueOnce([]);

    const store = createAlertStore();
    const tool = createCheckAlertsToolFactory(makeRegistry(), store)({} as never);
    const result = await tool!.execute("call-analyze-4", { action: "analyze" });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.status).toBe("success");
    expect(parsed.totalRules).toBe(0);
    expect(parsed.overallHealth).toBe("healthy");
    expect(parsed.suggestions[0]).toContain("No alert rules");
  });

  test("analyze handles API error gracefully", async () => {
    listAlertRulesMock.mockRejectedValueOnce(new Error("API 500"));

    const store = createAlertStore();
    const tool = createCheckAlertsToolFactory(makeRegistry(), store)({} as never);
    const result = await tool!.execute("call-analyze-5", { action: "analyze" });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.error).toContain("Failed to analyze");
  });

  test("analyze reports severe fatigue when many rules are problematic", async () => {
    const rules = Array.from({ length: 5 }, (_, i) => ({
      uid: `rule-${i}`,
      title: `Broken Rule ${i}`,
      folderUID: "f1",
      ruleGroup: "g1",
      condition: "C",
      data: [{ refId: "A", datasourceUid: "prom-1", model: { expr: "broken" } }],
      for: "5m",
      noDataState: "NoData",
      execErrState: "Alerting",
      labels: {},
      annotations: {},
      updated: "2026-02-20T10:00:00Z",
      provenance: "",
    }));
    listAlertRulesMock.mockResolvedValueOnce(rules);
    const stateMap = new Map(rules.map((r) => [r.uid, {
      uid: r.uid,
      state: "nodata",
      health: "nodata",
      lastEvaluation: "2026-02-20T12:00:00Z",
      evaluationTime: 0.001,
      isPaused: false,
    }]));
    getAlertRuleStatesMock.mockResolvedValueOnce(stateMap);

    const store = createAlertStore();
    const tool = createCheckAlertsToolFactory(makeRegistry(), store)({} as never);
    const result = await tool!.execute("call-analyze-6", { action: "analyze" });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.overallHealth).toBe("severe_fatigue");
    expect(parsed.fatigueReport.flapping).toHaveLength(5);
  });
});
