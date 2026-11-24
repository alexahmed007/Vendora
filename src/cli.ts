// Must stay the first import: it loads .env so the CLI and the bot always use the same database.
import './config.js';
import { createTenant, listTenants, patchTenant, getTenant } from './store/tenants.js';

const [cmd, ...args] = process.argv.slice(2);

const usage = `Usage:
  npm run cli -- add <id> <number> [label] [days]   add a tenant (status: pending, pairs on next boot)
  npm run cli -- list                               show all tenants
  npm run cli -- pause <id>                         stop a tenant from starting
  npm run cli -- resume <id>                        allow a paused tenant to start again
  npm run cli -- extend <id> <days>                 push the plan expiry out by N days
`;

async function main(): Promise<void> {
  switch (cmd) {
    case 'add': {
      const [id, number, label, days] = args;
      if (!id || !number) return console.log(usage);
      const expiresAt = days ? Date.now() + Number(days) * 86_400_000 : null;
      const t = await createTenant({ id, number, label, expiresAt });
      console.log(`Added ${t.id}. Start the bot; a pairing code will print for ${t.number}.`);
      return;
    }
    case 'list': {
      const all = await listTenants();
      if (!all.length) return console.log('No tenants yet.');
      for (const t of all) {
        const exp = t.expiresAt ? new Date(t.expiresAt).toISOString().slice(0, 10) : 'never';
        console.log(`${t.id.padEnd(14)} ${t.status.padEnd(13)} plan=${t.plan.padEnd(8)} expires=${exp}  ${t.label ?? ''}`);
      }
      return;
    }
    case 'pause':
    case 'resume': {
      const [id] = args;
      if (!id || !(await getTenant(id))) return console.log('Unknown tenant id.');
      await patchTenant(id, { status: cmd === 'pause' ? 'paused' : 'active' });
      console.log(`${id}: ${cmd}d`);
      return;
    }
    case 'extend': {
      const [id, days] = args;
      const t = id ? await getTenant(id) : null;
      if (!t || !days) return console.log(usage);
      const base = t.expiresAt && t.expiresAt > Date.now() ? t.expiresAt : Date.now();
      await patchTenant(id, { expiresAt: base + Number(days) * 86_400_000, status: t.status === 'expired' ? 'active' : t.status });
      console.log(`${id}: extended by ${days} days`);
      return;
    }
    default:
      console.log(usage);
  }
}

await main().catch((e: Error) => {
  console.error(e.message);
  process.exitCode = 1;
});
process.exit(process.exitCode ?? 0); // close DB pools so the CLI exits
