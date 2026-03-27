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

// ── SDK hook resolution (dynamic import fallback) ─────────────────

export type DiagnosticHooks = {
  onDiagnosticEvent: ((listener: (evt: unknown) => void) => () => void) | null;
  registerLogTransport: ((transport: (logObj: unknown) => void) => () => void) | null;
};

/**
 * Resolve SDK diagnostic hooks from whichever subpath is available.
 * Tries `plugin-sdk/diagnostics-otel` first (openclaw >= 2026.3.16),
 * then falls back to `plugin-sdk` root (older openclaw).
 *
 * Returns null for any hook that can't be resolved — caller should
 * degrade gracefully with explicit logging.
 */
export async function resolveDiagnosticHooks(): Promise<DiagnosticHooks> {
  const hooks: DiagnosticHooks = { onDiagnosticEvent: null, registerLogTransport: null };
  const paths = ["openclaw/plugin-sdk/diagnostics-otel", "openclaw/plugin-sdk"];
  for (const p of paths) {
    try {
      const m: Record<string, unknown> = await import(p);
      if (typeof m.onDiagnosticEvent === "function") {
        hooks.onDiagnosticEvent ??= m.onDiagnosticEvent as DiagnosticHooks["onDiagnosticEvent"];
      }
      if (typeof m.registerLogTransport === "function") {
        hooks.registerLogTransport ??= m.registerLogTransport as DiagnosticHooks["registerLogTransport"];
      }
    } catch { /* subpath doesn't exist in this openclaw version */ }
    if (hooks.onDiagnosticEvent && hooks.registerLogTransport) break;
  }
  return hooks;
}
