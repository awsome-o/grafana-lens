/**
 * Pipeline Store
 *
 * Manages the lifecycle of Alloy pipeline definitions:
 *   - CRUD operations on pipeline records
 *   - Persistence to ${stateDir}/alloy-pipelines.json
 *   - Drift detection (file vs. state vs. Alloy components)
 *   - Limit enforcement (max pipelines)
 *
 * Follows the same persistence pattern as CustomMetricsStore:
 *   - Versioned JSON file in stateDir
 *   - Load on start, save after each mutation
 *   - Survives process restarts
 *
 * State is the source of truth for what Grafana Lens has created.
 * Drift detection reconciles state with the filesystem and Alloy runtime.
 */

import { readFile, writeFile, rename, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type {
  AlloyPipelineState,
  PipelineDefinition,
  PipelineStatus,
  AlloyPipelineLimits,
  DriftReport,
} from "./types.js";

const STATE_FILE = "alloy-pipelines.json";
const DEFAULT_LIMITS: AlloyPipelineLimits = {
  maxPipelines: 20,
};

export class PipelineStore {
  private state: AlloyPipelineState = { version: 1, pipelines: [] };
  private readonly stateFilePath: string;
  private readonly limits: AlloyPipelineLimits;
  private readonly configDir: string;
  private readonly filePrefix: string;

  constructor(opts: {
    stateDir: string;
    configDir: string;
    filePrefix?: string;
    limits?: Partial<AlloyPipelineLimits>;
  }) {
    this.stateFilePath = join(opts.stateDir, STATE_FILE);
    this.configDir = opts.configDir;
    this.filePrefix = opts.filePrefix ?? "lens-";
    this.limits = {
      maxPipelines: opts.limits?.maxPipelines ?? DEFAULT_LIMITS.maxPipelines,
    };
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  /** Load state from disk. Creates empty state if file doesn't exist. */
  async load(): Promise<void> {
    try {
      const raw = await readFile(this.stateFilePath, "utf-8");
      const parsed = JSON.parse(raw) as AlloyPipelineState;
      if (parsed.version === 1 && Array.isArray(parsed.pipelines)) {
        this.state = parsed;
      }
    } catch (err) {
      // File doesn't exist yet — start with empty state
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.state = { version: 1, pipelines: [] };
        return;
      }
      throw err;
    }
  }

  /** Save current state to disk (atomic: write tmp then rename). */
  async save(): Promise<void> {
    const tmp = `${this.stateFilePath}.tmp`;
    await writeFile(tmp, JSON.stringify(this.state, null, 2), "utf-8");
    await rename(tmp, this.stateFilePath);
  }

  // ── CRUD Operations ───────────────────────────────────────────────

  /** Generate a short unique pipeline ID (8 hex chars). */
  generateId(): string {
    return randomUUID().replace(/-/g, "").slice(0, 8);
  }

  /**
   * Add a new pipeline definition.
   * Throws if the name already exists or limits are exceeded.
   */
  add(pipeline: PipelineDefinition): void {
    // Check name uniqueness
    if (this.state.pipelines.some((p) => p.name === pipeline.name)) {
      throw new Error(
        `Pipeline "${pipeline.name}" already exists. Use a different name or delete the existing one.`,
      );
    }
    // Check pipeline limit
    const active = this.state.pipelines.filter(
      (p) => p.status !== "stopped" && p.status !== "failed",
    );
    if (active.length >= this.limits.maxPipelines) {
      throw new Error(
        `Cannot create pipeline — limit of ${this.limits.maxPipelines} managed pipelines reached. Delete unused pipelines with action 'delete'.`,
      );
    }
    this.state.pipelines.push(pipeline);
  }

  /** Get a pipeline by name. Returns undefined if not found. */
  get(name: string): PipelineDefinition | undefined {
    return this.state.pipelines.find((p) => p.name === name);
  }

  /** List all pipelines, optionally filtered by status. */
  list(statusFilter?: PipelineStatus): PipelineDefinition[] {
    if (statusFilter) {
      return this.state.pipelines.filter((p) => p.status === statusFilter);
    }
    return [...this.state.pipelines];
  }

  /** Update a pipeline's fields. Returns false if not found. */
  update(
    name: string,
    updates: Partial<
      Pick<
        PipelineDefinition,
        | "params"
        | "filePath"
        | "status"
        | "componentIds"
        | "configHash"
        | "lastError"
        | "signal"
        | "boundPorts"
        | "sampleQueries"
      >
    >,
  ): boolean {
    const pipeline = this.state.pipelines.find((p) => p.name === name);
    if (!pipeline) return false;
    Object.assign(pipeline, updates, { updatedAt: Date.now() });
    return true;
  }

  /** Remove a pipeline by name. Returns false if not found. */
  remove(name: string): boolean {
    const idx = this.state.pipelines.findIndex((p) => p.name === name);
    if (idx === -1) return false;
    this.state.pipelines.splice(idx, 1);
    return true;
  }

  /** Get pipeline count and limits. */
  usage(): { count: number; max: number } {
    const active = this.state.pipelines.filter(
      (p) => p.status !== "stopped" && p.status !== "failed",
    ).length;
    return { count: active, max: this.limits.maxPipelines };
  }

  // ── Config File Helpers ───────────────────────────────────────────

  /** Generate the .alloy file path for a pipeline. */
  configFilePath(pipelineId: string, name: string): string {
    const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, "-");
    return join(this.configDir, `${this.filePrefix}${sanitized}-${pipelineId}.alloy`);
  }

  /** Compute SHA-256 hash of config content (for drift detection). */
  static configHash(content: string): string {
    return createHash("sha256").update(content).digest("hex");
  }

  // ── Port Conflict Detection ───────────────────────────────────────

  /**
   * Check if any of the given ports conflict with active pipelines.
   * Returns the first conflict found, or null if no conflicts.
   */
  checkPortConflict(ports: number[], excludePipeline?: string): { port: number; pipelineName: string } | null {
    for (const pipeline of this.state.pipelines) {
      if (pipeline.status === "stopped" || pipeline.status === "failed") continue;
      if (excludePipeline && pipeline.name === excludePipeline) continue;
      for (const port of ports) {
        if (pipeline.boundPorts?.includes(port)) {
          return { port, pipelineName: pipeline.name };
        }
      }
    }
    return null;
  }

  // ── Drift Detection ───────────────────────────────────────────────

  /**
   * Detect drift between stored state and filesystem.
   * Checks file existence and hash for all active pipelines,
   * plus scans for orphan files in the config directory.
   */
  async detectFileDrift(): Promise<DriftReport> {
    const report: DriftReport = {
      fileDrift: [],
      orphanFiles: [],
    };

    // Check all active/pending pipelines have matching files (parallel reads)
    const activePipelines = this.state.pipelines.filter(
      (p) => p.status !== "stopped" && p.status !== "failed",
    );
    const checks = await Promise.allSettled(
      activePipelines.map(async (pipeline) => {
        try {
          const content = await readFile(pipeline.filePath, "utf-8");
          const hash = PipelineStore.configHash(content);
          if (hash !== pipeline.configHash) {
            return { name: pipeline.name, issue: "Config file content changed externally (hash mismatch)" };
          }
          return null;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            return { name: pipeline.name, issue: "Config file missing from disk" };
          }
          throw err;
        }
      }),
    );
    for (const check of checks) {
      if (check.status === "fulfilled" && check.value) {
        report.fileDrift.push(check.value);
      }
    }

    // Scan for orphan files (lens-*.alloy not tracked in state)
    try {
      const files = await readdir(this.configDir);
      const managedFiles = new Set(
        this.state.pipelines.map((p) => p.filePath.split("/").pop()),
      );
      for (const file of files) {
        if (
          file.startsWith(this.filePrefix) &&
          file.endsWith(".alloy") &&
          !managedFiles.has(file)
        ) {
          report.orphanFiles.push(file);
        }
      }
    } catch {
      // Config dir doesn't exist or unreadable — not a drift issue
    }

    return report;
  }

  /**
   * Mark pipelines as drifted based on drift report.
   * Call this after detectFileDrift() to update state.
   */
  applyDriftReport(report: DriftReport): number {
    let updated = 0;
    for (const drift of report.fileDrift) {
      const pipeline = this.state.pipelines.find((p) => p.name === drift.name);
      if (pipeline && pipeline.status !== "drift") {
        pipeline.status = "drift";
        pipeline.lastError = drift.issue;
        pipeline.updatedAt = Date.now();
        updated++;
      }
    }
    return updated;
  }
}
