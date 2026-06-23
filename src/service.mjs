import { resolveRouterConfig } from "./config.mjs";
import { pollOnce } from "./router.mjs";

export function createAsyncResultRouterService({ pluginConfig = {}, runtime = null, logger = console } = {}) {
  let timer = null;
  let running = false;
  let stopped = false;

  async function run(config) {
    if (running || stopped) return;
    running = true;
    try {
      const result = await pollOnce({ config, runtime, logger });
      if (result.newEventCount || result.dispatchedWakeCount) {
        logger?.info?.(`[async-result-router] observed=${result.observedCount} routed=${result.newEventCount} wake=${result.dispatchedWakeCount}`);
      }
    } catch (err) {
      logger?.warn?.(`[async-result-router] poll failed: ${err?.message || String(err)}`);
    } finally {
      running = false;
    }
  }

  return {
    async start(ctx = {}) {
      const config = resolveRouterConfig(pluginConfig, {
        openclawHome: process.env.OPENCLAW_HOME || process.cwd(),
        workspaceDir: ctx.workspaceDir,
      });
      if (!config.enabled) {
        logger?.info?.("[async-result-router] disabled");
        return;
      }
      stopped = false;
      await run(config);
      timer = setInterval(() => {
        run(config);
      }, config.pollIntervalMs);
      if (typeof timer.unref === "function") timer.unref();
      logger?.info?.(`[async-result-router] watcher started interval=${config.pollIntervalMs}ms sources=${config.sources.length}`);
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      logger?.info?.("[async-result-router] watcher stopped");
    },
  };
}
