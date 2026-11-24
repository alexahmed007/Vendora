import { BufferJSON, initAuthCreds, proto } from '@whiskeysockets/baileys';
import type { AuthenticationCreds, SignalDataTypeMap } from '@whiskeysockets/baileys';
import { getAdapter } from '../store/pluginStore.js';
import { tenantStore } from '../store/tenantStore.js';

const encode = (value: unknown): string => JSON.stringify(value, BufferJSON.replacer);
const decode = (raw: string): any => JSON.parse(raw, BufferJSON.reviver);

/**
 * Baileys auth state for one tenant, persisted through the same adapters as
 * everything else (Mongo / Postgres / MySQL / SQLite / files).
 *
 * Values are stored as BufferJSON strings, because Buffers do not survive plain
 * JSON or BSON round-trips.
 *
 * IMPORTANT: this talks to the adapter directly instead of through createStore().
 * createStore().get() swallows errors and returns null, and for credentials a
 * swallowed read error would look like "no session yet" and mint brand-new
 * credentials, which silently unlinks the customer's WhatsApp. Here a failed
 * read throws, the session manager retries with backoff, and nothing is lost.
 */
export async function useStoreAuthState(tenantId: string) {
  const adapter = await getAdapter();
  const table = tenantStore(tenantId, 'auth').physicalTable;

  const read = async (key: string): Promise<any | null> => {
    const raw = await adapter.get(table, key);
    return raw === null || raw === undefined ? null : decode(raw);
  };
  const write = (key: string, value: unknown): Promise<void> => adapter.set(table, key, encode(value));
  const remove = (key: string): Promise<void> => adapter.del(table, key);

  const creds: AuthenticationCreds = (await read('creds')) ?? initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
          const data: { [id: string]: SignalDataTypeMap[T] } = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await read(`${type}-${id}`);
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            }),
          );
          return data;
        },
        set: async (data: { [T in keyof SignalDataTypeMap]?: { [id: string]: SignalDataTypeMap[T] | null } }) => {
          const tasks: Promise<void>[] = [];
          for (const category of Object.keys(data) as Array<keyof SignalDataTypeMap>) {
            const bucket = data[category] ?? {};
            for (const id of Object.keys(bucket)) {
              const value = bucket[id];
              const key = `${category}-${id}`;
              tasks.push(value ? write(key, value) : remove(key));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: (): Promise<void> => write('creds', creds),
    /** Wipe every stored key for this tenant (used after a WhatsApp logout). */
    clear: async (): Promise<void> => {
      const all = await adapter.getAll(table);
      await Promise.all(Object.keys(all).map(remove));
    },
  };
}

export type StoreAuthState = Awaited<ReturnType<typeof useStoreAuthState>>;
