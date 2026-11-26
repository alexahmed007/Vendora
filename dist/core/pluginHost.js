import { readdirSync } from 'node:fs';
import { config } from '../config.js';
import { attachRouter } from './router.js';
import { TtlCache } from './ttlCache.js';
/**
 * Loads plugins and wires them to tenants.
 *
 * Dispatch order for each message:
 *   1. a command, if the text starts with the prefix, matches a command, and the sender has access
 *   2. otherwise every plugin's onMessage hook in priority order, until one returns true
 *
 * Plugins are loaded with dynamic import(), so ESM plugins never hit a require() wall.
 * (No hot reload: ESM caches modules by URL, so redeploy to change a plugin.)
 */
export class PluginHost {
    services;
    plugins = [];
    commands = new Map();
    tenants = new Map();
    cooldowns = new TtlCache(60_000, 5_000);
    constructor(services) {
        this.services = { ...services, commandsFor: (m) => this.commandsFor(m) };
    }
    // ── registration ────────────────────────────────────────────────────────
    register(plugin) {
        if (this.plugins.some((p) => p.name === plugin.name))
            throw new Error(`duplicate plugin "${plugin.name}"`);
        for (const command of plugin.commands ?? []) {
            for (const name of [command.name, ...(command.aliases ?? [])].map((n) => n.toLowerCase())) {
                const clash = this.commands.get(name);
                if (clash)
                    throw new Error(`command "${name}" in ${plugin.name} clashes with ${clash.plugin.name}`);
                this.commands.set(name, { plugin, command });
            }
        }
        this.plugins.push(plugin);
        this.plugins.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
    }
    /** Import every compiled plugin (*.js) in a directory. `dir` must be a URL ending in "/". */
    async loadFromDir(dir) {
        for (const file of readdirSync(dir).filter((f) => f.endsWith('.js')).sort()) {
            const mod = await import(new URL(file, dir).href);
            const plugin = (mod.default ?? mod.plugin);
            if (!plugin?.name) {
                console.warn(`[plugins] ${file} has no default-exported plugin, skipped`);
                continue;
            }
            this.register(plugin);
            console.log(`[plugins] loaded ${plugin.name}`);
        }
    }
    /** Commands this sender could run, for .help. */
    commandsFor(m) {
        const seen = new Set();
        for (const { command } of this.commands.values())
            if (this.allowed(command, m))
                seen.add(command);
        return [...seen];
    }
    // ── wiring to the session manager ───────────────────────────────────────
    bind(sessions) {
        sessions.on('socket', (ctx, sock) => this.onSocket(ctx, sock));
        sessions.on('released', (ctx) => this.stopTenant(ctx));
    }
    /** A fresh socket exists for this tenant. Public so tests can drive it without a SessionManager. */
    onSocket(ctx, sock) {
        attachRouter(this, ctx, sock);
        for (const plugin of this.plugins) {
            try {
                plugin.onSocket?.(ctx, sock);
            }
            catch (e) {
                ctx.log.error(`${plugin.name}.onSocket: ${e.message}`);
            }
        }
        this.startTenant(ctx);
    }
    startTenant(ctx) {
        if (this.tenants.get(ctx.id)?.ctx === ctx)
            return; // reconnect: same runtime, already started
        const runtime = { ctx, timers: [] };
        this.tenants.set(ctx.id, runtime);
        for (const plugin of this.plugins) {
            try {
                void Promise.resolve(plugin.onTenantStart?.(ctx)).catch((e) => ctx.log.error(`${plugin.name}.onTenantStart: ${e?.message ?? e}`));
            }
            catch (e) {
                ctx.log.error(`${plugin.name}.onTenantStart: ${e.message}`);
            }
            for (const schedule of plugin.schedules ?? []) {
                let running = false; // overlap guard: a slow run never stacks on itself
                const tick = async () => {
                    if (running)
                        return;
                    if (!schedule.runWhenOffline && !ctx.online)
                        return;
                    running = true;
                    try {
                        await schedule.run(ctx);
                    }
                    catch (e) {
                        ctx.log.error(`${plugin.name}/${schedule.name}: ${e.message}`);
                    }
                    finally {
                        running = false;
                    }
                };
                // Stagger the first run so many tenants don't all fire on the same second.
                const first = setTimeout(() => {
                    void tick();
                    const every = setInterval(() => void tick(), schedule.everyMs);
                    every.unref();
                    runtime.timers.push(every);
                }, Math.random() * Math.min(schedule.everyMs, 30_000));
                first.unref();
                runtime.timers.push(first);
            }
        }
    }
    stopTenant(ctx) {
        const runtime = this.tenants.get(ctx.id);
        if (!runtime || runtime.ctx !== ctx)
            return;
        for (const t of runtime.timers) {
            clearTimeout(t);
            clearInterval(t);
        }
        this.tenants.delete(ctx.id);
        for (const plugin of this.plugins) {
            try {
                plugin.onTenantStop?.(ctx);
            }
            catch (e) {
                ctx.log.error(`${plugin.name}.onTenantStop: ${e.message}`);
            }
        }
    }
    // ── dispatch ────────────────────────────────────────────────────────────
    async dispatch(m) {
        const parsed = this.parseCommand(m);
        if (parsed && this.allowed(parsed.entry.command, m)) {
            await this.runCommand(parsed.entry.command, parsed.name, parsed.args, m);
            return;
        }
        for (const plugin of this.plugins) {
            if (!plugin.onMessage)
                continue;
            try {
                if ((await plugin.onMessage(m)) === true)
                    return;
            }
            catch (e) {
                m.ctx.log.error(`${plugin.name}.onMessage: ${e.message}`);
            }
        }
    }
    parseCommand(m) {
        const text = m.text.trim();
        if (!text.startsWith(config.prefix))
            return null;
        const [head, ...args] = text.slice(config.prefix.length).trim().split(/\s+/);
        const name = (head ?? '').toLowerCase();
        const entry = this.commands.get(name);
        return entry ? { entry, name, args } : null;
    }
    allowed(command, m) {
        const access = command.access ?? 'owner';
        if (access === 'owner' && !m.isOwner)
            return false;
        if (access === 'admin' && !m.isPlatformAdmin)
            return false;
        if (command.groupOnly && !m.isGroup)
            return false;
        if (command.privateOnly && m.isGroup)
            return false;
        return true;
    }
    async runCommand(command, name, args, m) {
        const key = `${m.ctx.id}|${m.userId}|${command.name}`;
        const now = Date.now();
        const until = this.cooldowns.get(key);
        if (until && until > now)
            return;
        this.cooldowns.set(key, now + (command.cooldownMs ?? config.commandCooldownMs));
        const exec = async () => {
            try {
                await command.run({ ...m, args, prefix: config.prefix, commandName: name });
            }
            catch (e) {
                m.ctx.log.error(`command ${command.name}: ${e.stack ?? e}`);
                // Only the owner sees error text; customers never get internals.
                if (m.isOwner)
                    await m.reply(`⚠️ ${command.name} failed: ${e.message}`).catch(() => undefined);
            }
        };
        if (command.interactive)
            void exec();
        else
            await exec();
    }
}
