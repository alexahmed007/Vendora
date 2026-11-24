import { config } from '../config.js';

interface GuardHooks {
  /** Called when RSS crosses the soft limit (true) or falls back under it (false). */
  onPressure: (underPressure: boolean) => void;
  /** Called once when RSS crosses the hard limit. Shut down cleanly and let the host restart us. */
  onCritical: () => Promise<void> | void;
}

export const rssMb = (): number => Math.round(process.memoryUsage().rss / 1024 / 1024);

/**
 * Two-level watchdog.
 *  - soft limit: stop admitting new sessions and try a GC (if --expose-gc is on).
 *  - hard limit: ask the host process to shut down gracefully.
 *
 * The old single-bot watchdog exited at one fixed RSS value. With several tenants in
 * one process that would drop every customer at once, so the soft level comes first.
 */
export function startMemoryGuard(hooks: GuardHooks): () => void {
  let pressure = false;
  let critical = false;

  const timer = setInterval(() => {
    const used = rssMb();

    if (used >= config.memHardMb && !critical) {
      critical = true;
      console.error(`[memory] ${used}MB >= hard limit ${config.memHardMb}MB, shutting down gracefully`);
      void hooks.onCritical();
      return;
    }

    const nowPressure = used >= config.memSoftMb;
    if (nowPressure !== pressure) {
      pressure = nowPressure;
      console.warn(`[memory] ${used}MB, ${pressure ? 'above' : 'back under'} soft limit ${config.memSoftMb}MB`);
      hooks.onPressure(pressure);
    }
    if (pressure) (globalThis as { gc?: () => void }).gc?.();
  }, 30_000);
  timer.unref();

  return () => clearInterval(timer);
}
