#!/usr/bin/env node
import fs from "node:fs";
import { resolveRouterConfig } from "../src/config.mjs";
import { pollOnce } from "../src/router.mjs";
import { closeStoredRoute, listAllRoutes, upsertStoredRoute } from "../src/route-store.mjs";
import { runSmokeTest } from "../src/smoke.mjs";
import { loadState, readJsonFile } from "../src/store.mjs";
import { inspectState } from "../src/tools.mjs";

function usage() {
  return `Usage:
  oc-async-router smoke [--keep]
  oc-async-router poll-once --config <config.json>
  oc-async-router show --state <state.json>
  oc-async-router inspect --state <state.json> [--status <status>] [--route-id <route-id>] [--event-id <event-id>]
  oc-async-router routes list --config <config.json> [--include-closed]
  oc-async-router routes register --config <config.json> --route <route.json> [--session-key <key>] [--agent-id <id>]
  oc-async-router routes close --config <config.json> --id <route-id> [--reason <text>]
`;
}

function readArg(name, args) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] || null;
}

async function main(argv) {
  const [command, ...args] = argv;
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(usage());
    return 0;
  }
  if (command === "smoke") {
    const result = await runSmokeTest({ keep: args.includes("--keep") });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  if (command === "poll-once") {
    const configPath = readArg("--config", args);
    if (!configPath) throw new Error("--config is required");
    const rawConfig = readJsonFile(configPath, {});
    const config = resolveRouterConfig(rawConfig);
    const result = await pollOnce({ config, logger: console });
    process.stdout.write(`${JSON.stringify({
      ...result,
      recorded: result.recorded.map((entry) => ({
        eventId: entry.event.id,
        routeId: entry.route.id,
        created: entry.created,
      })),
    }, null, 2)}\n`);
    return 0;
  }
  if (command === "show") {
    const statePath = readArg("--state", args);
    if (!statePath || !fs.existsSync(statePath)) throw new Error("--state must point to an existing state file");
    const state = loadState(statePath);
    process.stdout.write(`${JSON.stringify({
      statePath,
      workItems: Object.keys(state.workItems).length,
      events: Object.keys(state.events).length,
      wakeRequests: Object.keys(state.wakeRequests).length,
      deliveries: Object.keys(state.deliveries).length,
      outcomes: Object.keys(state.outcomes || {}).length,
      updatedAt: state.updatedAt,
    }, null, 2)}\n`);
    return 0;
  }
  if (command === "inspect") {
    const statePath = readArg("--state", args);
    if (!statePath || !fs.existsSync(statePath)) throw new Error("--state must point to an existing state file");
    const state = loadState(statePath);
    const result = inspectState(state, {
      status: readArg("--status", args),
      routeId: readArg("--route-id", args),
      eventId: readArg("--event-id", args),
      limit: readArg("--limit", args),
    });
    process.stdout.write(`${JSON.stringify({ statePath, ...result }, null, 2)}\n`);
    return 0;
  }
  if (command === "routes") {
    return routeCommand(args);
  }
  throw new Error(`unknown command: ${command}\n${usage()}`);
}

async function routeCommand(args) {
  const [subcommand, ...rest] = args;
  const config = readConfigFromArgs(rest);
  if (subcommand === "list") {
    const routes = listAllRoutes(config, { includeClosed: rest.includes("--include-closed") });
    process.stdout.write(`${JSON.stringify({ count: routes.length, routes }, null, 2)}\n`);
    return 0;
  }
  if (subcommand === "register") {
    const routePath = readArg("--route", rest);
    if (!routePath) throw new Error("--route is required");
    const route = readJsonFile(routePath, null);
    const result = upsertStoredRoute(config, route, {
      context: {
        agentId: readArg("--agent-id", rest),
        sessionKey: readArg("--session-key", rest),
      },
      replace: !rest.includes("--no-replace"),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  if (subcommand === "close") {
    const id = readArg("--id", rest);
    if (!id) throw new Error("--id is required");
    const result = closeStoredRoute(config, {
      id,
      reason: readArg("--reason", rest),
      status: readArg("--status", rest),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  throw new Error(`unknown routes subcommand: ${subcommand || "(none)"}\n${usage()}`);
}

function readConfigFromArgs(args) {
  const configPath = readArg("--config", args);
  if (!configPath) throw new Error("--config is required");
  return resolveRouterConfig(readJsonFile(configPath, {}));
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}).catch((err) => {
  console.error(err?.message || String(err));
  if (err?.result) console.error(JSON.stringify(err.result, null, 2));
  process.exitCode = 1;
});
