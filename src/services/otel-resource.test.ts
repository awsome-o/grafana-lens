import { describe, expect, test, vi, afterEach } from "vitest";

// ── Hoisted mocks ────────────────────────────────────────────────────

const lastResourceAttrs = vi.hoisted(() => ({ value: null as Record<string, unknown> | null }));

vi.mock("@opentelemetry/resources", () => ({
  Resource: class {
    constructor(public attrs: Record<string, unknown>) {
      lastResourceAttrs.value = attrs;
    }
  },
}));

vi.mock("@opentelemetry/semantic-conventions", () => ({
  ATTR_SERVICE_NAME: "service.name",
}));

// ── Import after mocks ──────────────────────────────────────────────

import { createOtelResource } from "./otel-resource.js";

afterEach(() => {
  vi.clearAllMocks();
  lastResourceAttrs.value = null;
});

describe("createOtelResource", () => {
  test("sets service.name and service.namespace", () => {
    createOtelResource({});

    expect(lastResourceAttrs.value).toMatchObject({
      "service.name": "openclaw",
      "service.namespace": "grafana-lens",
    });
  });

  test("includes service.version when provided", () => {
    createOtelResource({ serviceVersion: "1.2.3" });

    expect(lastResourceAttrs.value).toMatchObject({
      "service.version": "1.2.3",
    });
  });

  test("omits service.version when not provided", () => {
    createOtelResource({});

    expect(lastResourceAttrs.value).not.toHaveProperty("service.version");
  });

  test("includes service.instance.id when serviceInstanceId provided", () => {
    createOtelResource({ serviceInstanceId: "bot-alice" });

    expect(lastResourceAttrs.value).toMatchObject({
      "service.name": "openclaw",
      "service.namespace": "grafana-lens",
      "service.instance.id": "bot-alice",
    });
  });

  test("omits service.instance.id when serviceInstanceId not provided", () => {
    createOtelResource({});

    expect(lastResourceAttrs.value).not.toHaveProperty("service.instance.id");
  });

  test("includes both version and instanceId when both provided", () => {
    createOtelResource({ serviceVersion: "1.0.0", serviceInstanceId: "bot-bob" });

    expect(lastResourceAttrs.value).toMatchObject({
      "service.name": "openclaw",
      "service.namespace": "grafana-lens",
      "service.version": "1.0.0",
      "service.instance.id": "bot-bob",
    });
  });
});
