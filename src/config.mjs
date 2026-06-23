import path from "node:path";

export const DEFAULT_CONFIG = {
  enabled: true,
  pollIntervalMs: 60_000,
  statePath: "workspace/.openclaw/async-result-router/state.json",
  state: {
    backend: "file",
    namespace: "async-result-router",
    key: "router-state",
  },
  routeConfigPath: "workspace/ops/async-result-router/routes.json",
  routes: [],
  sources: [],
  webhook: {
    enabled: false,
    path: "/async-result-router/events",
    auth: "gateway",
    sourceId: "webhook",
    sourceType: "webhook",
    trustLevel: "semi_trusted",
  },
  self: {
    suppressGeneratedEvents: true,
    producerId: "async-result-router",
    producerIds: ["async-result-router"],
    markers: ["generated-by: async-result-router"],
    markerSourceTypes: ["notification", "notificationLog", "discord", "mobile_notification", "companion_notification"],
  },
  wake: {
    enabled: true,
    dryRun: false,
    mode: "now",
    reason: "async-result-router:event",
    maxAttempts: 5,
  },
};

export function resolvePath(input, baseDir = process.cwd()) {
  if (!input) return null;
  const value = String(input);
  return path.isAbsolute(value) ? value : path.resolve(baseDir, value);
}

function boundedInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export function resolveRouterConfig(input = {}, context = {}) {
  const baseDir = context.openclawHome || process.env.OPENCLAW_HOME || process.cwd();
  const cfg = {
    ...DEFAULT_CONFIG,
    ...input,
    wake: {
      ...DEFAULT_CONFIG.wake,
      ...(input.wake || {}),
    },
    state: {
      ...DEFAULT_CONFIG.state,
      ...(input.state || {}),
    },
  };

  const sources = Array.isArray(cfg.sources)
    ? cfg.sources
      .filter((source) => source && typeof source === "object" && source.enabled !== false)
      .map((source) => ({ ...source }))
    : [];

  return {
    enabled: cfg.enabled !== false,
    pollIntervalMs: boundedInt(cfg.pollIntervalMs, DEFAULT_CONFIG.pollIntervalMs, 1000, 24 * 60 * 60 * 1000),
    statePath: resolvePath(cfg.statePath, baseDir),
    state: {
      backend: cfg.state.backend === "runtime" ? "runtime" : "file",
      namespace: String(cfg.state.namespace || DEFAULT_CONFIG.state.namespace),
      key: String(cfg.state.key || DEFAULT_CONFIG.state.key),
    },
    routeConfigPath: resolvePath(cfg.routeConfigPath, baseDir),
    routes: Array.isArray(cfg.routes) ? cfg.routes : [],
    sources,
    webhook: {
      enabled: cfg.webhook?.enabled === true,
      path: String(cfg.webhook?.path || DEFAULT_CONFIG.webhook.path),
      auth: cfg.webhook?.auth === "plugin" ? "plugin" : "gateway",
      sourceId: String(cfg.webhook?.sourceId || DEFAULT_CONFIG.webhook.sourceId),
      sourceType: String(cfg.webhook?.sourceType || DEFAULT_CONFIG.webhook.sourceType),
      trustLevel: normalizeTrustLevel(cfg.webhook?.trustLevel, DEFAULT_CONFIG.webhook.trustLevel),
    },
    self: {
      suppressGeneratedEvents: cfg.self?.suppressGeneratedEvents !== false,
      producerId: String(cfg.self?.producerId || DEFAULT_CONFIG.self.producerId),
      producerIds: stringList(cfg.self?.producerIds, DEFAULT_CONFIG.self.producerIds),
      markers: stringList(cfg.self?.markers, DEFAULT_CONFIG.self.markers),
      markerSourceTypes: stringList(cfg.self?.markerSourceTypes, DEFAULT_CONFIG.self.markerSourceTypes),
    },
    wake: {
      enabled: cfg.wake.enabled !== false,
      dryRun: cfg.wake.dryRun === true,
      mode: cfg.wake.mode === "next-heartbeat" ? "next-heartbeat" : "now",
      reason: String(cfg.wake.reason || DEFAULT_CONFIG.wake.reason),
      maxAttempts: boundedInt(cfg.wake.maxAttempts, DEFAULT_CONFIG.wake.maxAttempts, 1, 100),
    },
    baseDir,
  };
}

function stringList(value, fallback = []) {
  const input = Array.isArray(value) ? value : value == null ? fallback : [value];
  return input.map((entry) => String(entry || "").trim()).filter(Boolean);
}

function normalizeTrustLevel(value, fallback) {
  const text = String(value || fallback || "semi_trusted");
  return ["trusted_structured", "semi_trusted", "untrusted"].includes(text)
    ? text
    : "semi_trusted";
}
