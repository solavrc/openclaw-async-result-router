import { ingestEvents } from "./router.mjs";

export function createWebhookHandler({ config, runtime, logger }) {
  return async function handleWebhook(req, res) {
    if (req.method !== "POST") {
      writeJson(res, 405, { error: "method_not_allowed" });
      return true;
    }
    try {
      const body = await readBody(req, 1024 * 1024);
      const parsed = body ? JSON.parse(body) : {};
      const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed.events) ? parsed.events : [parsed];
      const events = rows.filter(Boolean).map((row) => ({
        ...row,
        source: row.source || config.webhook.sourceId,
        sourceType: row.sourceType || config.webhook.sourceType,
        trustLevel: row.trustLevel || config.webhook.trustLevel,
      }));
      const result = await ingestEvents({ config, events, runtime, logger });
      writeJson(res, 202, {
        ok: true,
        observedCount: result.observedCount,
        routeCount: result.routeCount,
        newEventCount: result.newEventCount,
        ambiguousCount: result.ambiguousCount,
        suppressedCount: result.suppressedCount,
        wakeRequestCount: result.wakeRequestCount,
        dispatchedWakeCount: result.dispatchedWakeCount,
      });
    } catch (err) {
      writeJson(res, 400, { ok: false, error: err?.message || String(err) });
    }
    return true;
  };
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > maxBytes) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function writeJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(`${JSON.stringify(payload)}\n`);
}
