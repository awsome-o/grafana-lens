import { describe, expect, test, vi, beforeEach } from "vitest";
import {
  createAlertStore,
  createAlertWebhookService,
  type GrafanaAlertNotification,
  type AlertWebhookHttpResponse,
} from "./alert-webhook.js";
import type { ValidatedGrafanaLensConfig } from "../config.js";

// ── Alert Store tests ────────────────────────────────────────────────

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

describe("AlertStore", () => {
  test("addAlert stores and returns alert with id", () => {
    const store = createAlertStore();
    const stored = store.addAlert(makeNotification());

    expect(stored.id).toBe("alert-1");
    expect(stored.status).toBe("firing");
    expect(stored.acknowledged).toBe(false);
    expect(stored.title).toBe("[FIRING:1] HighCost");
  });

  test("getPendingAlerts returns only unacknowledged alerts", () => {
    const store = createAlertStore();
    store.addAlert(makeNotification());
    store.addAlert(makeNotification({ title: "Second" }));

    expect(store.getPendingAlerts()).toHaveLength(2);

    store.acknowledgeAlert("alert-1");
    expect(store.getPendingAlerts()).toHaveLength(1);
    expect(store.getPendingAlerts()[0].id).toBe("alert-2");
  });

  test("acknowledgeAll marks all as acknowledged", () => {
    const store = createAlertStore();
    store.addAlert(makeNotification());
    store.addAlert(makeNotification());
    store.addAlert(makeNotification());

    const count = store.acknowledgeAll();
    expect(count).toBe(3);
    expect(store.getPendingAlerts()).toHaveLength(0);
  });

  test("acknowledgeAlert returns false for unknown id", () => {
    const store = createAlertStore();
    expect(store.acknowledgeAlert("nonexistent")).toBe(false);
  });

  test("getAlert retrieves specific alert", () => {
    const store = createAlertStore();
    store.addAlert(makeNotification({ title: "First" }));
    store.addAlert(makeNotification({ title: "Second" }));

    const alert = store.getAlert("alert-2");
    expect(alert?.title).toBe("Second");
  });

  test("evicts oldest when over capacity (50)", () => {
    const store = createAlertStore();
    for (let i = 0; i < 55; i++) {
      store.addAlert(makeNotification({ title: `Alert ${i}` }));
    }

    expect(store.size()).toBe(50);
    // First 5 should have been evicted
    expect(store.getAlert("alert-1")).toBeUndefined();
    expect(store.getAlert("alert-6")).toBeDefined();
  });
});

// ── Webhook Service tests ────────────────────────────────────────────

function makeConfig(overrides?: Partial<ValidatedGrafanaLensConfig>): ValidatedGrafanaLensConfig {
  return {
    grafana: {
      instances: { default: { url: "http://localhost:3000", apiKey: "test-key" } },
      defaultInstance: "default",
    },
    proactive: { enabled: true },
    ...overrides,
  } as ValidatedGrafanaLensConfig;
}

function makeCtx() {
  return {
    config: {},
    stateDir: "/tmp/grafana-lens-test",
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
}

describe("AlertWebhookService", () => {
  let registeredHandler: ((req: unknown, res: AlertWebhookHttpResponse) => Promise<void> | void) | null = null;

  const registerHttpRoute = vi.fn((params: { path: string; handler: (req: unknown, res: AlertWebhookHttpResponse) => Promise<void> | void }) => {
    registeredHandler = params.handler;
  });

  beforeEach(() => {
    registeredHandler = null;
    registerHttpRoute.mockClear();
  });

  test("registers HTTP route when proactive is enabled", async () => {
    const { service } = createAlertWebhookService(makeConfig(), registerHttpRoute);
    await service.start(makeCtx());

    expect(registerHttpRoute).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/grafana-lens/alerts" }),
    );
  });

  test("skips registration when proactive is disabled", async () => {
    const { service } = createAlertWebhookService(
      makeConfig({ proactive: { enabled: false } }),
      registerHttpRoute,
    );
    const ctx = makeCtx();
    await service.start(ctx);

    expect(registerHttpRoute).not.toHaveBeenCalled();
    expect(ctx.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("alert webhook disabled"),
    );
  });

  test("uses custom webhook path from config", async () => {
    const { service } = createAlertWebhookService(
      makeConfig({ proactive: { enabled: true, webhookPath: "/custom/alerts" } }),
      registerHttpRoute,
    );
    await service.start(makeCtx());

    expect(registerHttpRoute).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/custom/alerts" }),
    );
  });

  test("handler stores alert and returns 200", async () => {
    const { service, store } = createAlertWebhookService(makeConfig(), registerHttpRoute);
    await service.start(makeCtx());

    expect(registeredHandler).toBeTruthy();

    const notification = makeNotification();
    const body = JSON.stringify(notification);
    const req = {
      method: "POST",
      on(event: string, cb: (data?: unknown) => void) {
        if (event === "data") cb(Buffer.from(body));
        if (event === "end") cb();
      },
    };
    const res = { writeHead: vi.fn(), end: vi.fn() };

    await registeredHandler!(req, res);

    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    const responseBody = JSON.parse(res.end.mock.calls[0][0] as string);
    expect(responseBody.status).toBe("received");
    expect(responseBody.id).toBe("alert-1");
    expect(store.getPendingAlerts()).toHaveLength(1);
  });

  test("handler rejects non-POST methods", async () => {
    const { service } = createAlertWebhookService(makeConfig(), registerHttpRoute);
    await service.start(makeCtx());

    const req = {
      method: "GET",
      on: vi.fn(),
    };
    const res = { writeHead: vi.fn(), end: vi.fn() };

    await registeredHandler!(req, res);

    expect(res.writeHead).toHaveBeenCalledWith(405, expect.any(Object));
  });

  test("handler returns 400 when alerts is not an array", async () => {
    const { service } = createAlertWebhookService(makeConfig(), registerHttpRoute);
    await service.start(makeCtx());

    const body = JSON.stringify({ status: "firing", alerts: "not-an-array" });
    const req = {
      method: "POST",
      on(event: string, cb: (data?: unknown) => void) {
        if (event === "data") cb(Buffer.from(body));
        if (event === "end") cb();
      },
    };
    const res = { writeHead: vi.fn(), end: vi.fn() };

    await registeredHandler!(req, res);

    expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    const responseBody = JSON.parse(res.end.mock.calls[0][0] as string);
    expect(responseBody.error).toBe("Invalid alert notification payload");
  });

  test("handler returns 400 for invalid JSON", async () => {
    const { service } = createAlertWebhookService(makeConfig(), registerHttpRoute);
    await service.start(makeCtx());

    const req = {
      method: "POST",
      on(event: string, cb: (data?: unknown) => void) {
        if (event === "data") cb(Buffer.from("not json"));
        if (event === "end") cb();
      },
    };
    const res = { writeHead: vi.fn(), end: vi.fn() };

    await registeredHandler!(req, res);

    expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
  });
});
