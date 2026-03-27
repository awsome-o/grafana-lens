import { beforeEach, describe, expect, test, vi } from "vitest";

// ── Hoisted mocks ────────────────────────────────────────────────────

const renderPanelMock = vi.hoisted(() => vi.fn());
const getDashboardMock = vi.hoisted(() => vi.fn());
const createSnapshotMock = vi.hoisted(() => vi.fn());
const dashboardUrlMock = vi.hoisted(() => vi.fn((uid: string) => `http://localhost:3000/d/${uid}`));

vi.mock("../grafana-client.js", () => ({
  GrafanaClient: class {
    renderPanel = renderPanelMock;
    getDashboard = getDashboardMock;
    createSnapshot = createSnapshotMock;
    dashboardUrl = dashboardUrlMock;
    getUrl() { return "http://localhost:3000"; }
  },
}));

const writeFileMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("node:fs/promises", () => ({
  writeFile: writeFileMock,
}));

// ── Imports (after mocks) ────────────────────────────────────────────

import { createShareDashboardToolFactory, classifyRenderFailure, getPNGDimensions } from "./share-dashboard.js";
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

/** Build a minimal valid PNG buffer with specific IHDR dimensions. */
function buildPNGBuffer(width: number, height: number): ArrayBuffer {
  const buf = new ArrayBuffer(33); // 8 sig + 4 len + 4 type + 13 IHDR data + 4 CRC (min)
  const u8 = new Uint8Array(buf);
  // PNG signature
  u8.set([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  // IHDR chunk: length=13, type="IHDR"
  const dv = new DataView(buf);
  dv.setUint32(8, 13, false);
  u8.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  dv.setUint32(16, width, false);
  dv.setUint32(20, height, false);
  return buf;
}

const MOCK_DASHBOARD = { title: "Test", panels: [{ id: 5, title: "Panel 5", type: "stat" }] };

function mockDashboardForValidation() {
  getDashboardMock.mockResolvedValueOnce({ dashboard: MOCK_DASHBOARD });
}

function mockSuccessfulSnapshot() {
  // getDashboard call for Tier 2 snapshot (reuses pre-fetched data, no extra call)
  createSnapshotMock.mockResolvedValueOnce({
    key: "snap-key",
    deleteKey: "del-key",
    url: "http://localhost:3000/dashboard/snapshot/snap-key",
    deleteUrl: "http://localhost:3000/api/snapshots-delete/del-key",
    id: 1,
  });
}

describe("grafana_share_dashboard tool", () => {
  beforeEach(() => {
    renderPanelMock.mockReset();
    getDashboardMock.mockReset();
    createSnapshotMock.mockReset();
    dashboardUrlMock.mockClear();
    writeFileMock.mockReset().mockResolvedValue(undefined);
  });

  test("tier 1: render PNG returns MEDIA: text + image content", async () => {
    // Dashboard with panel 5 for pre-validation
    getDashboardMock.mockResolvedValueOnce({ dashboard: { title: "Test", panels: [{ id: 5, title: "Panel 5", type: "stat" }] } });
    // Valid PNG with matching dimensions (default 1000×500)
    renderPanelMock.mockResolvedValueOnce(buildPNGBuffer(1000, 500));

    const tool = createShareDashboardToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-1", {
      dashboardUid: "dash-1",
      panelId: 5,
    });

    // Should have both text and image content
    expect(result.content).toHaveLength(2);
    const textBlock = result.content[0] as { type: string; text: string };
    const imageBlock = result.content[1] as { type: string; data: string; mimeType: string };
    expect(textBlock.type).toBe("text");
    expect(textBlock.text).toContain("MEDIA:");
    expect(textBlock.text).toContain("panel-5.png");
    expect(imageBlock.type).toBe("image");
    expect(imageBlock.mimeType).toBe("image/png");
    expect(imageBlock.data).toBeTruthy();

    // Should have written file to tmp
    expect(writeFileMock).toHaveBeenCalledTimes(1);

    // Should report deliveryTier and rendererAvailable
    const details = (result as { details: Record<string, unknown> }).details;
    expect(details.deliveryTier).toBe("image");
    expect(details.rendererAvailable).toBe(true);
  });

  test("tier 2: snapshot fallback when render fails", async () => {
    mockDashboardForValidation(); // pre-validation
    renderPanelMock.mockRejectedValueOnce(new Error("Image Renderer not available"));
    mockSuccessfulSnapshot(); // snapshot (reuses pre-fetched dashData)

    const tool = createShareDashboardToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-2", {
      dashboardUid: "dash-1",
      panelId: 5,
    });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.status).toBe("snapshot");
    expect(parsed.deliveryTier).toBe("snapshot");
    expect(parsed.snapshotUrl).toContain("snap-key");
  });

  test("tier 2: placeholder PNG detected and falls through to snapshot", async () => {
    mockDashboardForValidation();
    // Render returns a 478×208 placeholder (mismatched dimensions)
    renderPanelMock.mockResolvedValueOnce(buildPNGBuffer(478, 208));
    mockSuccessfulSnapshot();

    const tool = createShareDashboardToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-placeholder", {
      dashboardUid: "dash-1",
      panelId: 5,
    });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.status).toBe("snapshot");
    expect(parsed.deliveryTier).toBe("snapshot");
    expect(parsed.rendererAvailable).toBe(false);
    expect(parsed.renderFailureReason).toContain("Image Renderer plugin not installed");
  });

  test("tier 3: deep link fallback when both render and snapshot fail", async () => {
    mockDashboardForValidation(); // pre-validation succeeds
    renderPanelMock.mockRejectedValueOnce(new Error("render fail"));
    createSnapshotMock.mockRejectedValueOnce(new Error("snapshot fail"));

    const tool = createShareDashboardToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-3", {
      dashboardUid: "dash-1",
      panelId: 5,
    });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.status).toBe("link");
    expect(parsed.deliveryTier).toBe("link");
    expect(parsed.dashboardUrl).toContain("/d/dash-1");
  });

  test("panel validation: nonexistent panel returns structured error", async () => {
    getDashboardMock.mockResolvedValueOnce({ dashboard: { title: "Test", panels: [{ id: 1, title: "Only Panel", type: "stat" }] } });

    const tool = createShareDashboardToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-panel-404", {
      dashboardUid: "dash-1",
      panelId: 999,
    });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.error).toContain("Panel 999 not found");
    expect(parsed.availablePanels).toBeDefined();
    expect(parsed.availablePanels.length).toBeGreaterThan(0);
  });

  // ── Degradation metadata tests ──────────────────────────────────────

  test("tier 2: renderer-not-available includes remediation guidance", async () => {
    mockDashboardForValidation();
    renderPanelMock.mockRejectedValueOnce(
      new Error("Grafana Image Renderer not available — ensure the Image Renderer plugin is installed."),
    );
    mockSuccessfulSnapshot();

    const tool = createShareDashboardToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-4", {
      dashboardUid: "dash-1",
      panelId: 5,
    });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.rendererAvailable).toBe(false);
    expect(parsed.renderFailureReason).toBe("Image Renderer plugin not installed");
    expect(parsed.remediation).toContain("grafana-image-renderer");
    expect(parsed.remediation).toContain("https://grafana.com/docs");
  });

  test("tier 2: auth failure shows rendererAvailable true with auth remediation", async () => {
    mockDashboardForValidation();
    renderPanelMock.mockRejectedValueOnce(
      new Error("Grafana authentication failed — check your service account token"),
    );
    mockSuccessfulSnapshot();

    const tool = createShareDashboardToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-5", {
      dashboardUid: "dash-1",
      panelId: 5,
    });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.rendererAvailable).toBe(true);
    expect(parsed.renderFailureReason).toContain("authentication failed");
    expect(parsed.remediation).toContain("viewer permissions");
  });

  test("tier 3: includes both render and snapshot failure reasons", async () => {
    mockDashboardForValidation();
    renderPanelMock.mockRejectedValueOnce(
      new Error("Grafana Image Renderer not available — ensure the Image Renderer plugin is installed."),
    );
    createSnapshotMock.mockRejectedValueOnce(new Error("Dashboard not found"));

    const tool = createShareDashboardToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-6", {
      dashboardUid: "dash-1",
      panelId: 5,
    });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.deliveryTier).toBe("link");
    expect(parsed.rendererAvailable).toBe(false);
    expect(parsed.renderFailureReason).toBe("Image Renderer plugin not installed");
    expect(parsed.snapshotFailureReason).toBe("Dashboard not found");
    expect(parsed.remediation).toContain("grafana-image-renderer");
  });

  test("tier 3: generic render error gets default remediation", async () => {
    mockDashboardForValidation();
    renderPanelMock.mockRejectedValueOnce(new Error("connection timeout"));
    createSnapshotMock.mockRejectedValueOnce(new Error("also timed out"));

    const tool = createShareDashboardToolFactory(makeRegistry())({} as never);
    const result = await tool!.execute("call-7", {
      dashboardUid: "dash-1",
      panelId: 5,
    });

    const parsed = JSON.parse(getTextContent(result));
    expect(parsed.deliveryTier).toBe("link");
    expect(parsed.rendererAvailable).toBe(true);
    expect(parsed.renderFailureReason).toBe("connection timeout");
    expect(parsed.snapshotFailureReason).toBe("also timed out");
    // No renderer remediation — the renderer is available, just a transient error
    expect(parsed.remediation).toContain("snapshot API");
  });
});

// ── getPNGDimensions unit tests ───────────────────────────────────────

describe("getPNGDimensions", () => {
  test("extracts correct dimensions from valid PNG", () => {
    const dims = getPNGDimensions(buildPNGBuffer(1000, 500));
    expect(dims).toEqual({ width: 1000, height: 500 });
  });

  test("detects placeholder PNG dimensions (478×208)", () => {
    const dims = getPNGDimensions(buildPNGBuffer(478, 208));
    expect(dims).toEqual({ width: 478, height: 208 });
  });

  test("returns null for buffer too small", () => {
    expect(getPNGDimensions(new ArrayBuffer(10))).toBeNull();
  });

  test("returns null for non-PNG buffer", () => {
    const buf = new ArrayBuffer(24);
    new Uint8Array(buf).set([0x00, 0x01, 0x02, 0x03]); // not PNG magic
    expect(getPNGDimensions(buf)).toBeNull();
  });
});

// ── classifyRenderFailure unit tests ──────────────────────────────────

describe("classifyRenderFailure", () => {
  test("identifies missing image renderer (502)", () => {
    const result = classifyRenderFailure(
      new Error("Grafana Image Renderer not available — ensure the Image Renderer plugin is installed."),
    );
    expect(result.rendererAvailable).toBe(false);
    expect(result.renderFailureReason).toBe("Image Renderer plugin not installed");
    expect(result.remediation).toContain("grafana-image-renderer");
  });

  test("identifies authentication failures", () => {
    const result = classifyRenderFailure(
      new Error("Grafana authentication failed — check your service account token"),
    );
    expect(result.rendererAvailable).toBe(true);
    expect(result.remediation).toContain("viewer permissions");
  });

  test("treats other errors as renderer-available", () => {
    const result = classifyRenderFailure(new Error("Panel or dashboard not found (uid: x, panel: 1)"));
    expect(result.rendererAvailable).toBe(true);
    expect(result.remediation).toBeUndefined();
  });

  test("handles non-Error objects", () => {
    const result = classifyRenderFailure("some string error");
    expect(result.rendererAvailable).toBe(true);
    expect(result.renderFailureReason).toBe("some string error");
  });
});
