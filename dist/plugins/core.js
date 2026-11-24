import { definePlugin } from '../core/plugin.js';
import { rssMb } from '../core/memoryGuard.js';
export default definePlugin({
    name: 'core',
    priority: 10,
    commands: [
        {
            name: 'ping',
            description: 'Check that the bot is alive',
            run: async (c) => {
                await c.reply(`pong · ${c.ctx.id} · ${rssMb()}MB`);
            },
        },
        {
            name: 'help',
            aliases: ['commands'],
            description: 'List the commands you can use',
            run: async (c) => {
                const lines = c.services
                    .commandsFor(c)
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map((cmd) => `• ${c.prefix}${cmd.name}${cmd.description ? ` — ${cmd.description}` : ''}`);
                await c.reply(`*Commands*\n${lines.join('\n')}`);
            },
        },
    ],
});
