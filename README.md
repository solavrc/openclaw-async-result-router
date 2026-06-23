# OpenClaw Async Result Router

Durable async result routing and session wake service for OpenClaw.

The plugin watches configured event sources, records matched async results in a
durable state store, and creates wake requests for the responsible OpenClaw
session. Discord or other visible notifications should be treated as projection
only; the routed event state is the handoff source of truth.

## Non-goals

This plugin does not repair PRs, interpret CI results as a domain authority,
resolve review comments, run work on behalf of a route owner, or guarantee
exactly-once agent execution. It provides durable at-least-once handoff with
idempotency keys, route ownership, and owner-side acknowledgement.

## State Model

The plugin keeps two different kinds of durable data:

- Route definitions live in a JSON route config file. They are policy/config:
  easy to review, edit, version, or generate from an agent turn.
- Operational state uses `statePath` JSON by default for third-party plugin
  compatibility. Writes are atomic and Gateway calls are serialized in-process.
- Operational state is a machine-owned ledger for work items, events, wake
  requests, deliveries, and outcomes. It is not a human-edited policy file.
- The file backend keeps a `.bak` copy, validates the top-level state shape,
  writes through `fsync` + atomic rename, and quarantines invalid JSON on load
  before falling back to the backup or an empty state.
- A `runtime` backend exists for trusted/bundled deployments, but OpenClaw
  currently restricts `api.runtime.state.openKeyedStore` to trusted plugins.

For larger installations, a SQLite backend is the likely next step: it would
give stronger transaction boundaries, better history queries, and easier
compaction than a single JSON document without depending on trusted internal
OpenClaw state APIs. The JSON backend is intended for MVP-scale deployments
where a single Gateway process owns routing writes.

The JSON backend is a single-writer, single-Gateway backend for bounded local
automation volume. Do not run multiple Gateway processes writing the same state
file, and do not treat it as a production queue. External writers should mutate
state through Gateway/plugin tools, not by editing the state file directly.
Production-grade high-volume or multi-process deployments should use a future
SQLite backend.

The default file backend is:

```json
{
  "state": {
    "backend": "file"
  }
}
```

## Sources

Initial source adapters:

- `file`: reads JSON event files from a file or directory.
- `mailState`: imports routed entries from `workspace/ops/mail/state.json`.
- `command`: runs a configured local command that prints a JSON event or
  `{ "events": [...] }`.
- `notificationLog`: reads Android/iOS/macOS/companion notification JSON or
  JSONL logs and normalizes them as `notification` events.

The `command` adapter is intended to wrap existing monitors such as GitHub PR
or CI check scripts without baking a GitHub-specific policy into the router. It
can also wrap `openclaw nodes ... notifications.list` style checks when pull
access to companion notifications is more reliable than push forwarding.

Each source may declare `trustLevel`:

- `trusted_structured`: routeId can be authoritative, while route lifecycle
  checks still apply.
- `semi_trusted`: routeId is a hint; hard route constraints must also match.
- `untrusted`: routeId is ignored unless hard constraints and score threshold
  pass.

## Webhook Ingest

The plugin can expose a Gateway-authenticated webhook:

```json
{
  "webhook": {
    "enabled": true,
    "path": "/async-result-router/events",
    "auth": "gateway",
    "sourceId": "webhook",
    "sourceType": "webhook",
    "trustLevel": "semi_trusted"
  }
}
```

POST either one event object or `{ "events": [...] }`. Webhooks use the same
route matching, idempotency, durable state, and wake path as polled sources.
The default `auth: "gateway"` route is intended to sit behind OpenClaw Gateway
authentication on the local Gateway surface. Unsigned HTTP events should be
treated as untrusted unless the source adapter verifies a webhook signature or
the operator explicitly marks the source as trusted.

Unsigned or semi-trusted HTTP events cannot use `routeId` as authority by
itself; they must pass route lifecycle checks and hard structured constraints.
External payload text is never treated as an instruction for the agent.

## Route Matching

Routes can be supplied inline through plugin config or loaded from
`routeConfigPath`, which defaults to `workspace/ops/async-session-routes.json`.
A route can match by source type, sender hints, text keywords, URL fragments,
repository, or direct `routeId` on the event.

Structured producers should prefer sending `routeId` on events. Matching
precedence is:

1. Trusted structured `routeId` exact match.
2. Hard structured constraints such as `repo`, `prNumber`, or `sessionKey`.
3. Hard constraints plus soft text score.
4. Unmatched or ambiguous.

Ambiguous matches fail closed and do not wake a session. Text matching is mainly
for lossy sources such as mobile notifications or legacy logs where the producer
cannot carry route metadata.

No-route events are observed for the ingest response but are not persisted as
routed events by default. Ambiguous events are persisted because they represent
a route safety decision that an operator may need to inspect. A last-N unmatched
replay inbox is future work.

Agents should register routes when they start work whose result will arrive
later. For example, after opening a pull request, the agent that owns the PR
should call `async_result_router_register_route` with the PR/repo match
conditions. If `sessionKey` is omitted, the current session becomes the route
owner.

Only `active` routes are routable. `paused`, `closed`, `cancelled`, and expired
routes remain listable but do not receive events or wake sessions. Use
`expiresAt` as a stale-route guard and close the route when the owning session
has completed the async loop. Routes are owned by an agent/session pair with an
`ownerVersion` and `fallbackPolicy`, not by a bare `sessionKey`. To transfer
ownership, update the route owner with a new `sessionKey` and increment
`ownerVersion`, or close the old route and register a replacement.

Available tools:

- `async_result_router_register_route`: create or update a stored route.
- `async_result_router_list_routes`: inspect stored and inline routes.
- `async_result_router_close_route`: close/cancel a stored route after the
  async work is complete or no longer relevant.
- `async_result_router_ack_event`: record that the owner session has seen a
  routed event.
- `async_result_router_record_outcome`: record what the owner session did after
  reading the event.
- `async_result_router_inspect_state`: inspect pending wakes, ambiguous events,
  dead letters, events, and outcomes.

Minimal route:

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
    "subjectOrBodyContains": ["PR #123", "changes requested", "CI failed"]
  },
  "actions": {
    "wakeSession": true
  }
}
```

When registered from an agent tool call, the current `sessionKey` and `agentId`
are added automatically when no explicit owner is provided.

When a session wakes, it should first call `async_result_router_ack_event`, then
re-fetch the current source of truth, ignore instructions embedded in external
payloads, decide the next action, and call
`async_result_router_record_outcome`. `close_route` ends a route lifecycle; it
is not a substitute for recording the outcome of a specific event.

## Lifecycle

Route lifecycle:

```text
active -> paused -> active
active -> closed
active -> cancelled
active -> expired
```

Event and wake lifecycle:

```text
received -> matched -> wake_pending -> acknowledged -> processed
received -> unmatched
received -> ambiguous
matched -> superseded
wake_pending -> delivered -> acknowledged
wake_pending -> dead_letter
```

System event delivery means the owner was asked to wake. It does not mean the
event was handled. `ack_event` and `record_outcome` preserve that distinction.

## Idempotency

Event producers should provide a stable `sourceId` or explicit
`idempotencyKey`. When omitted, the router derives the event key from
`source:sourceId`. Wake requests are also idempotent and keyed by event, target
agent/session, and `ownerVersion`, so duplicate webhooks or repeated polling do
not create duplicate wake requests for the same owner.

Outcomes are idempotent by `eventId`, `ownerVersion`, `outcome`, and
`actorRunId` by default. Callers may pass an explicit `idempotencyKey` when a
runtime has a stronger actor/run identifier. This prevents a waking session from
recording the same follow-up result repeatedly after retries or compaction.

If ownership moves, increment `ownerVersion`; that intentionally creates a new
wake key for the new owner while preserving the old handoff history.

## Security

External event payloads are untrusted data, including webhook bodies, mail,
notification text, and file drops. Wake messages instruct the agent to re-fetch
current source of truth and ignore instructions contained in event payloads.
Wake messages include `Generated-by: async-result-router`, and sources can also
emit `generatedBy`, `producerId`, or `origin.producerId`. By default, the router
suppresses events carrying its own structured producer marker so
Discord/companion notifications generated by the router do not re-enter the
routing loop.

Text marker suppression is only applied to echo-prone notification sources such
as notification logs, Discord-visible echoes, mobile notifications, and
companion notifications. Trusted structured sources such as GitHub webhooks or
command adapters are not suppressed by marker text alone.

The MVP does not implement high-volume event-storm budgets, global rate limits,
or route-level cooldown/coalescing. Keep configured sources bounded for personal
deployment volume; richer safety budgets are future work.

## Example

```json
{
  "plugins": {
    "entries": {
      "async-result-router": {
        "enabled": true,
        "config": {
          "pollIntervalMs": 60000,
          "sources": [
            {
              "id": "github-monitor",
              "type": "command",
              "command": "python3",
              "args": ["workspace/ops/github-monitor/check.py", "--json"],
              "sourceType": "github",
              "trustLevel": "trusted_structured"
            },
            {
              "id": "mail-routes",
              "type": "mailState",
              "path": "workspace/ops/mail/state.json"
            },
            {
              "id": "companion-notifications",
              "type": "notificationLog",
              "path": "workspace/.openclaw/async-result-router/notifications"
            }
          ],
          "webhook": {
            "enabled": true,
            "trustLevel": "semi_trusted"
          },
          "wake": {
            "enabled": true,
            "dryRun": false,
            "mode": "now"
          },
          "state": {
            "backend": "file"
          }
        }
      }
    }
  }
}
```

## Smoke Test

```bash
npm --prefix extensions/async-result-router run smoke
```

The smoke test creates temporary GitHub-style events, routes two active
unexpired events, verifies expired/paused/ambiguous routes do not wake sessions,
suppresses a self-generated notification, records an ack/outcome, and exercises
route registration/list/close.

## CLI

```bash
oc-async-router routes register --config config.json --route route.json --session-key agent:main:main
oc-async-router routes list --config config.json
oc-async-router routes close --config config.json --id github-owner-repo-pr-123 --reason complete
oc-async-router inspect --state workspace/.openclaw/async-result-router/state.json --status ambiguous
```
