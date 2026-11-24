import { config } from '../config.js';
import { buildIncoming } from './message.js';
import type { PluginHost } from './pluginHost.js';
import type { TenantContext } from './tenantContext.js';

/** Never let one stuck handler freeze a tenant's whole message queue. */
function withTimeout(work: Promise<unknown>, ms: number, label: string): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.warn(`[router] ${label} still running after ${ms}ms, moving on`);
      resolve();
    }, ms);
    work.then(
      () => { clearTimeout(timer); resolve(); },
      (err) => { clearTimeout(timer); console.error(`[router] ${label} failed:`, err); resolve(); },
    );
  });
}

async function handle(host: PluginHost, ctx: TenantContext, sock: any, raw: any, appended: boolean): Promise<void> {
  const key = raw?.key;
  if (!key?.id || !key.remoteJid) return;

  // "append" = delivered while we were offline, or an echo of our own send. Keep only recent
  // messages from other people, so vendor posts missed during a restart are still ingested.
  if (appended && key.fromMe) return;

  // Per tenant, so two resellers in the same vendor group both process the same post.
  if (!ctx.firstSight(`${key.remoteJid}|${key.id}`)) return;

  const m = await buildIncoming(ctx, sock, host.services, raw, appended);
  if (!m) return;
  if (appended && Date.now() - m.timestamp > config.catchUpWindowMs) return;

  await host.dispatch(m);
}

/**
 * Attach the router to one socket. Messages are handled strictly in arrival order, one at a
 * time per tenant, which keeps vendor albums (several images, then a caption) in sequence.
 * Different tenants never wait on each other. The listener dies with the socket.
 */
export function attachRouter(host: PluginHost, ctx: TenantContext, sock: any): void {
  let chain: Promise<void> = Promise.resolve();

  sock.ev.on('messages.upsert', ({ messages, type }: any) => {
    if (type !== 'notify' && type !== 'append') return;
    for (const raw of messages ?? []) { // every message in the batch, not just the first
      chain = chain.then(() =>
        withTimeout(handle(host, ctx, sock, raw, type === 'append'), config.handlerTimeoutMs, `${ctx.id}/${raw?.key?.id}`),
      );
    }
  });
}
