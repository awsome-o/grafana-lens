/**
 * SDK compatibility layer — vendored utilities + resilient import resolution.
 *
 * Pure utility functions (jsonResult, readStringParam, readNumberParam) were
 * removed from the root `openclaw/plugin-sdk` in OpenClaw 2026.3.16
 * (commit f2bd76cd1a "finalize plugin sdk legacy boundary cleanup").
 * These are vendored locally (ponyfill pattern) — zero SDK dependency.
 *
 * SDK hooks (onDiagnosticEvent, registerLogTransport) can't be vendored since
 * they connect to openclaw's internal event bus. These are resolved via dynamic
 * import fallback chains — tries new subpaths first, falls back to root.
 *
 * All SDK coupling lives in this one file. Future breakage = one-file fix.
 */

// ── camelCase → snake_case key resolution ──────────────────────────

function toSnakeCaseKey(key: string): string {
  return key
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

function readParamRaw(params: Record<string, unknown>, key: string): unknown {
  if (Object.hasOwn(params, key)) return params[key];
  const snakeKey = toSnakeCaseKey(key);
  if (snakeKey !== key && Object.hasOwn(params, snakeKey)) return params[snakeKey];
  return undefined;
}

// ── ToolInputError ────────────────────────────────────────────────

class ToolInputError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

// ── Parameter readers ──────────────────────────────────────────────

type StringParamOptions = {
  required?: boolean;
  trim?: boolean;
  label?: string;
  allowEmpty?: boolean;
};

export function readStringParam(
  params: Record<string, unknown>,
  key: string,
  options: StringParamOptions & { required: true },
): string;
export function readStringParam(
  params: Record<string, unknown>,
  key: string,
  options?: StringParamOptions,
): string | undefined;
export function readStringParam(
  params: Record<string, unknown>,
  key: string,
  options: StringParamOptions = {},
): string | undefined {
  const { required = false, trim = true, label = key, allowEmpty = false } = options;
  const raw = readParamRaw(params, key);
  if (typeof raw !== "string") {
    if (required) throw new ToolInputError(`${label} required`);
    return undefined;
  }
  const value = trim ? raw.trim() : raw;
  if (!value && !allowEmpty) {
    if (required) throw new ToolInputError(`${label} required`);
    return undefined;
  }
  return value;
}

export function readNumberParam(
  params: Record<string, unknown>,
  key: string,
  options: { required?: boolean; label?: string; integer?: boolean; strict?: boolean } = {},
): number | undefined {
  const { required = false, label = key, integer = false, strict = false } = options;
  const raw = readParamRaw(params, key);
  let value: number | undefined;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    value = raw;
  } else if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed) {
      const parsed = strict ? Number(trimmed) : Number.parseFloat(trimmed);
      if (Number.isFinite(parsed)) value = parsed;
    }
  }
  if (value === undefined) {
    if (required) throw new ToolInputError(`${label} required`);
    return undefined;
  }
  return integer ? Math.trunc(value) : value;
}

// ── Result formatter ──────────────────────────────────────────────

export function jsonResult(payload: unknown): {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

// ── Error formatting ──────────────────────────────────────────────

export function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Process-global singleton helper ───────────────────────────────

/**
 * Resolve or create a process-wide singleton keyed by a symbol on globalThis.
 *
 * Mirrors `resolveGlobalSingleton` from `openclaw/plugin-sdk/global-singleton`
 * (the canonical SDK helper). We vendor it because openclaw 2026.4.25 declares
 * the subpath in `package.json` exports but doesn't ship `dist/.../global-singleton.js`,
 * so a direct import would crash at runtime. When upstream fixes the packaging,
 * this helper can be swapped for `import { resolveGlobalSingleton } from "openclaw/plugin-sdk/global-singleton"`.
 */
export function resolveGlobalSingleton<T>(key: symbol, create: () => T): T {
  const store = globalThis as Record<PropertyKey, unknown>;
  if (Object.prototype.hasOwnProperty.call(store, key)) {
    return store[key] as T;
  }
  const created = create();
  store[key] = created;
  return created;
}

/**
 * Test-only: drop a singleton entry created by `resolveGlobalSingleton`.
 * Production code must not call this — it bypasses the re-register protection
 * the singleton exists to provide.
 */
export function clearGlobalSingletonForTests(key: symbol): void {
  const store = globalThis as Record<PropertyKey, unknown>;
  delete store[key];
}

// ── SDK hook resolution (dynamic import fallback) ─────────────────

export type DiagnosticHooks = {
  onDiagnosticEvent: ((listener: (evt: unknown) => void) => () => void) | null;
  /**
   * App-log forwarding hook. Permanently removed from openclaw's public SDK
   * at v2026.5.5+ (openclaw's own logger-transport.test asserts it's undefined
   * on every plugin-sdk export site). Will be `null` on 2026.5.5+; callers
   * must degrade gracefully — that's the documented new normal, not a compat
   * regression.
   */
  registerLogTransport: ((transport: (logObj: unknown) => void) => () => void) | null;
};

/**
 * Resolve SDK diagnostic hooks from whichever subpath is available.
 *
 * Order matters:
 *   1. `plugin-sdk/diagnostic-runtime` — canonical scoped subpath (openclaw >= 2026.5.0).
 *      This is the explicit migration target named in `plugin-sdk/compat`'s
 *      deprecation warning. Present in every 2026.5.x release.
 *   2. `plugin-sdk` root — re-exports `onDiagnosticEvent` for older openclaw versions.
 *      May or may not work on 2026.5.5+ depending on dist bundling.
 *
 * `plugin-sdk/diagnostics-otel` was tried previously but never shipped in any
 * release we support (git-verified at v2026.5.5). Removed.
 *
 * `plugin-sdk/compat` is omitted: it works but emits a process.emitWarning on
 * import. We have a non-deprecated canonical path; no need to noise the logs.
 *
 * Set `GRAFANA_LENS_DEBUG_SDK=1` to surface import failures — silent catch was
 * what made Issue #9 hard to diagnose.
 */
export async function resolveDiagnosticHooks(): Promise<DiagnosticHooks> {
  const hooks: DiagnosticHooks = { onDiagnosticEvent: null, registerLogTransport: null };
  const paths = [
    "openclaw/plugin-sdk/diagnostic-runtime",
    "openclaw/plugin-sdk",
  ];
  for (const p of paths) {
    try {
      const m: Record<string, unknown> = await import(p);
      if (typeof m.onDiagnosticEvent === "function") {
        hooks.onDiagnosticEvent ??= m.onDiagnosticEvent as DiagnosticHooks["onDiagnosticEvent"];
      }
      if (typeof m.registerLogTransport === "function") {
        hooks.registerLogTransport ??= m.registerLogTransport as DiagnosticHooks["registerLogTransport"];
      }
    } catch (err) {
      if (process.env.GRAFANA_LENS_DEBUG_SDK) {
        // eslint-disable-next-line no-console
        console.warn(`[grafana-lens] sdk-compat: import("${p}") failed:`, err);
      }
    }
    if (hooks.onDiagnosticEvent && hooks.registerLogTransport) break;
  }
  return hooks;
}
