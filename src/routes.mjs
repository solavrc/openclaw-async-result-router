import { isRoutableRoute, loadRouteDocument } from "./route-store.mjs";

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function lower(value) {
  return String(value || "").toLowerCase();
}

function eventPayload(event) {
  const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
  if (payload.payload && typeof payload.payload === "object" && !Array.isArray(payload.payload)) {
    return { ...payload, ...payload.payload };
  }
  return payload;
}

function textBag(event) {
  const payload = eventPayload(event);
  return [
    event.summary,
    payload.subject,
    payload.title,
    payload.body,
    payload.text,
    payload.reason,
    payload.url,
    payload.repo,
    payload.repository,
    payload.prNumber,
    payload.pullRequestNumber,
    payload.number,
    payload.app,
    payload.packageName,
    payload.package,
  ].map((value) => String(value || "")).join("\n").toLowerCase();
}

export function loadRoutes(config) {
  const routes = [];
  if (Array.isArray(config.routes)) routes.push(...config.routes);

  if (config.legacyRoutes?.enabled && config.routeConfigPath) {
    const legacy = loadRouteDocument(config.routeConfigPath);
    if (legacy && Array.isArray(legacy.routes)) routes.push(...legacy.routes.map((route) => ({
      ...route,
      routeFormat: "async-session-routes-v1",
    })));
  }

  return routes.filter((route) => {
    return isRoutableRoute(route);
  });
}

export function matchRoute(event, routes) {
  const trustLevel = lower(event.trustLevel || eventPayload(event).trustLevel || "semi_trusted");
  if (event.routeId && trustLevel === "trusted_structured") {
    const direct = routes.find((route) => route.id === event.routeId);
    if (direct) return { route: direct, score: 1000, reasons: ["trusted:event.routeId"], trustLevel };
  }

  const candidates = [];
  for (const route of routes) {
    const result = scoreRoute(event, route);
    const threshold = Number.isFinite(Number(route.minConfidence))
      ? Number(route.minConfidence)
      : 20;
    if (result.score >= threshold) candidates.push({ route, ...result, threshold });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score);
  const [best, second] = candidates;
  if (second && second.score >= best.score) {
    return {
      ambiguous: true,
      score: best.score,
      reasons: ["ambiguous"],
      candidates: candidates.map((entry) => ({ routeId: entry.route.id, score: entry.score, reasons: entry.reasons })),
    };
  }
  return { ...best, trustLevel };
}

export function scoreRoute(event, route) {
  let score = 0;
  const reasons = [];
  const sourceTypes = asArray(route.sourceTypes).map(lower);
  if (sourceTypes.length) {
    if (!sourceTypes.includes(lower(event.sourceType)) && !sourceTypes.includes(lower(event.source))) {
      return { score: 0, reasons: [] };
    }
    score += 5;
    reasons.push("sourceType");
  }

  const match = route.match || {};
  const hard = match.hard && typeof match.hard === "object" && !Array.isArray(match.hard)
    ? match.hard
    : match;
  const payload = eventPayload(event);
  const bag = textBag(event);
  const repo = lower(payload.repo || payload.repository || event.repo);
  const eventTypes = asArray(match.eventTypes);
  if (eventTypes.length) {
    if (!eventTypes.map(lower).includes(lower(event.type))) return { score: 0, reasons: [] };
    score += 30;
    reasons.push(`eventType:${event.type}`);
  }

  if (hard.repo) {
    const expectedRepo = lower(hard.repo);
    if (repo !== expectedRepo && !bag.includes(expectedRepo)) return { score: 0, reasons: [] };
    score += 40;
    reasons.push(`repo:${hard.repo}`);
  }

  if (hard.prNumber != null) {
    const expectedPr = String(hard.prNumber).trim();
    const actualPr = String(payload.prNumber || payload.pullRequestNumber || event.prNumber || "").trim();
    const prInText = bag.includes(`#${expectedPr}`) || bag.includes(`pr ${expectedPr}`);
    if (!expectedPr || (actualPr !== expectedPr && !prInText)) return { score: 0, reasons: [] };
    score += 50;
    reasons.push(`pr:${expectedPr}`);
  }

  if (hard.sessionKey) {
    if (lower(hard.sessionKey) !== lower(payload.sessionKey || event.targetSessionKey)) {
      return { score: 0, reasons: [] };
    }
    score += 50;
    reasons.push("sessionKey");
  }

  const sender = lower(payload.sender || payload.from || event.sender);
  const app = lower(payload.app || payload.packageName || payload.package || payload.bundleId);

  for (const needle of asArray(match.senderContains)) {
    if (sender.includes(lower(needle))) {
      score += 20;
      reasons.push(`sender:${needle}`);
    }
  }
  for (const needle of asArray(match.subjectOrBodyContains || match.softText?.containsAny)) {
    if (bag.includes(lower(needle))) {
      score += 15;
      reasons.push(`text:${needle}`);
    }
  }
  for (const needle of asArray(match.bodyContains)) {
    if (bag.includes(lower(needle))) {
      score += 10;
      reasons.push(`body:${needle}`);
    }
  }
  for (const needle of asArray(match.urlContains)) {
    if (bag.includes(lower(needle))) {
      score += 25;
      reasons.push(`url:${needle}`);
    }
  }
  for (const needle of asArray(match.appContains || match.packageContains)) {
    if (app.includes(lower(needle))) {
      score += 25;
      reasons.push(`app:${needle}`);
    }
  }

  return { score, reasons };
}

export function routeToWorkItemParams(route, event) {
  const owner = route.owner || route.session || {};
  const sessionKey = owner.sessionKey || event.targetSessionKey || null;
  const payload = eventPayload(event);
  const workItemId = event.workItemId || route.workItemId || `route:${route.id}`;
  return {
    id: workItemId,
    kind: route.kind || payload.kind || "async_route",
    title: route.topic || payload.title || payload.subject || event.summary || route.id,
    topic: route.topic,
    routeId: route.id,
    ownerAgentId: owner.agentId || "main",
    ownerSessionKey: sessionKey,
    ownerVersion: owner.ownerVersion || 1,
    fallbackPolicy: owner.fallbackPolicy || "agent-main",
    fallbackAgentId: owner.fallbackAgentId || "main",
  };
}

export function shouldWake(route, event) {
  if (event.targetSessionKey || event.targetAgentId) return true;
  return route?.actions?.wakeSession === true;
}
