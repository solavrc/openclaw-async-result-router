import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const STATE_VERSION = 1;

const stateLocks = new Map();
const STATE_BACKUP_SUFFIX = ".bak";

export function nowIso() {
  return new Date().toISOString();
}

export function stableHash(value) {
  const text = typeof value === "string" ? value : stableStringify(value);
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 20);
}

export function stableStringify(value) {
  return JSON.stringify(sortJson(value));
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
}

export function emptyState() {
  return {
    version: STATE_VERSION,
    workItems: {},
    events: {},
    wakeRequests: {},
    deliveries: {},
    outcomes: {},
    sourceCursors: {},
    updatedAt: nowIso(),
  };
}

export function readJsonFile(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    if (err?.code === "ENOENT") return fallback;
    throw err;
  }
}

export function loadState(statePath) {
  const state = readStateFileWithRepair(statePath);
  if (!state) return emptyState();
  return {
    ...emptyState(),
    ...state,
    workItems: state.workItems || {},
    events: state.events || {},
    wakeRequests: state.wakeRequests || {},
    deliveries: state.deliveries || {},
    outcomes: state.outcomes || {},
    sourceCursors: state.sourceCursors || {},
  };
}

export function saveState(statePath, state) {
  const next = finalizeState(state);
  validateStateDocument(next);
  writeJsonAtomic(statePath, next, { backup: true });
}

export function createStateStore(config, runtime = null) {
  if (config.state?.backend !== "file" && runtime?.state?.openSyncKeyedStore) {
    const namespace = config.state?.namespace || "async-result-router";
    const key = config.state?.key || "router-state";
    try {
      const store = runtime.state.openSyncKeyedStore({
        namespace,
        maxEntries: 1,
      });
      return {
        backend: "runtime",
        key: `runtime:${namespace}:${key}`,
        load() {
          return normalizeState(store.lookup(key));
        },
        save(state) {
          store.register(key, finalizeState(state));
        },
        describe() {
          return {
            backend: "runtime",
            namespace,
            key,
          };
        },
      };
    } catch {
      // Workspace and third-party plugins can expose runtime.state but deny keyed-store access.
      // Fall through to the file backend so public plugins keep working.
    }
  }

  return {
    backend: "file",
    key: `file:${config.statePath}`,
    load() {
      return loadState(config.statePath);
    },
    save(state) {
      saveState(config.statePath, state);
    },
    describe() {
      return {
        backend: "file",
        path: config.statePath,
      };
    },
  };
}

function normalizeState(state) {
  if (!state) return emptyState();
  return {
    ...emptyState(),
    ...state,
    workItems: state.workItems || {},
    events: state.events || {},
    wakeRequests: state.wakeRequests || {},
    deliveries: state.deliveries || {},
    outcomes: state.outcomes || {},
    sourceCursors: state.sourceCursors || {},
  };
}

function finalizeState(state) {
  return { ...normalizeState(state), version: STATE_VERSION, updatedAt: nowIso() };
}

function readStateFileWithRepair(statePath) {
  try {
    return validateStateDocument(readJsonFile(statePath, null));
  } catch (err) {
    const backupPath = `${statePath}${STATE_BACKUP_SUFFIX}`;
    const backup = tryReadStateBackup(backupPath);
    quarantineInvalidState(statePath);
    if (backup) return backup;
    return emptyState();
  }
}

function tryReadStateBackup(backupPath) {
  try {
    return validateStateDocument(readJsonFile(backupPath, null));
  } catch {
    return null;
  }
}

export function validateStateDocument(state) {
  if (state == null) return null;
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new Error("state file must be a JSON object");
  }
  for (const key of ["workItems", "events", "wakeRequests", "deliveries", "outcomes", "sourceCursors"]) {
    if (state[key] != null && (typeof state[key] !== "object" || Array.isArray(state[key]))) {
      throw new Error(`state.${key} must be an object`);
    }
  }
  return state;
}

function writeJsonAtomic(filePath, value, options = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const text = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSynced(tmpPath, text);
  if (options.backup && fs.existsSync(filePath)) {
    try {
      fs.copyFileSync(filePath, `${filePath}${STATE_BACKUP_SUFFIX}`);
    } catch {
      // Backup failure should not block the primary atomic replace.
    }
  }
  fs.renameSync(tmpPath, filePath);
  fsyncDir(path.dirname(filePath));
}

function writeFileSynced(filePath, text) {
  const fd = fs.openSync(filePath, "w", 0o600);
  try {
    fs.writeFileSync(fd, text, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function fsyncDir(dirPath) {
  try {
    const fd = fs.openSync(dirPath, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Some platforms/filesystems do not permit fsync on directories.
  }
}

function quarantineInvalidState(statePath) {
  if (!fs.existsSync(statePath)) return;
  const corruptPath = `${statePath}.corrupt.${Date.now()}`;
  try {
    fs.renameSync(statePath, corruptPath);
  } catch {
    // If quarantine fails, leave the file in place and continue with repaired state.
  }
}

export async function withStateStore(config, runtime, task) {
  const stateStore = createStateStore(config, runtime);
  const previous = stateLocks.get(stateStore.key) || Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const state = stateStore.load();
    const result = await task(state, stateStore);
    stateStore.save(state);
    return result;
  });
  stateLocks.set(stateStore.key, next);
  try {
    return await next;
  } finally {
    if (stateLocks.get(stateStore.key) === next) stateLocks.delete(stateStore.key);
  }
}

export function findByIdempotency(collection, idempotencyKey) {
  return Object.values(collection).find((item) => item.idempotencyKey === idempotencyKey) || null;
}

export function normalizeEvent(raw, defaults = {}) {
  const observedAt = raw.observedAt || nowIso();
  const source = String(raw.source || defaults.source || "unknown");
  const sourceType = String(raw.sourceType || defaults.sourceType || source);
  const sourceId = String(raw.sourceId || raw.id || stableHash(raw));
  const idempotencyKey = String(raw.idempotencyKey || `${source}:${sourceId}`);
  const id = raw.eventId || (raw.id && String(raw.id).startsWith("evt_")
    ? raw.id
    : `evt_${stableHash(idempotencyKey)}`);
  const wakeTarget = normalizeWakeTarget(raw);

  return {
    id,
    workItemId: raw.workItemId || null,
    routeId: raw.routeId || null,
    type: String(raw.type || defaults.type || "external_event"),
    source,
    sourceType,
    trustLevel: raw.trustLevel || defaults.trustLevel || "semi_trusted",
    sourceId,
    idempotencyKey,
    sourceRevision: raw.sourceRevision || null,
    observedAt,
    status: raw.status || "recorded",
    summary: raw.summary || raw.title || raw.subject || raw.reason || "",
    payload: raw.payload === undefined ? raw : raw.payload,
    targetSessionKey: wakeTarget.sessionKey,
    targetAgentId: wakeTarget.agentId,
    createdAt: raw.createdAt || observedAt,
    updatedAt: raw.updatedAt || observedAt,
  };
}

function normalizeWakeTarget(raw) {
  const wakeTarget = raw.wakeTarget && typeof raw.wakeTarget === "object"
    ? raw.wakeTarget
    : null;
  const target = raw.target && typeof raw.target === "object"
    ? raw.target
    : null;
  const sessionKey = raw.targetSessionKey
    || (typeof raw.wakeTarget === "string" ? raw.wakeTarget : null)
    || wakeTarget?.sessionKey
    || target?.sessionKey
    || null;
  const agentId = raw.targetAgentId
    || wakeTarget?.agentId
    || target?.agentId
    || null;
  return {
    sessionKey: sessionKey ? String(sessionKey) : null,
    agentId: agentId ? String(agentId) : null,
  };
}

export function ensureWorkItem(state, params) {
  const at = nowIso();
  const id = params.id || `wi_${stableHash({
    routeId: params.routeId || null,
    source: params.source || null,
    sourceId: params.sourceId || null,
    kind: params.kind || "async_result",
  })}`;
  const existing = state.workItems[id];
  if (existing) {
    state.workItems[id] = {
      ...existing,
      ...params.patch,
      updatedAt: at,
    };
    return state.workItems[id];
  }
  const workItem = {
    id,
    kind: params.kind || "async_result",
    title: params.title || params.topic || id,
    status: params.status || "needs_action",
    routeId: params.routeId || null,
    owner: {
      agentId: params.ownerAgentId || "main",
      sessionKey: params.ownerSessionKey || null,
      ownerVersion: Number.isFinite(Number(params.ownerVersion)) ? Number(params.ownerVersion) : 1,
      fallbackPolicy: params.fallbackPolicy || "agent-main",
      fallbackAgentId: params.fallbackAgentId || "main",
    },
    attempts: 0,
    maxAttempts: params.maxAttempts || 5,
    lease: null,
    createdAt: at,
    updatedAt: at,
  };
  state.workItems[id] = workItem;
  return workItem;
}

export function recordEvent(state, rawEvent) {
  const event = normalizeEvent(rawEvent);
  const existing = findByIdempotency(state.events, event.idempotencyKey);
  if (existing) {
    return { event: existing, created: false };
  }
  state.events[event.id] = event;
  return { event, created: true };
}

export function enqueueWakeRequest(state, event, workItem, target, options = {}) {
  const targetAgentId = target.agentId || workItem.owner?.agentId || "main";
  const targetSessionKey = target.sessionKey || workItem.owner?.sessionKey || null;
  const ownerVersion = Number.isFinite(Number(target.ownerVersion))
    ? Number(target.ownerVersion)
    : Number.isFinite(Number(workItem.owner?.ownerVersion))
      ? Number(workItem.owner.ownerVersion)
      : 1;
  const idempotencyKey = `wake:${event.id}:${targetAgentId}:${targetSessionKey || "main"}:owner:${ownerVersion}:v1`;
  const existing = findByIdempotency(state.wakeRequests, idempotencyKey);
  if (existing) return { wakeRequest: existing, created: false };
  const at = nowIso();
  const wakeRequest = {
    id: `wake_${stableHash(idempotencyKey)}`,
    eventId: event.id,
    workItemId: workItem.id,
    targetAgentId,
    targetSessionKey,
    ownerVersion,
    idempotencyKey,
    status: options.dryRun ? "dry_run" : "pending",
    attempts: 0,
    nextAttemptAt: at,
    deliveredAt: null,
    acknowledgedAt: null,
    lastError: null,
    message: options.message || "",
    createdAt: at,
    updatedAt: at,
  };
  state.wakeRequests[wakeRequest.id] = wakeRequest;
  return { wakeRequest, created: true };
}

export function acknowledgeEvent(state, params = {}) {
  const eventId = requiredString(params.eventId, "eventId");
  const event = state.events[eventId];
  if (!event) throw new Error(`event not found: ${eventId}`);
  if (params.routeId && event.routeId && params.routeId !== event.routeId) {
    throw new Error(`event ${eventId} is not routed to ${params.routeId}`);
  }
  const wake = findWakeForAck(state, {
    wakeRequestId: params.wakeRequestId,
    eventId,
  });
  if (params.ownerVersion != null && wake?.ownerVersion != null && Number(params.ownerVersion) !== Number(wake.ownerVersion)) {
    throw new Error(`stale ownerVersion for wake ${wake.id}: expected ${wake.ownerVersion}`);
  }

  const at = nowIso();
  const ack = {
    ack: String(params.ack || "seen"),
    routeId: event.routeId || params.routeId || null,
    wakeRequestId: wake?.id || params.wakeRequestId || null,
    ownerVersion: wake?.ownerVersion || params.ownerVersion || null,
    summary: params.summary ? String(params.summary) : null,
    acknowledgedAt: at,
  };
  event.status = event.status === "processed" || event.status === "superseded"
    ? event.status
    : "acknowledged";
  event.acknowledgedAt = event.acknowledgedAt || at;
  event.ack = ack;
  event.updatedAt = at;
  if (wake) {
    wake.status = "acknowledged";
    wake.acknowledgedAt = wake.acknowledgedAt || at;
    wake.updatedAt = at;
  }
  return { event, wakeRequest: wake || null, ack };
}

export function recordEventOutcome(state, params = {}) {
  const eventId = requiredString(params.eventId, "eventId");
  const outcome = requiredString(params.outcome, "outcome");
  const event = state.events[eventId];
  if (!event) throw new Error(`event not found: ${eventId}`);
  if (params.routeId && event.routeId && params.routeId !== event.routeId) {
    throw new Error(`event ${eventId} is not routed to ${params.routeId}`);
  }
  const at = nowIso();
  const ownerVersion = params.ownerVersion != null
    ? Number(params.ownerVersion)
    : event.ack?.ownerVersion != null
      ? Number(event.ack.ownerVersion)
      : null;
  const actorRunId = params.actorRunId ? String(params.actorRunId) : "default";
  const idempotencyKey = String(params.idempotencyKey || `outcome:${eventId}:owner:${ownerVersion ?? "unknown"}:${outcome}:actor:${actorRunId}:v1`);
  const existing = findByIdempotency(state.outcomes, idempotencyKey);
  if (existing) {
    event.outcome = existing;
    event.status = isSupersededOutcome(existing.outcome) ? "superseded" : "processed";
    event.processedAt = event.processedAt || existing.createdAt || at;
    event.updatedAt = at;
    return {
      event,
      outcome: existing,
      workItem: event.workItemId ? state.workItems[event.workItemId] || null : null,
      created: false,
    };
  }
  const outcomeRecord = {
    id: `out_${stableHash(idempotencyKey)}`,
    eventId,
    routeId: event.routeId || params.routeId || null,
    workItemId: event.workItemId || null,
    idempotencyKey,
    outcome,
    summary: params.summary ? String(params.summary) : null,
    nextAction: params.nextAction ? String(params.nextAction) : null,
    actorRunId,
    ownerVersion,
    createdAt: at,
  };
  state.outcomes[outcomeRecord.id] = outcomeRecord;
  event.outcome = outcomeRecord;
  event.status = isSupersededOutcome(outcome) ? "superseded" : "processed";
  event.processedAt = event.processedAt || at;
  event.updatedAt = at;
  if (event.workItemId && state.workItems[event.workItemId]) {
    state.workItems[event.workItemId] = {
      ...state.workItems[event.workItemId],
      ...(params.nextWorkItemStatus ? { status: String(params.nextWorkItemStatus) } : {}),
      updatedAt: at,
    };
  }
  return {
    event,
    outcome: outcomeRecord,
    workItem: event.workItemId ? state.workItems[event.workItemId] || null : null,
    created: true,
  };
}

function findWakeForAck(state, params) {
  if (params.wakeRequestId) {
    const wake = state.wakeRequests[params.wakeRequestId];
    if (!wake) throw new Error(`wake request not found: ${params.wakeRequestId}`);
    if (wake.eventId !== params.eventId) {
      throw new Error(`wake request ${params.wakeRequestId} is not for event ${params.eventId}`);
    }
    return wake;
  }
  return Object.values(state.wakeRequests).find((wake) => wake.eventId === params.eventId) || null;
}

function requiredString(value, name) {
  const result = String(value || "").trim();
  if (!result) throw new Error(`${name} is required`);
  return result;
}

function isSupersededOutcome(outcome) {
  return ["ignored_stale", "superseded", "duplicate", "cancelled"].includes(outcome);
}
