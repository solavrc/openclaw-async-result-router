import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { resolveRouterConfig } from "./config.mjs";
import { pollOnce } from "./router.mjs";
import { closeStoredRoute, listAllRoutes, upsertStoredRoute } from "./route-store.mjs";
import { acknowledgeEvent, loadState, recordEventOutcome, withStateStore } from "./store.mjs";
import { createWebhookHandler } from "./http.mjs";
import { inspectState } from "./tools.mjs";

export async function runSmokeTest({ keep = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-async-router-"));
  const inboxDir = path.join(dir, "inbox");
  const notificationDir = path.join(dir, "notifications");
  fs.mkdirSync(inboxDir, { recursive: true });
  fs.mkdirSync(notificationDir, { recursive: true });
  const routeConfigPath = path.join(dir, "routes.json");
  const statePath = path.join(dir, "state.json");

  fs.writeFileSync(path.join(inboxDir, "event.json"), `${JSON.stringify({
    sourceType: "github",
    sourceId: "example/repo#42:review:1",
    type: "review_requested_changes",
    repo: "example/repo",
    title: "requested changes on target PR",
    summary: "GitHub review requested changes on the target repository.",
    payload: {
      repo: "example/repo",
      prNumber: 42,
      body: "requested changes",
    },
  }, null, 2)}\n`);

  fs.writeFileSync(path.join(inboxDir, "expired.json"), `${JSON.stringify({
    sourceType: "github",
    sourceId: "example/expired#99:review:1",
    routeId: "smoke-expired-route",
    type: "review_requested_changes",
    repo: "example/expired",
    summary: "Expired route should not dispatch.",
    payload: {
      repo: "example/expired",
      prNumber: 99,
      body: "expired-only-token",
    },
  }, null, 2)}\n`);

  fs.writeFileSync(path.join(inboxDir, "paused.json"), `${JSON.stringify({
    sourceType: "github",
    sourceId: "example/paused#100:review:1",
    routeId: "smoke-paused-route",
    type: "review_requested_changes",
    repo: "example/paused",
    summary: "Paused route should not dispatch.",
    payload: {
      repo: "example/paused",
      prNumber: 100,
      body: "paused-only-token",
    },
  }, null, 2)}\n`);

  fs.writeFileSync(path.join(inboxDir, "other-repo.json"), `${JSON.stringify({
    sourceType: "github",
    sourceId: "other/repo#42:review:1",
    type: "review_requested_changes",
    repo: "other/repo",
    title: "requested changes on unrelated PR #42",
    summary: "Unrelated GitHub review requested changes.",
    payload: {
      repo: "other/repo",
      prNumber: 42,
      body: "requested changes",
    },
  }, null, 2)}\n`);

  fs.writeFileSync(path.join(inboxDir, "structured-marker.json"), `${JSON.stringify({
    sourceType: "github",
    sourceId: "other/marker#1",
    type: "review_requested_changes",
    repo: "other/marker",
    title: "structured source includes router marker text",
    summary: "Generated-by: async-result-router should not suppress structured GitHub events by text alone.",
    payload: {
      repo: "other/marker",
      prNumber: 1,
      body: "Generated-by: async-result-router",
    },
  }, null, 2)}\n`);

  fs.writeFileSync(path.join(inboxDir, "ambiguous.json"), `${JSON.stringify({
    sourceType: "github",
    sourceId: "ambiguous:1",
    type: "review_requested_changes",
    summary: "ambiguous-only-token should not wake two sessions.",
    payload: {
      body: "ambiguous-only-token",
    },
  }, null, 2)}\n`);

  fs.writeFileSync(path.join(notificationDir, "notifications.jsonl"), `${JSON.stringify({
    id: "notification:1",
    packageName: "com.github.android",
    title: "CI failed",
    body: "example/repo pull request checks failed.",
    postedAt: "2026-06-23T00:00:00.000Z",
  })}\n${JSON.stringify({
    id: "notification:self-loop",
    packageName: "com.discord",
    title: "Async result arrived",
    body: "Generated-by: async-result-router\nexample/repo pull request checks failed.",
    postedAt: "2026-06-23T00:00:01.000Z",
  })}\n`);

  const config = resolveRouterConfig({
    statePath,
    routeConfigPath,
    state: {
      backend: "file",
    },
    sources: [
      {
        id: "smoke-inbox",
        type: "file",
        path: inboxDir,
        sourceType: "github",
      },
      {
        id: "smoke-notifications",
        type: "notificationLog",
        path: notificationDir,
      },
    ],
    webhook: {
      enabled: true,
      sourceId: "smoke-webhook",
      sourceType: "github",
    },
    wake: {
      dryRun: true,
    },
  }, { openclawHome: dir });

  const prRoute = upsertStoredRoute(config, {
    id: "smoke-pr-route",
    status: "active",
    topic: "Smoke PR follow-up",
    sourceTypes: ["github"],
    match: {
      repo: "example/repo",
      prNumber: 42,
      subjectOrBodyContains: ["requested changes"],
    },
    actions: {
      wakeSession: true,
    },
  }, {
    context: {
      agentId: "main",
      sessionKey: "agent:main:discord:channel:1234567890",
    },
  });
  const notificationRoute = upsertStoredRoute(config, {
    id: "smoke-notification-route",
    status: "active",
    topic: "Smoke notification follow-up",
    sourceTypes: ["notification"],
    match: {
      appContains: ["com.github.android"],
      subjectOrBodyContains: ["CI failed"],
    },
    actions: {
      wakeSession: true,
    },
  }, {
    context: {
      agentId: "main",
      sessionKey: "agent:main:discord:channel:9999999999",
    },
  });
  const expiredRoute = upsertStoredRoute(config, {
    id: "smoke-expired-route",
    status: "active",
    expiresAt: "2026-06-22T00:00:00.000Z",
    topic: "Expired route follow-up",
    sourceTypes: ["github"],
    match: {
      repo: "example/expired",
      subjectOrBodyContains: ["expired-only-token"],
    },
    actions: {
      wakeSession: true,
    },
  }, {
    context: {
      agentId: "main",
      sessionKey: "agent:main:discord:channel:7777777777",
    },
  });
  const pausedRoute = upsertStoredRoute(config, {
    id: "smoke-paused-route",
    status: "paused",
    topic: "Paused route follow-up",
    sourceTypes: ["github"],
    match: {
      repo: "example/paused",
      subjectOrBodyContains: ["paused-only-token"],
    },
    actions: {
      wakeSession: true,
    },
  }, {
    context: {
      agentId: "main",
      sessionKey: "agent:main:discord:channel:6666666666",
    },
  });
  const ambiguousRouteA = upsertStoredRoute(config, {
    id: "smoke-ambiguous-route-a",
    status: "active",
    topic: "Ambiguous route A",
    sourceTypes: ["github"],
    match: {
      subjectOrBodyContains: ["ambiguous-only-token"],
    },
    actions: {
      wakeSession: true,
    },
  }, {
    context: {
      agentId: "main",
      sessionKey: "agent:main:discord:channel:5555555555",
    },
  });
  const ambiguousRouteB = upsertStoredRoute(config, {
    id: "smoke-ambiguous-route-b",
    status: "active",
    topic: "Ambiguous route B",
    sourceTypes: ["github"],
    match: {
      subjectOrBodyContains: ["ambiguous-only-token"],
    },
    actions: {
      wakeSession: true,
    },
  }, {
    context: {
      agentId: "main",
      sessionKey: "agent:main:discord:channel:4444444444",
    },
  });
  const registeredRoutes = listAllRoutes(config);

  const result = await pollOnce({ config, logger: console });
  const webhookResult = await postWebhook(config, {
    sourceType: "github",
    sourceId: "example/repo#42:review:1",
    idempotencyKey: "smoke-inbox:example/repo#42:review:1",
    type: "review_requested_changes",
    repo: "example/repo",
    summary: "Duplicate webhook delivery should be idempotent.",
    payload: {
      repo: "example/repo",
      prNumber: 42,
      body: "requested changes",
    },
  });
  let ackResult = null;
  let outcomeResult = null;
  let duplicateOutcomeResult = null;
  await withStateStore(config, null, async (state) => {
    const prEvent = Object.values(state.events).find((event) => event.routeId === "smoke-pr-route");
    if (!prEvent) throw new Error("smoke PR event was not recorded");
    const prWake = Object.values(state.wakeRequests).find((wake) => wake.eventId === prEvent.id);
    ackResult = acknowledgeEvent(state, {
      eventId: prEvent.id,
      wakeRequestId: prWake?.id,
      routeId: "smoke-pr-route",
      ownerVersion: 1,
      ack: "seen",
    });
    outcomeResult = recordEventOutcome(state, {
      eventId: prEvent.id,
      routeId: "smoke-pr-route",
      ownerVersion: 1,
      actorRunId: "smoke-run",
      outcome: "followup_scheduled",
      summary: "Smoke test acknowledged and scheduled follow-up.",
      nextWorkItemStatus: "monitoring",
    });
    duplicateOutcomeResult = recordEventOutcome(state, {
      eventId: prEvent.id,
      routeId: "smoke-pr-route",
      ownerVersion: 1,
      actorRunId: "smoke-run",
      outcome: "followup_scheduled",
      summary: "Duplicate outcome should be idempotent.",
      nextWorkItemStatus: "monitoring",
    });
  });
  const state = loadState(statePath);
  const events = Object.values(state.events);
  const wakeRequests = Object.values(state.wakeRequests);
  const inspection = inspectState(state);
  const closedRoute = closeStoredRoute(config, {
    id: "smoke-pr-route",
    reason: "smoke complete",
  });
  const routesAfterClose = listAllRoutes(config, { includeClosed: true });

  const ok = result.observedCount === 8
    && prRoute.created === true
    && notificationRoute.created === true
    && expiredRoute.created === true
    && pausedRoute.created === true
    && ambiguousRouteA.created === true
    && ambiguousRouteB.created === true
    && registeredRoutes.length === 6
    && result.routeCount === 4
    && result.newEventCount === 2
    && result.ambiguousCount === 1
    && result.newAmbiguousEventCount === 1
    && result.suppressedCount === 1
    && webhookResult.newEventCount === 0
    && events.length === 3
    && events.some((event) => event.status === "ambiguous")
    && wakeRequests.length === 2
    && inspection.counts.ambiguousEvents === 1
    && inspection.counts.deadLetters === 0
    && ackResult?.event?.acknowledgedAt
    && ackResult?.wakeRequest?.status === "acknowledged"
    && outcomeResult?.event?.status === "processed"
    && outcomeResult?.created === true
    && duplicateOutcomeResult?.created === false
    && Object.keys(state.outcomes).length === 1
    && wakeRequests.some((wake) => wake.targetSessionKey === "agent:main:discord:channel:1234567890")
    && wakeRequests.some((wake) => wake.targetSessionKey === "agent:main:discord:channel:9999999999")
    && !wakeRequests.some((wake) => wake.targetSessionKey === "agent:main:discord:channel:7777777777")
    && !wakeRequests.some((wake) => wake.targetSessionKey === "agent:main:discord:channel:6666666666")
    && !wakeRequests.some((wake) => wake.targetSessionKey === "agent:main:discord:channel:5555555555")
    && !wakeRequests.some((wake) => wake.targetSessionKey === "agent:main:discord:channel:4444444444")
    && wakeRequests.every((wake) => wake.status === "dry_run" || wake.status === "acknowledged")
    && closedRoute.route.status === "closed"
    && routesAfterClose.some((route) => route.id === "smoke-pr-route" && route.status === "closed");

  if (!keep) fs.rmSync(dir, { recursive: true, force: true });
  if (!ok) {
    const err = new Error("async-result-router smoke test failed");
    err.result = result;
    err.state = state;
    throw err;
  }
  return {
    ok,
    dir: keep ? dir : null,
    result: {
      observedCount: result.observedCount,
      newEventCount: result.newEventCount,
      ambiguousCount: result.ambiguousCount,
      suppressedCount: result.suppressedCount,
      duplicateWebhookNewEventCount: webhookResult.newEventCount,
      wakeRequestCount: result.wakeRequestCount,
      routeCount: registeredRoutes.length,
      routableRouteCount: result.routeCount,
      ambiguousEventCount: inspection.counts.ambiguousEvents,
      deadLetterCount: inspection.counts.deadLetters,
      outcomeCount: Object.keys(state.outcomes).length,
    },
  };
}

async function postWebhook(config, event) {
  const handler = createWebhookHandler({ config, runtime: null, logger: console });
  const server = http.createServer((req, res) => {
    handler(req, res).catch((err) => {
      res.statusCode = 500;
      res.end(err?.message || String(err));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}${config.webhook.path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`webhook returned ${response.status}: ${text}`);
    return JSON.parse(text);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
