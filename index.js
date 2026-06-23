import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { resolveRouterConfig } from "./src/config.mjs";
import { createWebhookHandler } from "./src/http.mjs";
import { createAsyncResultRouterService } from "./src/service.mjs";
import { createAsyncResultRouterTools } from "./src/tools.mjs";

const PLUGIN_ID = "async-result-router";

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Async Result Router",
  description: "Durable async result routing and session wake service for OpenClaw",
  register(api) {
    const config = resolveRouterConfig(api.pluginConfig || {}, {
      openclawHome: process.env.OPENCLAW_HOME || process.cwd(),
    });
    const service = createAsyncResultRouterService({
      pluginConfig: api.pluginConfig,
      runtime: api.runtime,
      logger: api.logger,
    });

    api.registerService({
      id: `${PLUGIN_ID}-watcher`,
      start: (ctx) => service.start(ctx),
      stop: (ctx) => service.stop(ctx),
    });

    api.registerTool((context) => createAsyncResultRouterTools({
      config,
      runtime: api.runtime,
      context,
      logger: api.logger,
    }), {
      names: [
        "async_result_router_register_route",
        "async_result_router_list_routes",
        "async_result_router_close_route",
        "async_result_router_ack_event",
        "async_result_router_record_outcome",
        "async_result_router_inspect_state",
      ],
    });

    if (config.webhook.enabled) {
      api.registerHttpRoute({
        path: config.webhook.path,
        auth: config.webhook.auth,
        match: "exact",
        handler: createWebhookHandler({
          config,
          runtime: api.runtime,
          logger: api.logger,
        }),
      });
    }
  },
});
