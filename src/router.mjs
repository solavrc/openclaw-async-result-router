import { collectSourceEvents } from "./sources.mjs";
import { ensureWorkItem, enqueueWakeRequest, recordEvent, withStateStore } from "./store.mjs";
import { loadRoutes, matchRoute, routeToWorkItemParams, shouldWake } from "./routes.mjs";
import { renderWakeMessage, dispatchPendingWakeRequests } from "./wake.mjs";

export async function pollOnce({ config, runtime = null, logger = console }) {
  const observed = [];

  for (const source of config.sources) {
    const events = await collectSourceEvents(source, config, logger);
    observed.push(...events);
  }

  return withStateStore(config, runtime, async (state, stateStore) => {
    const routes = loadRoutes(config);
    const processed = await processEvents({ config, state, routes, events: observed, runtime, logger });
    return {
      state: stateStore.describe(),
      statePath: config.statePath,
      observedCount: observed.length,
      routeCount: routes.length,
      ...processed,
    };
  });
}

export async function ingestEvents({ config, events, runtime = null, logger = console }) {
  return withStateStore(config, runtime, async (state, stateStore) => {
    const routes = loadRoutes(config);
    const processed = await processEvents({ config, state, routes, events, runtime, logger });
    return {
      state: stateStore.describe(),
      statePath: config.statePath,
      observedCount: events.length,
      routeCount: routes.length,
      ...processed,
    };
  });
}

async function processEvents({ config, state, routes, events, runtime, logger }) {
  const recorded = [];
  const ambiguous = [];
  const suppressed = [];
  const wakeRequests = [];

  for (const raw of events) {
    if (isSelfGeneratedEvent(raw, config)) {
      suppressed.push(raw);
      continue;
    }

    const matched = matchRoute(raw, routes);
    if (!matched) continue;
    if (matched.ambiguous) {
      const { event, created } = recordEvent(state, {
        ...raw,
        status: "ambiguous",
      });
      event.status = "ambiguous";
      event.match = {
        status: "ambiguous",
        candidates: matched.candidates || [],
        reasons: matched.reasons || ["ambiguous"],
      };
      ambiguous.push({ event, created, match: matched });
      continue;
    }

    const { event, created } = recordEvent(state, {
      ...raw,
      routeId: raw.routeId || matched.route.id,
      status: "routed",
    });
    const workItem = ensureWorkItem(state, routeToWorkItemParams(matched.route, event));
    event.workItemId = workItem.id;
    event.status = "routed";
    event.routeId = matched.route.id;
    recorded.push({ event, created, route: matched.route, match: matched });

    if (created && shouldWake(matched.route, event)) {
      const owner = matched.route.owner || matched.route.session || {};
      const target = {
        agentId: event.targetAgentId || owner.agentId || "main",
        sessionKey: event.targetSessionKey || owner.sessionKey || null,
        ownerVersion: owner.ownerVersion || 1,
      };
      const message = renderWakeMessage({ event, workItem, route: matched.route, match: matched });
      const result = enqueueWakeRequest(state, event, workItem, target, {
        dryRun: config.wake.dryRun,
        message,
      });
      wakeRequests.push(result);
    }
  }

  const dispatched = await dispatchPendingWakeRequests({
    state,
    runtime,
    wakeConfig: config.wake,
    logger,
  });
  return {
    recordedCount: recorded.length,
    newEventCount: recorded.filter((entry) => entry.created).length,
    ambiguousCount: ambiguous.length,
    newAmbiguousEventCount: ambiguous.filter((entry) => entry.created).length,
    suppressedCount: suppressed.length,
    wakeRequestCount: wakeRequests.length,
    dispatchedWakeCount: dispatched.length,
    deadLetterCount: Object.values(state.wakeRequests).filter((wake) => wake.status === "dead_letter").length,
    recorded,
    ambiguous,
    wakeRequests: wakeRequests.map((entry) => entry.wakeRequest),
    dispatched,
  };
}

export function isSelfGeneratedEvent(raw, config) {
  if (config?.self?.suppressGeneratedEvents === false) return false;
  const event = raw && typeof raw === "object" ? raw : {};
  const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? event.payload
    : {};
  const origin = event.origin && typeof event.origin === "object" && !Array.isArray(event.origin)
    ? event.origin
    : payload.origin && typeof payload.origin === "object" && !Array.isArray(payload.origin)
      ? payload.origin
      : {};
  const producerIds = new Set([
    "async-result-router",
    config?.self?.producerId,
    ...(Array.isArray(config?.self?.producerIds) ? config.self.producerIds : []),
  ].map((value) => String(value || "").toLowerCase()).filter(Boolean));
  const producerValues = [
    event.generatedBy,
    payload.generatedBy,
    event.producerId,
    payload.producerId,
    origin.producerId,
    origin.generatedBy,
  ].map((value) => String(value || "").toLowerCase()).filter(Boolean);
  if (producerValues.some((value) => producerIds.has(value))) return true;

  const markers = [
    "generated-by: async-result-router",
    ...(Array.isArray(config?.self?.markers) ? config.self.markers : []),
  ].map((value) => String(value || "").toLowerCase()).filter(Boolean);
  if (!isMarkerSuppressionSource(event, payload, config)) return false;
  const bag = [
    event.summary,
    event.title,
    event.subject,
    event.body,
    event.text,
    payload.summary,
    payload.title,
    payload.subject,
    payload.body,
    payload.text,
  ].map((value) => String(value || "")).join("\n").toLowerCase();
  return markers.some((marker) => marker && bag.includes(marker));
}

function isMarkerSuppressionSource(event, payload, config) {
  const markerSourceTypes = [
    "notification",
    "notificationlog",
    "discord",
    "mobile_notification",
    "companion_notification",
    ...(Array.isArray(config?.self?.markerSourceTypes) ? config.self.markerSourceTypes : []),
  ].map((value) => String(value || "").toLowerCase()).filter(Boolean);
  const sourceValues = [
    event.sourceType,
    payload.sourceType,
    event.source,
    payload.source,
  ].map((value) => String(value || "").toLowerCase()).filter(Boolean);
  return sourceValues.some((value) => markerSourceTypes.includes(value));
}
