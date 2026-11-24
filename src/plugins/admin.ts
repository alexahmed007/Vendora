import { config } from '../config.js';
import { definePlugin } from '../core/plugin.js';
import { rssMb } from '../core/memoryGuard.js';
import { createTenant, getTenant, listTenants, patchTenant } from '../store/tenants.js';

const DAY = 86_400_000;

const HELP = [
  '*Admin commands*',
  '.admin add <id> <number> [label] [days]',
  '.admin list',
  '.admin status',
  '.admin pause <id>',
  '.admin resume <id>',
  '.admin extend <id> <days>',
  '.admin restart <id>',
].join('\n');

const asDays = (v: string | undefined): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n <= 3650 ? n : null;
};

export default definePlugin({
  name: 'admin',
  priority: 5,
  commands: [
    {
      name: 'admin',
      access: 'admin', // only the owner of the control tenant; anyone else is ignored silently
      description: 'Manage customers (platform admin)',
      cooldownMs: 500,
      run: async (c) => {
        const { sessions } = c.services;
        const [sub = '', ...a] = c.args;

        switch (sub.toLowerCase()) {
          case 'add': {
            const [id, number, label, days] = a;
            if (!id || !number) return void (await c.reply(HELP));
            const trial = days === undefined ? null : asDays(days);
            if (days !== undefined && trial === null) return void (await c.reply('Days must be a number from 1 to 3650.'));
            const tenant = await createTenant({ id: id.toLowerCase(), number, label, expiresAt: trial ? Date.now() + trial * DAY : null });
            await sessions.start(tenant);
            await c.reply(`✅ Added *${tenant.id}* (${tenant.number}). A pairing code will arrive in this chat shortly. Send it to the customer: WhatsApp → Linked devices → Link with phone number.`);
            return;
          }

          case 'list': {
            const all = await listTenants();
            if (!all.length) return void (await c.reply('No customers yet.'));
            const lines = all.map((t) => {
              const live = sessions.get(t.id)?.state ?? 'not running';
              const exp = t.expiresAt ? new Date(t.expiresAt).toISOString().slice(0, 10) : 'no expiry';
              return `• *${t.id}* · ${t.status} · ${live} · ${exp}${t.label ? ` · ${t.label}` : ''}`;
            });
            await c.reply(lines.join('\n'));
            return;
          }

          case 'status': {
            const running = sessions.list();
            await c.reply(
              `Memory: ${rssMb()}MB (soft ${config.memSoftMb} / hard ${config.memHardMb})\nSessions: ${running.length}/${config.maxSessions}\n` +
                running.map((x) => `• ${x.id}: ${x.state}`).join('\n'),
            );
            return;
          }

          case 'pause': {
            const [id] = a;
            const t = id ? await getTenant(id) : null;
            if (!t) return void (await c.reply('Unknown customer id.'));
            if (t.number === config.adminNumber) return void (await c.reply('You can’t pause the control tenant: it runs this chat.'));
            await sessions.halt(t.id, 'paused');
            await c.reply(`⏸️ ${t.id} paused.`);
            return;
          }

          case 'resume':
          case 'restart': {
            const [id] = a;
            const t = id ? await getTenant(id) : null;
            if (!t) return void (await c.reply('Unknown customer id.'));
            if (sub.toLowerCase() === 'restart') await sessions.stop(t.id);
            await patchTenant(t.id, { status: 'active' });
            const started = await sessions.start({ ...t, status: 'active' });
            await c.reply(started ? `▶️ ${t.id} started.` : `Could not start ${t.id} (at capacity or memory guard closed). Try .admin status.`);
            return;
          }

          case 'extend': {
            const [id, days] = a;
            const t = id ? await getTenant(id) : null;
            const n = asDays(days);
            if (!t || n === null) return void (await c.reply(HELP));
            const base = t.expiresAt && t.expiresAt > Date.now() ? t.expiresAt : Date.now();
            const expiresAt = base + n * DAY;
            await patchTenant(t.id, { expiresAt, ...(t.status === 'expired' ? { status: 'active' as const } : {}) });
            await c.reply(`📅 ${t.id} now runs until ${new Date(expiresAt).toISOString().slice(0, 10)}.${t.status === 'expired' ? ' Use .admin resume to start it.' : ''}`);
            return;
          }

          default:
            await c.reply(HELP);
        }
      },
    },
  ],
});
