import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AlloyClient } from "./alloy-client.js";

// ── Mock fetch globally ─────────────────────────────────────────────

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

function mockResponse(status: number, body: unknown = "", headers?: Record<string, string>): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    json: async () => (typeof body === "string" ? JSON.parse(body) : body),
    headers: new Headers(headers),
  } as unknown as Response;
}

describe("AlloyClient", () => {
  let client: AlloyClient;

  beforeEach(() => {
    fetchMock.mockReset();
    client = new AlloyClient({ url: "http://localhost:12345", timeout: 1000 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("healthy()", () => {
    test("returns ok when Alloy is healthy", async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(200, "OK"));
      const result = await client.healthy();
      expect(result.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledWith(
        "http://localhost:12345/-/healthy",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    test("returns unhealthy components when Alloy reports issues", async () => {
      fetchMock.mockResolvedValueOnce(
        mockResponse(500, "unhealthy components: prometheus.scrape.bad_target, loki.source.missing\n"),
      );
      const result = await client.healthy();
      expect(result.ok).toBe(false);
      expect(result.unhealthyComponents).toEqual([
        "prometheus.scrape.bad_target",
        "loki.source.missing",
      ]);
    });

    test("returns error when Alloy is unreachable", async () => {
      fetchMock.mockRejectedValueOnce(new Error("fetch failed: ECONNREFUSED"));
      const result = await client.healthy();
      expect(result.ok).toBe(false);
      expect(result.error).toContain("Connection refused");
    });
  });

  describe("ready()", () => {
    test("returns true when ready", async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(200));
      expect(await client.ready()).toBe(true);
    });

    test("returns false when not ready", async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(503));
      expect(await client.ready()).toBe(false);
    });

    test("returns false when unreachable", async () => {
      fetchMock.mockRejectedValueOnce(new Error("unreachable"));
      expect(await client.ready()).toBe(false);
    });
  });

  describe("reload()", () => {
    test("returns ok on successful reload", async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(200));
      const result = await client.reload();
      expect(result.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledWith(
        "http://localhost:12345/-/reload",
        expect.objectContaining({ method: "POST" }),
      );
    });

    test("returns error on failed reload (bad config)", async () => {
      fetchMock.mockResolvedValueOnce(
        mockResponse(400, "unknown component prometheus.exporter.invalid"),
      );
      const result = await client.reload();
      expect(result.ok).toBe(false);
      expect(result.error).toContain("prometheus.exporter.invalid");
    });

    test("returns error when unreachable", async () => {
      fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      const result = await client.reload();
      expect(result.ok).toBe(false);
      expect(result.error).toContain("Connection refused");
    });
  });

  describe("listComponents()", () => {
    test("returns component list", async () => {
      const components = [
        {
          localID: "prometheus.scrape.test",
          name: "prometheus.scrape",
          health: { state: "healthy", message: "", updatedTime: "" },
        },
      ];
      fetchMock.mockResolvedValueOnce(mockResponse(200, components));
      const result = await client.listComponents();
      expect(result).toHaveLength(1);
      expect(result[0].localID).toBe("prometheus.scrape.test");
    });

    test("throws on API error", async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(500, "Internal error"));
      await expect(client.listComponents()).rejects.toThrow("500");
    });
  });

  describe("getComponent()", () => {
    test("returns component info", async () => {
      const comp = {
        localID: "prometheus.scrape.test",
        name: "prometheus.scrape",
        health: { state: "healthy", message: "OK", updatedTime: "2026-01-01T00:00:00Z" },
      };
      fetchMock.mockResolvedValueOnce(mockResponse(200, comp));
      const result = await client.getComponent("prometheus.scrape.test");
      expect(result).not.toBeNull();
      expect(result!.health.state).toBe("healthy");
    });

    test("returns null for missing component", async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(404, "Not found"));
      const result = await client.getComponent("nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("checkPipelineHealth()", () => {
    test("classifies components correctly via batch fetch", async () => {
      // Single call returns all components
      fetchMock.mockResolvedValueOnce(
        mockResponse(200, [
          {
            localID: "prometheus.scrape.a",
            name: "prometheus.scrape",
            health: { state: "healthy", message: "OK", updatedTime: "" },
          },
          {
            localID: "prometheus.remote_write.b",
            name: "prometheus.remote_write",
            health: { state: "unhealthy", message: "connection refused", updatedTime: "" },
          },
        ]),
      );

      const result = await client.checkPipelineHealth([
        "prometheus.scrape.a",
        "prometheus.remote_write.b",
        "missing.component.c",
      ]);

      expect(result.healthy).toEqual(["prometheus.scrape.a"]);
      expect(result.unhealthy).toHaveLength(1);
      expect(result.unhealthy[0].id).toBe("prometheus.remote_write.b");
      expect(result.unhealthy[0].message).toContain("connection refused");
      expect(result.missing).toEqual(["missing.component.c"]);
    });
  });

  describe("URL handling", () => {
    test("strips trailing slashes from URL", () => {
      const c = new AlloyClient({ url: "http://localhost:12345///" });
      expect(c.baseUrl).toBe("http://localhost:12345");
    });
  });
});
