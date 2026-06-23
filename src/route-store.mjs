import fs from "node:fs";
import path from "node:path";
import { nowIso, readJsonFile, stableHash } from "./store.mjs";

export const ROUTE_DOCUMENT_VERSION = 1;

export function emptyRouteDocument() {
  return {
    version: ROUTE_DOCUMENT_VERSION,
    routes: [],
    updatedAt: nowIso(),
  };
}

export function loadRouteDocument(routeConfigPath) {
  const doc = readJsonFile(routeConfigPath, null);
  if (!doc) return emptyRouteDocument();
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error(`route config must be an object: ${routeConfigPath}`);
  }
  return {
    ...doc,
    version: doc.version || ROUTE_DOCUMENT_VERSION,
    routes: Array.isArray(doc.routes) ? doc.routes : [],
  };
}

export function saveRouteDocument(routeConfigPath, doc) {
  fs.mkdirSync(path.dirname(routeConfigPath), { recursive: true });
  const next = {
    ...doc,
    version: ROUTE_DOCUMENT_VERSION,
    routes: Array.isArray(doc.routes) ? doc.routes : [],
    updatedAt: nowIso(),
  };
  const tmpPath = `${routeConfigPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmpPath, routeConfigPath);
  return next;
}

export function listStoredRoutes(config, options = {}) {
  const doc = loadRouteDocument(config.routeConfigPath);
  const includeClosed = options.includeClosed === true;
  return doc.routes
    .filter((route) => includeClosed || !isTerminalRouteStatus(route?.status))
    .map((route) => ({ ...route, source: "stored" }));
}

export function listAllRoutes(config, options = {}) {
  const includeClosed = options.includeClosed === true;
  const inlineRoutes = Array.isArray(config.routes) ? config.routes : [];
  const storedRoutes = config.routeConfigPath ? listStoredRoutes(config, { includeClosed: true }) : [];
  return [
    ...inlineRoutes.map((route) => ({ ...route, source: "config" })),
    ...storedRoutes,
  ].filter((route) => includeClosed || !isTerminalRouteStatus(route?.status));
}

export function isRoutableRoute(route, nowMs = Date.now()) {
  if (!route || typeof route !== "object") return false;
  const status = route.status || "active";
  if (status !== "active") return false;
  if (isExpiredRoute(route, nowMs)) return false;
  return true;
}

export function isExpiredRoute(route, nowMs = Date.now()) {
  if (!route?.expiresAt) return false;
  const expiresAt = Date.parse(route.expiresAt);
  if (!Number.isFinite(expiresAt)) return false;
  return expiresAt <= nowMs;
}

export function upsertStoredRoute(config, rawRoute, options = {}) {
  if (!config.routeConfigPath) throw new Error("routeConfigPath is required");
  const doc = loadRouteDocument(config.routeConfigPath);
  const route = normalizeRoute(rawRoute, options.context || {});
  validateRoute(route);
  const index = doc.routes.findIndex((entry) => entry?.id === route.id);
  const now = nowIso();
  let created = false;

  if (index === -1) {
    created = true;
    doc.routes.push({
      ...route,
      createdAt: route.createdAt || now,
      updatedAt: now,
    });
  } else {
    const existing = doc.routes[index];
    if (options.replace === false) {
      throw new Error(`route already exists: ${route.id}`);
    }
    doc.routes[index] = {
      ...existing,
      ...route,
      createdAt: existing.createdAt || route.createdAt || now,
      updatedAt: now,
    };
  }

  const saved = saveRouteDocument(config.routeConfigPath, doc);
  const savedRoute = saved.routes.find((entry) => entry?.id === route.id);
  return {
    route: savedRoute,
    created,
    routeConfigPath: config.routeConfigPath,
  };
}

export function closeStoredRoute(config, params = {}) {
  if (!config.routeConfigPath) throw new Error("routeConfigPath is required");
  const id = stringParam(params.id, "id");
  const status = normalizeClosedStatus(params.status);
  const doc = loadRouteDocument(config.routeConfigPath);
  const index = doc.routes.findIndex((entry) => entry?.id === id);
  if (index === -1) throw new Error(`stored route not found: ${id}`);
  const now = nowIso();
  const existing = doc.routes[index];
  doc.routes[index] = {
    ...existing,
    status,
    closedAt: status === "closed" ? existing.closedAt || now : existing.closedAt,
    cancelledAt: status === "cancelled" ? existing.cancelledAt || now : existing.cancelledAt,
    closeReason: params.reason ? String(params.reason) : existing.closeReason || null,
    updatedAt: now,
  };
  const saved = saveRouteDocument(config.routeConfigPath, doc);
  return {
    route: saved.routes[index],
    routeConfigPath: config.routeConfigPath,
  };
}

export function normalizeRoute(rawRoute, context = {}) {
  if (!rawRoute || typeof rawRoute !== "object" || Array.isArray(rawRoute)) {
    throw new Error("route must be an object");
  }
  const route = { ...rawRoute };
  const session = route.session && typeof route.session === "object" ? { ...route.session } : {};
  const owner = route.owner && typeof route.owner === "object" && !Array.isArray(route.owner)
    ? { ...route.owner }
    : {};
  if (route.sessionKey && !session.sessionKey) session.sessionKey = String(route.sessionKey);
  if (route.agentId && !session.agentId) session.agentId = String(route.agentId);
  if (!session.sessionKey && context.sessionKey) session.sessionKey = String(context.sessionKey);
  if (!session.agentId && context.agentId) session.agentId = String(context.agentId);
  if (route.ownerVersion != null && owner.ownerVersion == null) owner.ownerVersion = route.ownerVersion;
  if (route.fallbackPolicy != null && owner.fallbackPolicy == null) owner.fallbackPolicy = route.fallbackPolicy;
  delete route.sessionKey;
  delete route.agentId;
  delete route.ownerVersion;
  delete route.fallbackPolicy;

  if (!owner.agentId && session.agentId) owner.agentId = session.agentId;
  if (!owner.sessionKey && session.sessionKey) owner.sessionKey = session.sessionKey;
  if (!owner.fallbackAgentId && session.fallbackAgentId) owner.fallbackAgentId = session.fallbackAgentId;
  if (!owner.sessionKey && context.sessionKey) owner.sessionKey = String(context.sessionKey);
  if (!owner.agentId && context.agentId) owner.agentId = String(context.agentId);
  owner.ownerVersion = Number.isFinite(Number(owner.ownerVersion)) ? Number(owner.ownerVersion) : 1;
  owner.fallbackPolicy = owner.fallbackPolicy ? String(owner.fallbackPolicy) : "agent-main";

  if (owner.sessionKey || owner.agentId || owner.fallbackAgentId) {
    route.owner = {
      ...(owner.agentId ? { agentId: String(owner.agentId) } : {}),
      ...(owner.sessionKey ? { sessionKey: String(owner.sessionKey) } : {}),
      ...(owner.fallbackAgentId ? { fallbackAgentId: String(owner.fallbackAgentId) } : {}),
      ownerVersion: owner.ownerVersion,
      fallbackPolicy: owner.fallbackPolicy,
    };
    route.session = {
      ...(route.owner.agentId ? { agentId: route.owner.agentId } : {}),
      ...(route.owner.sessionKey ? { sessionKey: route.owner.sessionKey } : {}),
      ...(route.owner.fallbackAgentId ? { fallbackAgentId: route.owner.fallbackAgentId } : {}),
    };
  }

  if (route.sourceType && !route.sourceTypes) route.sourceTypes = [route.sourceType];
  delete route.sourceType;
  if (route.sourceTypes != null) route.sourceTypes = stringArray(route.sourceTypes, "sourceTypes");

  const match = route.match && typeof route.match === "object" && !Array.isArray(route.match)
    ? { ...route.match }
    : {};
  moveShortcut(route, match, "repo");
  moveShortcut(route, match, "senderContains");
  moveShortcut(route, match, "subjectOrBodyContains");
  moveShortcut(route, match, "bodyContains");
  moveShortcut(route, match, "urlContains");
  moveShortcut(route, match, "appContains");
  moveShortcut(route, match, "packageContains");
  moveShortcut(route, match, "prNumber");
  moveShortcut(route, match, "sessionKey");
  route.match = match;

  route.actions = {
    ...(route.actions && typeof route.actions === "object" ? route.actions : {}),
  };
  if (route.wakeSession != null) {
    route.actions.wakeSession = route.wakeSession !== false;
    delete route.wakeSession;
  }
  if (route.actions.wakeSession == null) route.actions.wakeSession = true;

  route.status = normalizeRouteStatus(route.status);
  route.kind = route.kind ? String(route.kind) : "async_route";
  route.topic = route.topic ? String(route.topic) : route.title ? String(route.title) : null;
  delete route.title;
  if (route.expiresAt != null) route.expiresAt = String(route.expiresAt);
  if (!route.id) route.id = generatedRouteId(route);
  route.id = String(route.id);

  if (context.agentId || context.sessionKey) {
    route.createdBy = {
      ...(route.createdBy && typeof route.createdBy === "object" ? route.createdBy : {}),
      ...(context.agentId ? { agentId: String(context.agentId) } : {}),
      ...(context.sessionKey ? { sessionKey: String(context.sessionKey) } : {}),
    };
  }
  return route;
}

export function validateRoute(route) {
  if (!route.id) throw new Error("route.id is required");
  if (!route.topic) throw new Error("route.topic is required");
  if (!route.owner?.sessionKey && !route.session?.sessionKey && route.actions?.wakeSession === true) {
    throw new Error("route.owner.sessionKey is required when wakeSession is true");
  }
  if (route.expiresAt && !Number.isFinite(Date.parse(route.expiresAt))) {
    throw new Error("route.expiresAt must be an ISO-compatible date string");
  }
  const hasDirectRouteId = Boolean(route.id);
  const hasSourceTypes = Array.isArray(route.sourceTypes) && route.sourceTypes.length > 0;
  const hasMatch = route.match && Object.keys(route.match).length > 0;
  if (!hasDirectRouteId && !hasSourceTypes && !hasMatch) {
    throw new Error("route needs sourceTypes, match conditions, or a direct routeId event contract");
  }
  return true;
}

function generatedRouteId(route) {
  const base = stableHash({
    topic: route.topic || null,
    sourceTypes: route.sourceTypes || [],
    match: route.match || {},
    sessionKey: route.owner?.sessionKey || route.session?.sessionKey || null,
  });
  return `route_${base}`;
}

function moveShortcut(route, match, key) {
  if (route[key] == null || match[key] != null) return;
  match[key] = route[key];
  delete route[key];
}

function normalizeRouteStatus(value) {
  const status = String(value || "active");
  if (["active", "paused", "closed", "cancelled"].includes(status)) return status;
  throw new Error(`unsupported route status: ${status}`);
}

function normalizeClosedStatus(value) {
  const status = String(value || "closed");
  if (status === "closed" || status === "cancelled") return status;
  throw new Error(`close status must be closed or cancelled: ${status}`);
}

function isTerminalRouteStatus(status) {
  return status === "closed" || status === "cancelled";
}

function stringArray(value, name) {
  const values = Array.isArray(value) ? value : [value];
  const result = values.map((entry) => String(entry || "").trim()).filter(Boolean);
  if (result.length === 0) throw new Error(`${name} must contain at least one value`);
  return result;
}

function stringParam(value, name) {
  const result = String(value || "").trim();
  if (!result) throw new Error(`${name} is required`);
  return result;
}
