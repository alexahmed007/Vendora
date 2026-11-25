import { config } from '../config.js';
import { definePlugin } from '../core/plugin.js';
import { rssMb } from '../core/memoryGuard.js';
import type { SessionManager } from '../core/sessionManager.js';
import { getAdapter } from '../store/pluginStore.js';
import { createTenant, getTenant, listTenants, patchTenant, type TenantRecord } from '../store/tenants.js';
import { appCtxFrom, askNumber, askValue, back, go, replace, runApp, stay, type ScreenMap } from '../ui/appUi.js';

const DAY = 86_400_000;
const PAGE = 6;

const HELP = [
  '*Admin*',
  '.admin            open the admin menu',
  '.admin add <id> <number> [label] [days]',
  '.admin list | status',
  '.admin pause|resume|restart <id>',
  '.admin extend <id> <days>',
].join('\n');

const asDays = (v: string | undefined): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n <= 3650 ? n : null;
};

const dateOf = (t: TenantRecord): string => (t.expiresAt ? new Date(t.expiresAt).toISOString().slice(0, 10) : 'no expiry');
const isControl = (t: TenantRecord): boolean => config.adminNumber !== '' && t.number === config.adminNumber;

/** Shared by the menu and the text commands, so both behave identically. */
async function addCustomer(sessions: SessionManager, id: string, number: string, label?: string, days?: number | null): Promise<TenantRecord> {
  const tenant = await createTenant({ id: id.toLowerCase(), number, label, expiresAt: days ? Date.now() + days * DAY : null });
  await sessions.start(tenant);
  return tenant;
}

async function startTenantAgain(sessions: SessionManager, t: TenantRecord, restart: boolean): Promise<boolean> {
  if (restart) await sessions.stop(t.id);
  await patchTenant(t.id, { status: 'active' });
  return Boolean(await sessions.start({ ...t, status: 'active' }));
}

// ── the admin menu (numbered, answered in your own chat) ─────────────────────

function adminScreens(sessions: SessionManager): ScreenMap {
  return {
    home: {
      async view() {
        const all = await listTenants();
        const by = (s: string) => all.filter((t) => t.status === s).length;
        return {
          title: 'Admin',
          subtitle: 'Platform control',
          text: [
            `Customers: ${all.length} (${by('active')} active · ${by('pending')} pending · ${by('needs_relink')} need re-link · ${by('paused')} paused · ${by('expired')} expired)`,
            `Sessions running: ${sessions.list().length}/${config.maxSessions} · Memory ${rssMb()}MB`,
          ].join('\n'),
          options: [
            { label: '👥 Customers', value: 'customers', description: 'Open, pause, extend, restart' },
            { label: '➕ Add customer', value: 'add', description: 'Creates them and sends you a pairing code' },
            { label: '📊 System', value: 'system' },
            { label: '🔄 Refresh', value: 'refresh' },
          ],
        };
      },
      async select(value, app) {
        if (value === 'customers') return go('customers', { page: 0 });
        if (value === 'system') return go('system');
        if (value !== 'add') return stay();

        const id = await askValue<string>(app, {
          prompt: 'Customer id: 2-24 lowercase letters or digits (e.g. acme)',
          parse: (t) => (/^[a-z0-9]{2,24}$/.test(t.toLowerCase()) ? t.toLowerCase() : null),
          hint: 'Use 2-24 lowercase letters or digits, no spaces.',
        });
        if (id === null) return stay('Cancelled.');
        if (await getTenant(id)) return stay(`⚠️ "${id}" already exists.`);

        const number = await askValue<string>(app, {
          prompt: 'Their WhatsApp number with country code, digits only (e.g. 2348012345678)',
          parse: (t) => {
            const d = t.replace(/\D/g, '');
            return d.length >= 8 && d.length <= 15 ? d : null;
          },
          hint: 'Send 8-15 digits, country code first.',
        });
        if (number === null) return stay('Cancelled.');

        const label = await askValue<string>(app, {
          prompt: 'Business name (or send - to skip)',
          parse: (t) => (t.length <= 60 ? (t === '-' ? '' : t) : null),
          hint: 'Keep it under 60 characters.',
        });
        if (label === null) return stay('Cancelled.');

        const days = await askNumber(app, 'Trial days (0 = no expiry)', 0, 3650);
        if (days === null) return stay('Cancelled.');

        const t = await addCustomer(sessions, id, number, label || undefined, days || null);
        return stay(`✅ Added *${t.id}*. A pairing code will arrive in this chat in a few seconds. Send it to them: WhatsApp → Linked devices → Link with phone number.`);
      },
    },

    customers: {
      async view(_app, params: { page: number }) {
        const all = (await listTenants()).sort((a, b) => a.id.localeCompare(b.id));
        const pages = Math.max(1, Math.ceil(all.length / PAGE));
        const page = Math.min(Math.max(0, params.page), pages - 1);
        const slice = all.slice(page * PAGE, page * PAGE + PAGE);
        const options = slice.map((t) => ({
          label: `${t.label || t.id} · ${t.status}`,
          value: `t:${t.id}`,
          description: `${sessions.get(t.id)?.state ?? 'not running'} · ${dateOf(t)}`,
        }));
        if (page > 0) options.push({ label: '⬅️ Previous page', value: `page:${page - 1}`, description: '' });
        if (page < pages - 1) options.push({ label: '➡️ Next page', value: `page:${page + 1}`, description: '' });
        return {
          title: 'Customers',
          text: all.length ? `Page ${page + 1} of ${pages} · ${all.length} total` : 'No customers yet. Go back and choose ➕ Add customer.',
          options,
        };
      },
      select(value) {
        if (value.startsWith('page:')) return replace('customers', { page: Number(value.slice(5)) });
        if (value.startsWith('t:')) return go('customer', { id: value.slice(2) });
        return stay();
      },
    },

    customer: {
      async view(_app, params: { id: string }) {
        const t = await getTenant(params.id);
        if (!t) return { title: 'Customer', text: 'This customer no longer exists.', options: [] };
        const live = sessions.get(t.id);
        const running = Boolean(live);
        const options = [];
        if (!isControl(t)) {
          options.push(running || t.status === 'active' ? { label: '⏸️ Pause', value: 'pause' } : { label: '▶️ Start / resume', value: 'resume' });
        }
        if (running) options.push({ label: '🔁 Restart session', value: 'restart' });
        options.push({ label: '📅 Extend 7 days', value: 'ext7' }, { label: '📅 Extend 30 days', value: 'ext30' });
        return {
          title: t.label || t.id,
          subtitle: `id ${t.id}`,
          text: [
            `Number: ${t.number}`,
            `Status: ${t.status} · session ${live?.state ?? 'not running'}`,
            `Plan: ${t.plan} · until ${dateOf(t)}`,
            t.status === 'needs_relink' ? '⚠️ They unlinked the device. Choose Start / resume to get a fresh pairing code.' : '',
          ].filter(Boolean).join('\n'),
          options,
        };
      },
      async select(value, app, params: { id: string }) {
        const t = await getTenant(params.id);
        if (!t) return back();
        switch (value) {
          case 'pause':
            if (isControl(t)) return stay('You can’t pause the control tenant: it runs this chat.');
            await sessions.halt(t.id, 'paused');
            return stay('⏸️ Paused.');
          case 'resume':
          case 'restart': {
            const ok = await startTenantAgain(sessions, t, value === 'restart');
            return stay(ok ? '▶️ Started. If they need to re-link, the pairing code will arrive here.' : '⚠️ Couldn’t start (at capacity or memory guard closed). Check System.');
          }
          case 'ext7':
          case 'ext30': {
            const n = value === 'ext7' ? 7 : 30;
            const base = t.expiresAt && t.expiresAt > Date.now() ? t.expiresAt : Date.now();
            await patchTenant(t.id, { expiresAt: base + n * DAY, ...(t.status === 'expired' ? { status: 'paused' as const } : {}) });
            return stay(`📅 Extended by ${n} days.${t.status === 'expired' ? ' Choose Start / resume to bring them back.' : ''}`);
          }
          default:
            return stay();
        }
      },
    },

    system: {
      async view() {
        const adapter = await getAdapter();
        return {
          title: 'System',
          text: [
            `Memory: ${rssMb()}MB (soft ${config.memSoftMb} · hard ${config.memHardMb})`,
            `Storage: ${adapter.name}`,
            `Sessions (${sessions.list().length}/${config.maxSessions}):`,
            ...sessions.list().map((c) => `• ${c.id}: ${c.state}`),
          ].join('\n'),
          options: [{ label: '🔄 Refresh', value: 'refresh' }],
        };
      },
      select: () => stay(),
    },
  };
}

export default definePlugin({
  name: 'admin',
  priority: 5,
  commands: [
    {
      name: 'admin',
      access: 'admin', // only the owner of the control tenant; anyone else is ignored silently
      description: 'Admin menu: customers and system (platform owner)',
      cooldownMs: 500,
      run: async (c) => {
        const { sessions } = c.services;
        const [sub = '', ...a] = c.args;

        // No subcommand: the numbered admin menu, always in your own chat.
        if (sub === '' || sub.toLowerCase() === 'menu') {
          const app = appCtxFrom(c);
          if (!c.isOwnChat) {
            app.chatId = c.ownChatId;
            app.message = undefined;
          }
          await runApp(app, adminScreens(sessions), 'home');
          return;
        }

        switch (sub.toLowerCase()) {
          case 'add': {
            const [id, number, label, days] = a;
            if (!id || !number) return void (await c.replyPrivate(HELP));
            const trial = days === undefined ? null : asDays(days);
            if (days !== undefined && trial === null) return void (await c.replyPrivate('Days must be a number from 1 to 3650.'));
            const tenant = await addCustomer(sessions, id, number, label, trial);
            await c.replyPrivate(`✅ Added *${tenant.id}* (${tenant.number}). A pairing code will arrive in this chat shortly. Send it to the customer: WhatsApp → Linked devices → Link with phone number.`);
            return;
          }

          case 'list': {
            const all = await listTenants();
            if (!all.length) return void (await c.replyPrivate('No customers yet.'));
            await c.replyPrivate(
              all.map((t) => `• *${t.id}* · ${t.status} · ${sessions.get(t.id)?.state ?? 'not running'} · ${dateOf(t)}${t.label ? ` · ${t.label}` : ''}`).join('\n'),
            );
            return;
          }

          case 'status': {
            const running = sessions.list();
            await c.replyPrivate(
              `Memory: ${rssMb()}MB (soft ${config.memSoftMb} / hard ${config.memHardMb})\nSessions: ${running.length}/${config.maxSessions}\n` +
                running.map((x) => `• ${x.id}: ${x.state}`).join('\n'),
            );
            return;
          }

          case 'pause': {
            const [id] = a;
            const t = id ? await getTenant(id) : null;
            if (!t) return void (await c.replyPrivate('Unknown customer id.'));
            if (isControl(t)) return void (await c.replyPrivate('You can’t pause the control tenant: it runs this chat.'));
            await sessions.halt(t.id, 'paused');
            await c.replyPrivate(`⏸️ ${t.id} paused.`);
            return;
          }

          case 'resume':
          case 'restart': {
            const [id] = a;
            const t = id ? await getTenant(id) : null;
            if (!t) return void (await c.replyPrivate('Unknown customer id.'));
            const ok = await startTenantAgain(sessions, t, sub.toLowerCase() === 'restart');
            await c.replyPrivate(ok ? `▶️ ${t.id} started.` : `Could not start ${t.id} (at capacity or memory guard closed). Try .admin status.`);
            return;
          }

          case 'extend': {
            const [id, days] = a;
            const t = id ? await getTenant(id) : null;
            const n = asDays(days);
            if (!t || n === null) return void (await c.replyPrivate(HELP));
            const base = t.expiresAt && t.expiresAt > Date.now() ? t.expiresAt : Date.now();
            const expiresAt = base + n * DAY;
            await patchTenant(t.id, { expiresAt, ...(t.status === 'expired' ? { status: 'active' as const } : {}) });
            await c.replyPrivate(`📅 ${t.id} now runs until ${new Date(expiresAt).toISOString().slice(0, 10)}.${t.status === 'expired' ? ' Use .admin resume to start it.' : ''}`);
            return;
          }

          default:
            await c.replyPrivate(HELP);
        }
      },
    },
  ],
});
