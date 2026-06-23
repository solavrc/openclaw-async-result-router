import { closeStoredRoute, isExpiredRoute, listAllRoutes, upsertStoredRoute } from "./route-store.mjs";
import { acknowledgeEvent, createStateStore, recordEventOutcome, withStateStore } from "./store.mjs";

const RegisterRouteSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string" },
    topic: { type: "string" },
    kind: { type: "string" },
    sourceTypes: {
      type: "array",
      items: { type: "string" },
    },
    match: {
      type: "object",
      additionalProperties: true,
    },
    sessionKey: { type: "string" },
    agentId: { type: "string" },
    ownerVersion: { type: "number" },
    fallbackPolicy: { type: "string" },
    owner: {
      type: "object",
      additionalProperties: true,
    },
    wakeSession: { type: "boolean" },
    replace: { type: "boolean" },
    expiresAt: { type: "string" },
    workItemId: { type: "string" },
    route: {
      type: "object",
      additionalProperties: true,
    },
  },
};

const ListRoutesSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    includeClosed: { type: "boolean" },
    sessionKey: { type: "string" },
    sourceType: { type: "string" },
  },
};

const CloseRouteSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: {
    id: { type: "string" },
    status: {
      type: "string",
      enum: ["closed", "cancelled"],
    },
    reason: { type: "string" },
  },
};

const AckEventSchema = {
  type: "object",
  additionalProperties: false,
  required: ["eventId"],
  properties: {
    eventId: { type: "string" },
    wakeRequestId: { type: "string" },
    routeId: { type: "string" },
    ownerVersion: { type: "number" },
    ack: { type: "string" },
    summary: { type: "string" },
  },
};

const RecordOutcomeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["eventId", "outcome"],
  properties: {
    eventId: { type: "string" },
    routeId: { type: "string" },
    ownerVersion: { type: "number" },
    actorRunId: { type: "string" },
    idempotencyKey: { type: "string" },
    outcome: { type: "string" },
    summary: { type: "string" },
    nextAction: { type: "string" },
    nextWorkItemStatus: { type: "string" },
  },
};

const InspectStateSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string" },
    routeId: { type: "string" },
    eventId: { type: "string" },
    limit: { type: "number" },
  },
};

export function createAsyncResultRouterTools({ config, runtime = null, context = {}, logger = console } = {}) {
  return [
    createRegisterRouteTool({ config, context, logger }),
    createListRoutesTool({ config }),
    createCloseRouteTool({ config }),
    createAckEventTool({ config, runtime }),
    createRecordOutcomeTool({ config, runtime }),
    createInspectStateTool({ config, runtime }),
  ];
}

function createRegisterRouteTool({ config, context, logger }) {
  return {
    name: "async_result_router_register_route",
    label: "Register Async Route",
    description: [
      "Register a durable async result route for work whose result will arrive later.",
      "Use this after starting a PR, CI/review watch, webhook wait, email follow-up, or companion notification wait.",
      "If sessionKey is omitted, the current session is used so future matching events wake this same session.",
    ].join(" "),
    parameters: RegisterRouteSchema,
    execute: async (_toolCallId, rawParams = {}) => {
      const params = rawParams && typeof rawParams === "object" ? rawParams : {};
      const route = buildRouteFromParams(params);
      const result = upsertStoredRoute(config, route, {
        replace: params.replace !== false,
        context: {
          agentId: params.agentId || context.agentId,
          sessionKey: params.sessionKey || context.sessionKey,
        },
      });
      logger?.info?.(`[async-result-router] route ${result.created ? "registered" : "updated"} id=${result.route.id}`);
      return {
        content: [{
          type: "text",
          text: [
            `${result.created ? "Registered" : "Updated"} async result route: ${result.route.id}`,
            `Topic: ${result.route.topic}`,
            `Session: ${result.route.session?.sessionKey || "(none)"}`,
            `Route config: ${result.routeConfigPath}`,
          ].join("\n"),
        }],
        details: result,
      };
    },
  };
}

function createListRoutesTool({ config }) {
  return {
    name: "async_result_router_list_routes",
    label: "List Async Routes",
    description: "List async result routes, including route ownership and matching hints.",
    parameters: ListRoutesSchema,
    execute: async (_toolCallId, rawParams = {}) => {
      const params = rawParams && typeof rawParams === "object" ? rawParams : {};
      const routes = listAllRoutes(config, { includeClosed: params.includeClosed === true })
        .filter((route) => !params.sessionKey || route.session?.sessionKey === params.sessionKey)
        .filter((route) => !params.sourceType || route.sourceTypes?.includes(params.sourceType));
      return {
        content: [{
          type: "text",
          text: routes.length
            ? routes.map((route) => renderRouteLine(route)).join("\n")
            : "No async result routes matched.",
        }],
        details: {
          routes,
          count: routes.length,
        },
      };
    },
  };
}

function createCloseRouteTool({ config }) {
  return {
    name: "async_result_router_close_route",
    label: "Close Async Route",
    description: "Close or cancel a stored async result route when the async work no longer needs to wake a session.",
    parameters: CloseRouteSchema,
    execute: async (_toolCallId, rawParams = {}) => {
      const params = rawParams && typeof rawParams === "object" ? rawParams : {};
      const result = closeStoredRoute(config, params);
      return {
        content: [{
          type: "text",
          text: `${result.route.status === "cancelled" ? "Cancelled" : "Closed"} async result route: ${result.route.id}`,
        }],
        details: result,
      };
    },
  };
}

function createAckEventTool({ config, runtime }) {
  return {
    name: "async_result_router_ack_event",
    label: "Ack Async Event",
    description: [
      "Acknowledge that the owning session has seen an async routed event.",
      "Use this before acting on the event so wake delivery and event handling are tracked separately.",
    ].join(" "),
    parameters: AckEventSchema,
    execute: async (_toolCallId, rawParams = {}) => {
      const params = rawParams && typeof rawParams === "object" ? rawParams : {};
      const result = await withStateStore(config, runtime, async (state) => acknowledgeEvent(state, params));
      return {
        content: [{
          type: "text",
          text: `Acknowledged async event: ${result.event.id}`,
        }],
        details: result,
      };
    },
  };
}

function createRecordOutcomeTool({ config, runtime }) {
  return {
    name: "async_result_router_record_outcome",
    label: "Record Async Outcome",
    description: [
      "Record what the owning session did after reading an async routed event.",
      "Use outcomes such as repair_started, followup_scheduled, human_approval_requested, completed, blocked, ignored_stale, or superseded.",
      "Pass actorRunId or idempotencyKey when retrying the same owner action across compaction or re-entry.",
    ].join(" "),
    parameters: RecordOutcomeSchema,
    execute: async (_toolCallId, rawParams = {}) => {
      const params = rawParams && typeof rawParams === "object" ? rawParams : {};
      const result = await withStateStore(config, runtime, async (state) => recordEventOutcome(state, params));
      return {
        content: [{
          type: "text",
          text: `Recorded async event outcome: ${result.event.id} -> ${result.outcome.outcome}`,
        }],
        details: result,
      };
    },
  };
}

function createInspectStateTool({ config, runtime }) {
  return {
    name: "async_result_router_inspect_state",
    label: "Inspect Async Router State",
    description: [
      "Inspect routed async events, ambiguous events, pending wakes, dead letters, and recorded outcomes.",
      "Use this when recovering or auditing async handoffs before deciding the next action.",
    ].join(" "),
    parameters: InspectStateSchema,
    execute: async (_toolCallId, rawParams = {}) => {
      const params = rawParams && typeof rawParams === "object" ? rawParams : {};
      const stateStore = createStateStore(config, runtime);
      const state = stateStore.load();
      const inspection = inspectState(state, params);
      return {
        content: [{
          type: "text",
          text: renderInspection(inspection),
        }],
        details: {
          ...inspection,
          state: stateStore.describe(),
        },
      };
    },
  };
}

function buildRouteFromParams(params) {
  const route = {
    ...(params.route && typeof params.route === "object" ? params.route : {}),
  };
  copyParam(params, route, "id");
  copyParam(params, route, "topic");
  copyParam(params, route, "kind");
  copyParam(params, route, "sourceTypes");
  copyParam(params, route, "match");
  copyParam(params, route, "expiresAt");
  copyParam(params, route, "workItemId");
  copyParam(params, route, "owner");
  copyParam(params, route, "ownerVersion");
  copyParam(params, route, "fallbackPolicy");
  if (params.sessionKey || params.agentId) {
    route.session = {
      ...(route.session && typeof route.session === "object" ? route.session : {}),
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      ...(params.agentId ? { agentId: params.agentId } : {}),
    };
  }
  if (params.wakeSession != null) {
    route.actions = {
      ...(route.actions && typeof route.actions === "object" ? route.actions : {}),
      wakeSession: params.wakeSession !== false,
    };
  }
  return route;
}

function copyParam(from, to, key) {
  if (from[key] !== undefined) to[key] = from[key];
}

function renderRouteLine(route) {
  const status = `${route.status || "active"}${isExpiredRoute(route) ? "/expired" : ""}`;
  const sourceTypes = Array.isArray(route.sourceTypes) ? route.sourceTypes.join(",") : "";
  const owner = route.owner || route.session || {};
  const sessionKey = owner.sessionKey || "";
  const ownerVersion = owner.ownerVersion || 1;
  return `- ${route.id} [${status}] ${route.topic || ""} source=${sourceTypes || "*"} session=${sessionKey || "(none)"} ownerVersion=${ownerVersion} origin=${route.source || "unknown"}`;
}

export function inspectState(state, params = {}) {
  const limit = Math.max(1, Math.min(200, Number.isFinite(Number(params.limit)) ? Number(params.limit) : 50));
  const routeId = params.routeId ? String(params.routeId) : null;
  const eventId = params.eventId ? String(params.eventId) : null;
  const status = params.status ? String(params.status) : null;

  const events = Object.values(state.events || {})
    .filter((event) => !eventId || event.id === eventId)
    .filter((event) => !routeId || event.routeId === routeId)
    .filter((event) => !status || event.status === status)
    .sort(sortByUpdated)
    .slice(0, limit)
    .map(renderEventSummary);

  const wakeRequests = Object.values(state.wakeRequests || {})
    .filter((wake) => !eventId || wake.eventId === eventId)
    .filter((wake) => !status || wake.status === status)
    .sort(sortByUpdated)
    .slice(0, limit)
    .map(renderWakeSummary);

  const outcomes = Object.values(state.outcomes || {})
    .filter((outcome) => !eventId || outcome.eventId === eventId)
    .filter((outcome) => !routeId || outcome.routeId === routeId)
    .sort(sortByCreated)
    .slice(0, limit)
    .map(renderOutcomeSummary);

  return {
    counts: {
      workItems: Object.keys(state.workItems || {}).length,
      events: Object.keys(state.events || {}).length,
      wakeRequests: Object.keys(state.wakeRequests || {}).length,
      outcomes: Object.keys(state.outcomes || {}).length,
      pendingWakeRequests: Object.values(state.wakeRequests || {}).filter((wake) => wake.status === "pending").length,
      ambiguousEvents: Object.values(state.events || {}).filter((event) => event.status === "ambiguous").length,
      deadLetters: Object.values(state.wakeRequests || {}).filter((wake) => wake.status === "dead_letter").length,
    },
    events,
    wakeRequests,
    outcomes,
  };
}

function renderInspection(inspection) {
  const lines = [
    `Events: ${inspection.counts.events}`,
    `Wake requests: ${inspection.counts.wakeRequests}`,
    `Pending wakes: ${inspection.counts.pendingWakeRequests}`,
    `Ambiguous events: ${inspection.counts.ambiguousEvents}`,
    `Dead letters: ${inspection.counts.deadLetters}`,
    `Outcomes: ${inspection.counts.outcomes}`,
  ];
  if (inspection.events.length) {
    lines.push("", "Recent events:");
    lines.push(...inspection.events.map((event) => `- ${event.id} [${event.status}] route=${event.routeId || "(none)"} type=${event.type}`));
  }
  if (inspection.wakeRequests.length) {
    lines.push("", "Recent wake requests:");
    lines.push(...inspection.wakeRequests.map((wake) => `- ${wake.id} [${wake.status}] event=${wake.eventId} session=${wake.targetSessionKey || "(none)"}`));
  }
  if (inspection.outcomes.length) {
    lines.push("", "Recent outcomes:");
    lines.push(...inspection.outcomes.map((outcome) => `- ${outcome.id} event=${outcome.eventId} outcome=${outcome.outcome}`));
  }
  return lines.join("\n");
}

function renderEventSummary(event) {
  return {
    id: event.id,
    status: event.status || "recorded",
    routeId: event.routeId || null,
    type: event.type || null,
    source: event.source || null,
    sourceType: event.sourceType || null,
    trustLevel: event.trustLevel || "semi_trusted",
    summary: event.summary || "",
    acknowledgedAt: event.acknowledgedAt || null,
    processedAt: event.processedAt || null,
    updatedAt: event.updatedAt || event.createdAt || event.observedAt || null,
    match: event.match || null,
  };
}

function renderWakeSummary(wake) {
  return {
    id: wake.id,
    status: wake.status || "pending",
    eventId: wake.eventId,
    workItemId: wake.workItemId || null,
    targetAgentId: wake.targetAgentId || null,
    targetSessionKey: wake.targetSessionKey || null,
    ownerVersion: wake.ownerVersion || null,
    attempts: wake.attempts || 0,
    deliveredAt: wake.deliveredAt || null,
    acknowledgedAt: wake.acknowledgedAt || null,
    lastError: wake.lastError || null,
    updatedAt: wake.updatedAt || wake.createdAt || null,
  };
}

function renderOutcomeSummary(outcome) {
  return {
    id: outcome.id,
    eventId: outcome.eventId,
    routeId: outcome.routeId || null,
    outcome: outcome.outcome,
    summary: outcome.summary || null,
    nextAction: outcome.nextAction || null,
    createdAt: outcome.createdAt || null,
  };
}

function sortByUpdated(a, b) {
  return Date.parse(b.updatedAt || b.createdAt || b.observedAt || 0) - Date.parse(a.updatedAt || a.createdAt || a.observedAt || 0);
}

function sortByCreated(a, b) {
  return Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0);
}
