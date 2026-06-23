import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolvePath } from "./config.mjs";
import { readJsonFile, stableHash } from "./store.mjs";

export async function collectSourceEvents(source, config, logger) {
  if (source.type === "file") return collectFileEvents(source, config);
  if (source.type === "mailState") return collectMailStateEvents(source, config);
  if (source.type === "command") return collectCommandEvents(source, config, logger);
  if (source.type === "notificationLog") return collectNotificationLogEvents(source, config);
  logger?.warn?.(`[async-result-router] unknown source type: ${source.type}`);
  return [];
}

function normalizeRawEvent(raw, source, defaults = {}) {
  const payload = raw && typeof raw === "object" ? raw : { value: raw };
  return {
    ...payload,
    source: source.id,
    sourceType: payload.sourceType || defaults.sourceType || source.sourceType || source.type,
    trustLevel: payload.trustLevel || defaults.trustLevel || source.trustLevel || "semi_trusted",
    sourceId: payload.sourceId || payload.id || `${source.id}:${stableHash(payload)}`,
    type: payload.type || defaults.type || "external_event",
    payload,
  };
}

async function collectFileEvents(source, config) {
  const filePath = resolvePath(source.path || source.file || source.dir, config.baseDir);
  if (!filePath || !fs.existsSync(filePath)) return [];
  const stat = fs.statSync(filePath);
  const files = stat.isDirectory()
    ? fs.readdirSync(filePath)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => path.join(filePath, name))
    : [filePath];
  const events = [];
  for (const entryPath of files) {
    const parsed = readJsonFile(entryPath, null);
    const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.events) ? parsed.events : [parsed];
    for (const row of rows.filter(Boolean)) {
      events.push(normalizeRawEvent(row, source, { sourceType: source.sourceType || "file" }));
    }
  }
  return events;
}

async function collectNotificationLogEvents(source, config) {
  const filePath = resolvePath(source.path || source.file || source.dir, config.baseDir);
  if (!filePath || !fs.existsSync(filePath)) return [];
  const stat = fs.statSync(filePath);
  const files = stat.isDirectory()
    ? fs.readdirSync(filePath)
      .filter((name) => name.endsWith(".json") || name.endsWith(".jsonl"))
      .sort()
      .map((name) => path.join(filePath, name))
    : [filePath];
  const rows = [];
  for (const entryPath of files) {
    if (entryPath.endsWith(".jsonl")) {
      const text = fs.readFileSync(entryPath, "utf8");
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        rows.push(JSON.parse(line));
      }
    } else {
      const parsed = readJsonFile(entryPath, null);
      rows.push(...(Array.isArray(parsed) ? parsed : Array.isArray(parsed?.notifications) ? parsed.notifications : [parsed]));
    }
  }
  return rows.filter(Boolean).map((row) => {
    const title = row.title || row.notificationTitle || row["req.titl"] || "";
    const body = row.body || row.text || row.notificationText || row["req.body"] || "";
    const app = row.app || row.packageName || row.package || row.bundleId || row.identifier || "";
    return normalizeRawEvent({
      sourceType: "notification",
      sourceId: row.sourceId || row.id || row.notificationId || row.rec_id || `${app}:${row.postedAt || row.deliveredAt || ""}:${title}:${body}`,
      type: "notification_forwarded",
      app,
      packageName: row.packageName || row.package || row.bundleId || "",
      title,
      body,
      summary: row.summary || [app, title, body].filter(Boolean).join(" | "),
      observedAt: row.observedAt || row.postedAt || row.deliveredAt || row.time || undefined,
      payload: row,
    }, source, { sourceType: "notification" });
  });
}

async function collectMailStateEvents(source, config) {
  const statePath = resolvePath(source.path || "workspace/ops/mail/state.json", config.baseDir);
  const state = readJsonFile(statePath, null);
  if (!state?.threads || typeof state.threads !== "object") return [];
  const onlyWithRouteId = source.onlyWithRouteId !== false;
  return Object.entries(state.threads)
    .filter(([, item]) => item && typeof item === "object")
    .filter(([, item]) => !onlyWithRouteId || item.routeId)
    .map(([key, item]) => {
      const sourceType = key.includes(":") ? key.split(":")[0] : "mail";
      return normalizeRawEvent({
        sourceId: key,
        sourceType,
        routeId: item.routeId || null,
        type: "mail_state_thread",
        subject: item.subject || "",
        summary: item.reason || item.subject || "",
        observedAt: item.processedAt || state.lastCheckAt || undefined,
        wakeTarget: item.wakeTarget || null,
        payload: { ...item, sourceKey: key },
      }, source, { sourceType });
    });
}

async function collectCommandEvents(source, config, logger) {
  if (!source.command) return [];
  const cwd = resolvePath(source.cwd || ".", config.baseDir);
  const timeoutMs = Number.isFinite(Number(source.timeoutMs)) ? Number(source.timeoutMs) : 30_000;
  const result = await runCommand(source.command, Array.isArray(source.args) ? source.args : [], { cwd, timeoutMs });
  if (result.code !== 0) {
    logger?.warn?.(`[async-result-router] command source ${source.id} exited ${result.code}: ${result.stderr.trim()}`);
    return [];
  }
  const text = result.stdout.trim();
  if (!text) return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    logger?.warn?.(`[async-result-router] command source ${source.id} did not return JSON: ${err.message}`);
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed.events) ? parsed.events : [parsed];
  return rows.filter(Boolean).map((row) => normalizeRawEvent(row, source, {
    sourceType: source.sourceType || "command",
    type: source.eventType || "command_event",
  }));
}

function runCommand(command, args, opts) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, opts.timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: stderr || err.message });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? (signal ? 124 : 1), stdout, stderr });
    });
  });
}
