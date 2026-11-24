import type { SessionManager } from './sessionManager.js';
import type { TenantContext } from './tenantContext.js';
import type { IncomingMessage } from './message.js';

/** Shared services every plugin can reach through the message it receives. */
export interface Services {
  sessions: SessionManager;
  /** Commands the sender of `m` is allowed to run (for .help). Filled in by the host. */
  commandsFor(m: IncomingMessage): Command[];
}

export interface CommandContext extends IncomingMessage {
  args: string[];
  prefix: string;
  commandName: string;
}

export interface Command {
  name: string;
  aliases?: string[];
  description?: string;
  /**
   * Who may run it:
   *  - 'owner'  (default) the reseller and their sudo numbers
   *  - 'admin'  the platform admin, on the control tenant only
   *  - 'anyone' everyone (use sparingly: customers can reach it)
   * A command run by someone without access is ignored silently and the message is handled as
   * a normal message instead, so customers never learn which commands exist.
   */
  access?: 'owner' | 'admin' | 'anyone';
  groupOnly?: boolean;
  privateOnly?: boolean;
  cooldownMs?: number;
  run(c: CommandContext): Promise<void>;
}

export interface Schedule {
  name: string;
  everyMs: number;
  /** Run even while the tenant's socket is down (default: skipped while offline). */
  runWhenOffline?: boolean;
  run(ctx: TenantContext): Promise<void>;
}

export interface Plugin {
  name: string;
  /** Hook order: lower runs first (default 100). E.g. ingestion before AI customer care. */
  priority?: number;
  commands?: Command[];
  /** Once per tenant runtime, when its first socket appears. Keep `ctx`, not the socket. */
  onTenantStart?(ctx: TenantContext): Promise<void> | void;
  /** When the tenant is stopped, halted or the process shuts down. */
  onTenantStop?(ctx: TenantContext): void;
  /** Every incoming message that wasn't consumed as a command. Return true to stop later hooks. */
  onMessage?(m: IncomingMessage): Promise<boolean | void> | boolean | void;
  /** Timers owned by the host: one per tenant, staggered, overlap-safe, cleaned up automatically. */
  schedules?: Schedule[];
}

export const definePlugin = (plugin: Plugin): Plugin => plugin;
