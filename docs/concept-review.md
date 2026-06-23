# Async Result Router Concept Review

## What This Plugin Does

Async Result Router is an OpenClaw Gateway plugin that preserves responsibility
across asynchronous boundaries.

It watches or receives events from sources such as webhooks, mail state,
notification logs, command adapters, or file drops. Each event is matched
against durable route definitions. When a route matches, the plugin records the
event/work item state and wakes the owning OpenClaw session with a system event.

The plugin is not the worker that fixes issues. Its job is to connect an
asynchronous result back to the agent/session that owns the next decision.

Non-goals: it does not repair PRs, interpret CI results as a domain authority,
resolve review comments, replace the route owner, use visible notifications as
source of truth, or promise exactly-once agent execution.

## Why It Exists

Without a routing layer, async monitors usually end at visible notification:

1. An agent opens a pull request.
2. A cron job or child session watches CI/reviews.
3. The monitor posts a Discord notification when CI fails or review changes are
   requested.
4. The original session does not wake up by itself.
5. A human has to notice the notification and manually re-prompt the session.

That breaks the ownership chain. The system can notify, but it cannot reliably
continue.

Async Result Router turns the notification into a durable handoff:

1. The owning session registers a route when it starts async work.
2. A later event arrives from GitHub, email, webhook, or device notification.
3. The router matches the event to the registered route.
4. The router records idempotent state so duplicate delivery does not loop.
5. The router injects a system event into the owning session and requests a
   heartbeat.
6. The owning session decides whether to repair, re-check, schedule another
   follow-up, ask for human approval, or close the route.

This makes visible notifications a projection, not the source of truth.

## How It Is Used

The core workflow is:

1. Start async work.
2. Register a route from the owning session.
3. Let sources deliver events.
4. The plugin wakes the owner session.
5. The owner session acknowledges the event, re-fetches source of truth, takes
   the next action, records the outcome, and eventually closes the route.

The plugin exposes agent tools:

- `async_result_router_register_route`
- `async_result_router_list_routes`
- `async_result_router_close_route`
- `async_result_router_ack_event`
- `async_result_router_record_outcome`
- `async_result_router_inspect_state`

If `sessionKey` is omitted during registration, the tool uses the current
session as the owner.

Structured event producers should prefer carrying a `routeId` in the event.
Matching precedence is trusted structured `routeId`, then hard structured
constraints such as `repo`, `prNumber`, or `sessionKey`, then hard constraints
plus soft text score. Ambiguous matches fail closed and do not wake sessions.
They are recorded as `ambiguous` so the route owner can inspect and repair
route definitions without accidentally waking multiple sessions.
Matching on text, sender, URL, or repository text is a fallback for lossy
sources such as mobile notifications or legacy logs.

Only `active` routes are routable. `paused`, `closed`, `cancelled`, and expired
routes remain visible for inspection but do not wake sessions. Routes should use
`expiresAt` as a stale-route guard, and the owning session should close the
route when the async loop is complete. Routes are owned by an agent/session pair
with `ownerVersion` and `fallbackPolicy`, not by a bare `sessionKey`.
Ownership transfer should update the owner and increment `ownerVersion`, or
close the old route and register a replacement.

## GitHub PR Example

After creating PR `owner/repo#123`, the owning session registers:

```json
{
  "id": "github-owner-repo-pr-123",
  "topic": "GitHub PR #123 follow-up",
  "expiresAt": "2026-06-30T00:00:00.000Z",
  "owner": {
    "agentId": "main",
    "sessionKey": "agent:main:discord:channel:abc",
    "ownerVersion": 1,
    "fallbackPolicy": "agent-main"
  },
  "sourceTypes": ["github", "webhook", "notification"],
  "match": {
    "hard": {
      "repo": "owner/repo",
      "prNumber": 123
    },
    "eventTypes": ["ci_failed", "review_requested_changes", "ci_green"],
    "subjectOrBodyContains": [
      "PR #123",
      "changes requested",
      "CI failed",
      "check failed"
    ]
  },
  "actions": {
    "wakeSession": true
  }
}
```

Later, a GitHub webhook, command adapter, or phone notification sends an event
such as:

```json
{
  "sourceType": "github",
  "source": "github-webhook",
  "type": "review_requested_changes",
  "repo": "owner/repo",
  "summary": "Review requested changes on PR #123.",
  "payload": {
    "repo": "owner/repo",
    "prNumber": 123,
    "body": "changes requested"
  }
}
```

The plugin wakes the original session with a system event saying an async result
arrived, including the work item, event, route, source, and required action
guidance.

The wake message treats external payloads as untrusted data. The owner session
must call `async_result_router_ack_event`, re-fetch source of truth, ignore
instructions embedded in external payloads, decide the next action, and call
`async_result_router_record_outcome`.

## State And Delivery Model

Route definitions are JSON configuration because they are policy: they should be
reviewable, editable, generated by agents, and easy to version.

Operational state currently uses a JSON state file for third-party plugin
compatibility. Writes are atomic and Gateway processing is serialized
in-process. The file backend validates the top-level state shape, keeps a
`.bak` copy, and quarantines invalid JSON before falling back to backup or
empty state. It is a single-writer, single-Gateway backend and must not be
treated as a production queue. OpenClaw runtime keyed state was evaluated, but
this release
restricts it to trusted/bundled plugins. A future SQLite backend is the likely
upgrade path for higher event volume, stronger transactions, and richer history
queries. The JSON backend is an MVP choice for a single Gateway process, not a
claim that JSON is the right long-term storage model for every deployment.

Operational state is a machine-owned ledger for work items, events, wake
requests, deliveries, and outcomes. Visible notifications are projections.
System event enqueue means the owner was asked to wake; it does not mean the
event was handled. `ack_event` and `record_outcome` keep wake delivery and event
handling separate.

Source trust is explicit:

- `trusted_structured`: routeId may be authoritative.
- `semi_trusted`: routeId is a hint and hard constraints must also match.
- `untrusted`: routeId is ignored unless hard constraints and score threshold
  pass.

Self-loop suppression is explicit. Wake messages include a
`Generated-by: async-result-router` marker, and source events can also carry
`generatedBy`, `producerId`, or `origin.producerId`. Structured producer
markers suppress events before matching, preventing Discord/companion
notifications generated by the router from re-entering the handoff loop. Text
marker suppression is limited to echo-prone notification sources; trusted
structured sources are not suppressed by marker text alone.

Idempotency is part of the public contract. Event producers should emit stable
`sourceId` or `idempotencyKey` values. Wake requests are keyed by event, target
agent/session, and `ownerVersion`, so duplicate polling/webhook delivery does
not produce duplicate wakes for the same owner. Outcomes are keyed by event,
owner version, outcome kind, and actor run by default, with an explicit
`idempotencyKey` override for runtimes that have a stronger run identifier.

Known MVP limitations are documented: JSON is single-Gateway-process storage,
SQLite is deferred until production-grade durability/high volume/multiprocess
coordination, Workboard owner integration is future work, and unmatched replay
or wake coalescing can be added after the first public plugin cut.

HTTP ingest uses the Gateway auth boundary by default. Unsigned or semi-trusted
events are untrusted data: they cannot use `routeId` as authority by itself,
must pass hard constraints, and are never treated as agent instructions. No-route
events are observed but not persisted by default; ambiguous events are persisted
because they represent a route safety decision.

The MVP also does not implement event-storm budgets, global rate limits, or
route-level cooldown/coalescing. Configured sources should remain bounded for a
single-Gateway personal deployment.

## External Review Result

The ChatGPT Pro concept review accepted the plugin boundary as a public MVP if
it is framed as a "single-Gateway durable handoff beta." The review explicitly
allowed deferring SQLite, Workboard ownership, unmatched replay, requester
session inference, and wake coalescing.

The review required four items to remain in MVP scope:

1. Self-loop suppression.
2. Inspection surface for pending, ambiguous, dead-letter, event, wake, and
   outcome state.
3. Explicit idempotency key contract.
4. JSON backend integrity: atomic write, schema validation, and startup repair.

The current design and smoke test cover those four items.

## Review Questions

Please review the concept, not the code details:

1. Is the plugin boundary coherent?
2. Is the distinction between visible notification and durable handoff clear?
3. Is route ownership clear enough for agents to use reliably?
4. Does the GitHub PR example make the intended workflow concrete?
5. Are there missing concepts before publishing this as an OpenClaw plugin?
6. Is JSON route config plus JSON operational state acceptable for an MVP, or
   should SQLite be required before public release?
