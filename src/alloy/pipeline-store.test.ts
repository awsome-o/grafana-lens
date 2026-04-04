import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { PipelineStore } from "./pipeline-store.js";
import type { PipelineDefinition } from "./types.js";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

function makePipeline(overrides: Partial<PipelineDefinition> = {}): PipelineDefinition {
  return {
    id: "a1b2c3d4",
    name: "test-pipeline",
    recipe: "scrape-endpoint",
    params: { url: "http://localhost:8080/metrics" },
    filePath: "/tmp/alloy/lens-test-pipeline-a1b2c3d4.alloy",
    status: "active",
    componentIds: ["prometheus.scrape.lens_a1b2c3d4_test"],
    signal: "metrics",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    configHash: "abc123",
    ...overrides,
  };
}

describe("PipelineStore", () => {
  let tempDir: string;
  let configDir: string;
  let store: PipelineStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "alloy-store-test-"));
    configDir = join(tempDir, "config.d");
    await mkdir(configDir, { recursive: true });
    store = new PipelineStore({
      stateDir: tempDir,
      configDir,
      limits: { maxPipelines: 3 },
    });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("load/save lifecycle", () => {
    test("starts with empty state", async () => {
      await store.load();
      expect(store.list()).toEqual([]);
    });

    test("persists pipelines across load/save", async () => {
      await store.load();
      store.add(makePipeline());
      await store.save();

      // Create a new store and load from same dir
      const store2 = new PipelineStore({ stateDir: tempDir, configDir });
      await store2.load();
      expect(store2.list()).toHaveLength(1);
      expect(store2.get("test-pipeline")?.recipe).toBe("scrape-endpoint");
    });

    test("handles corrupt state file gracefully", async () => {
      await writeFile(join(tempDir, "alloy-pipelines.json"), "not json{{{", "utf-8");
      await expect(store.load()).rejects.toThrow();
    });
  });

  describe("CRUD operations", () => {
    beforeEach(async () => {
      await store.load();
    });

    test("add and get pipeline", () => {
      const pipeline = makePipeline();
      store.add(pipeline);
      expect(store.get("test-pipeline")).toEqual(pipeline);
    });

    test("rejects duplicate names", () => {
      store.add(makePipeline());
      expect(() => store.add(makePipeline())).toThrow("already exists");
    });

    test("enforces pipeline limit", () => {
      store.add(makePipeline({ id: "1", name: "p1" }));
      store.add(makePipeline({ id: "2", name: "p2" }));
      store.add(makePipeline({ id: "3", name: "p3" }));
      expect(() => store.add(makePipeline({ id: "4", name: "p4" }))).toThrow(
        "limit of 3",
      );
    });

    test("stopped/failed pipelines don't count toward limit", () => {
      store.add(makePipeline({ id: "1", name: "p1", status: "stopped" }));
      store.add(makePipeline({ id: "2", name: "p2", status: "failed" }));
      store.add(makePipeline({ id: "3", name: "p3" }));
      store.add(makePipeline({ id: "4", name: "p4" }));
      store.add(makePipeline({ id: "5", name: "p5" }));
      // Only 3 active, limit is 3 — this should fail
      expect(() => store.add(makePipeline({ id: "6", name: "p6" }))).toThrow("limit");
    });

    test("list with status filter", () => {
      store.add(makePipeline({ id: "1", name: "active1", status: "active" }));
      store.add(makePipeline({ id: "2", name: "failed1", status: "failed" }));
      store.add(makePipeline({ id: "3", name: "active2", status: "active" }));

      expect(store.list("active")).toHaveLength(2);
      expect(store.list("failed")).toHaveLength(1);
      expect(store.list()).toHaveLength(3);
    });

    test("update pipeline", () => {
      store.add(makePipeline());
      const updated = store.update("test-pipeline", {
        status: "drift",
        lastError: "File missing",
      });
      expect(updated).toBe(true);
      expect(store.get("test-pipeline")?.status).toBe("drift");
      expect(store.get("test-pipeline")?.lastError).toBe("File missing");
    });

    test("update returns false for missing pipeline", () => {
      expect(store.update("nonexistent", { status: "active" })).toBe(false);
    });

    test("remove pipeline", () => {
      store.add(makePipeline());
      expect(store.remove("test-pipeline")).toBe(true);
      expect(store.get("test-pipeline")).toBeUndefined();
      expect(store.list()).toHaveLength(0);
    });

    test("remove returns false for missing pipeline", () => {
      expect(store.remove("nonexistent")).toBe(false);
    });

    test("usage reflects active pipelines", () => {
      store.add(makePipeline({ id: "1", name: "p1", status: "active" }));
      store.add(makePipeline({ id: "2", name: "p2", status: "stopped" }));
      const usage = store.usage();
      expect(usage.count).toBe(1);
      expect(usage.max).toBe(3);
    });
  });

  describe("configFilePath", () => {
    test("generates prefixed filename", () => {
      const path = store.configFilePath("a1b2c3d4", "my-app");
      expect(path).toContain("lens-my-app-a1b2c3d4.alloy");
      expect(path).toContain(configDir);
    });

    test("sanitizes special characters in name", () => {
      const path = store.configFilePath("id1", "my app/with:chars");
      expect(path).not.toContain(" ");
      expect(path).not.toContain("/with");
      expect(path).not.toContain(":");
    });
  });

  describe("configHash", () => {
    test("produces consistent SHA-256 hash", () => {
      const hash1 = PipelineStore.configHash("test content");
      const hash2 = PipelineStore.configHash("test content");
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64); // SHA-256 hex
    });

    test("different content produces different hash", () => {
      const hash1 = PipelineStore.configHash("content a");
      const hash2 = PipelineStore.configHash("content b");
      expect(hash1).not.toBe(hash2);
    });
  });

  describe("drift detection", () => {
    beforeEach(async () => {
      await store.load();
    });

    test("detects missing config file", async () => {
      store.add(
        makePipeline({
          filePath: join(configDir, "lens-missing-a1b2c3d4.alloy"),
        }),
      );

      const report = await store.detectFileDrift();
      expect(report.fileDrift).toHaveLength(1);
      expect(report.fileDrift[0].issue).toContain("missing");
    });

    test("detects hash mismatch", async () => {
      const filePath = join(configDir, "lens-test-a1b2c3d4.alloy");
      await writeFile(filePath, "modified content", "utf-8");

      store.add(
        makePipeline({
          filePath,
          configHash: PipelineStore.configHash("original content"),
        }),
      );

      const report = await store.detectFileDrift();
      expect(report.fileDrift).toHaveLength(1);
      expect(report.fileDrift[0].issue).toContain("hash mismatch");
    });

    test("no drift when file matches", async () => {
      const content = "correct content";
      const filePath = join(configDir, "lens-test-a1b2c3d4.alloy");
      await writeFile(filePath, content, "utf-8");

      store.add(
        makePipeline({
          filePath,
          configHash: PipelineStore.configHash(content),
        }),
      );

      const report = await store.detectFileDrift();
      expect(report.fileDrift).toHaveLength(0);
    });

    test("detects orphan files", async () => {
      await writeFile(
        join(configDir, "lens-orphan-xyz.alloy"),
        "orphan config",
        "utf-8",
      );

      const report = await store.detectFileDrift();
      expect(report.orphanFiles).toEqual(["lens-orphan-xyz.alloy"]);
    });

    test("ignores non-lens files", async () => {
      await writeFile(
        join(configDir, "user-custom.alloy"),
        "user config",
        "utf-8",
      );

      const report = await store.detectFileDrift();
      expect(report.orphanFiles).toHaveLength(0);
    });

    test("skips stopped/failed pipelines", async () => {
      store.add(
        makePipeline({
          name: "stopped-one",
          status: "stopped",
          filePath: join(configDir, "lens-stopped-abc.alloy"),
        }),
      );

      const report = await store.detectFileDrift();
      expect(report.fileDrift).toHaveLength(0);
    });

    test("applyDriftReport updates pipeline status", async () => {
      store.add(makePipeline());

      const report: import("./types.js").DriftReport = {
        fileDrift: [{ name: "test-pipeline", issue: "Config file missing" }],
        orphanFiles: [],
      };

      const updated = store.applyDriftReport(report);
      expect(updated).toBe(1);
      expect(store.get("test-pipeline")?.status).toBe("drift");
      expect(store.get("test-pipeline")?.lastError).toBe("Config file missing");
    });
  });

  describe("generateId", () => {
    test("generates 8-char hex IDs", () => {
      const id = store.generateId();
      expect(id).toHaveLength(8);
      expect(/^[0-9a-f]{8}$/.test(id)).toBe(true);
    });

    test("generates unique IDs", () => {
      const ids = new Set(Array.from({ length: 100 }, () => store.generateId()));
      expect(ids.size).toBe(100);
    });
  });
});
