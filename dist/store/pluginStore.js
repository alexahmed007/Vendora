// @ts-nocheck
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import fs from 'fs';
import path from 'path';
const MONGO_URL = process.env.MONGO_URL;
const POSTGRES_URL = process.env.POSTGRES_URL;
const MYSQL_URL = process.env.MYSQL_URL;
const SQLITE_URL = process.env.DB_URL;
function sanitize(name) {
    return name.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
}
function physicalName(namespace, tableName) {
    return tableName ? `${sanitize(namespace)}_${sanitize(tableName)}` : sanitize(namespace);
}
let _adapter = null;
export function getAdapter() {
    if (!_adapter) {
        _adapter = _initAdapter().then((a) => {
            console.log(`[store] using ${a.name} backend${a.name === 'file' ? ' (./data, lost on redeploys: set MONGO_URL / POSTGRES_URL / MYSQL_URL / DB_URL for production)' : ''}`);
            return a;
        });
    }
    return _adapter;
}
async function _initAdapter() {
    // ── MongoDB ────────────────────────────────────────────────────────────────
    if (MONGO_URL) {
        try {
            const mongoose = require('mongoose');
            await new Promise((resolve, reject) => {
                if (mongoose.connection.readyState === 1)
                    return resolve();
                if (mongoose.connection.readyState === 2) {
                    mongoose.connection.once('connected', resolve);
                    mongoose.connection.once('error', reject);
                    return;
                }
                mongoose.connect(MONGO_URL).then(resolve).catch(reject);
            });
            const db = mongoose.connection.db;
            const verifiedTables = new Set();
            return {
                name: 'mongo',
                async ensureTable(table) {
                    if (verifiedTables.has(table))
                        return;
                    const list = await db.listCollections({ name: table }).toArray();
                    if (list.length === 0)
                        await db.createCollection(table);
                    verifiedTables.add(table);
                },
                async get(table, key) {
                    await this.ensureTable(table);
                    const doc = await db.collection(table).findOne({ _id: key });
                    return doc ? doc.value : null;
                },
                async set(table, key, value) {
                    await this.ensureTable(table);
                    await db.collection(table).updateOne({ _id: key }, { $set: { value, ts: Date.now() } }, { upsert: true });
                },
                async del(table, key) {
                    await this.ensureTable(table);
                    await db.collection(table).deleteOne({ _id: key });
                },
                async getAll(table) {
                    await this.ensureTable(table);
                    const docs = await db.collection(table).find({}).toArray();
                    const result = {};
                    for (const doc of docs)
                        result[doc._id] = doc.value;
                    return result;
                },
                async getAllWithMeta(table) {
                    await this.ensureTable(table);
                    const docs = await db.collection(table).find({}).toArray();
                    return docs.map((doc) => ({ key: doc._id, value: doc.value, ts: doc.ts ?? 0 }));
                }
            };
        }
        catch (e) {
            console.error('[pluginStore] MongoDB adapter initialization failed:', e.message);
        }
    }
    // ── PostgreSQL ─────────────────────────────────────────────────────────────
    if (POSTGRES_URL) {
        try {
            const { Pool } = require('pg');
            const pool = new Pool({
                connectionString: POSTGRES_URL,
                ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
                max: 20, // Expanded connection ceiling for multi-plugin safety
                idleTimeoutMillis: 30000,
            });
            const ready = new Set();
            const ensureTableInternal = async (table) => {
                if (ready.has(table))
                    return;
                const client = await pool.connect();
                try {
                    await client.query(`
            CREATE TABLE IF NOT EXISTS "${table}" (
              key   TEXT   NOT NULL PRIMARY KEY,
              value TEXT,
              ts    BIGINT NOT NULL DEFAULT 0
            )
          `);
                    ready.add(table);
                }
                finally {
                    client.release();
                }
            };
            return {
                name: 'postgres',
                async ensureTable(table) {
                    await ensureTableInternal(table);
                },
                async get(table, key) {
                    await ensureTableInternal(table);
                    const res = await pool.query(`SELECT value FROM "${table}" WHERE key=$1`, [key]);
                    return res.rows[0] ? JSON.parse(res.rows[0].value) : null;
                },
                async set(table, key, value) {
                    await ensureTableInternal(table);
                    await pool.query(`INSERT INTO "${table}"(key, value, ts) VALUES($1, $2, $3)
             ON CONFLICT (key) DO UPDATE SET value=$2, ts=$3`, [key, JSON.stringify(value), Date.now()]);
                },
                async del(table, key) {
                    await ensureTableInternal(table);
                    await pool.query(`DELETE FROM "${table}" WHERE key=$1`, [key]);
                },
                async getAll(table) {
                    await ensureTableInternal(table);
                    const res = await pool.query(`SELECT key, value FROM "${table}"`);
                    const result = {};
                    for (const row of res.rows)
                        result[row.key] = JSON.parse(row.value);
                    return result;
                },
                async getAllWithMeta(table) {
                    await ensureTableInternal(table);
                    const res = await pool.query(`SELECT key, value, ts FROM "${table}"`);
                    return res.rows.map((row) => ({ key: row.key, value: JSON.parse(row.value), ts: Number(row.ts) || 0 }));
                }
            };
        }
        catch (e) {
            console.error('[pluginStore] PostgreSQL adapter initialization failed:', e.message);
        }
    }
    // ── MySQL ──────────────────────────────────────────────────────────────────
    if (MYSQL_URL) {
        try {
            const mysql = require('mysql2/promise');
            // Using a pool instead of a raw single connection for concurrency protection
            const pool = mysql.createPool({
                uri: MYSQL_URL,
                waitForConnections: true,
                connectionLimit: 15,
                queueLimit: 0
            });
            const ready = new Set();
            const ensureTableInternal = async (table) => {
                if (ready.has(table))
                    return;
                await pool.execute(`
          CREATE TABLE IF NOT EXISTS \`${table}\` (
            \`key\`   VARCHAR(512) NOT NULL PRIMARY KEY,
            \`value\` LONGTEXT,
            \`ts\`    BIGINT NOT NULL DEFAULT 0
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
                ready.add(table);
            };
            return {
                name: 'mysql',
                async ensureTable(table) {
                    await ensureTableInternal(table);
                },
                async get(table, key) {
                    await ensureTableInternal(table);
                    const [rows] = await pool.execute(`SELECT \`value\` FROM \`${table}\` WHERE \`key\`=?`, [key]);
                    return rows[0] ? JSON.parse(rows[0].value) : null;
                },
                async set(table, key, value) {
                    await ensureTableInternal(table);
                    await pool.execute(`INSERT INTO \`${table}\`(\`key\`, \`value\`, \`ts\`) VALUES(?, ?, ?)
             ON DUPLICATE KEY UPDATE \`value\`=VALUES(\`value\`), \`ts\`=VALUES(\`ts\`)`, [key, JSON.stringify(value), Date.now()]);
                },
                async del(table, key) {
                    await ensureTableInternal(table);
                    await pool.execute(`DELETE FROM \`${table}\` WHERE \`key\`=?`, [key]);
                },
                async getAll(table) {
                    await ensureTableInternal(table);
                    const [rows] = await pool.execute(`SELECT \`key\`, \`value\` FROM \`${table}\``);
                    const result = {};
                    for (const row of rows) {
                        result[row.key] = JSON.parse(row.value);
                    }
                    return result;
                },
                async getAllWithMeta(table) {
                    await ensureTableInternal(table);
                    const [rows] = await pool.execute(`SELECT \`key\`, \`value\`, \`ts\` FROM \`${table}\``);
                    return rows.map(row => ({ key: row.key, value: JSON.parse(row.value), ts: Number(row.ts) || 0 }));
                }
            };
        }
        catch (e) {
            console.error('[pluginStore] MySQL adapter initialization failed:', e.message);
        }
    }
    // ── SQLite ─────────────────────────────────────────────────────────────────
    if (SQLITE_URL) {
        try {
            const Database = require('better-sqlite3');
            const sqlite = new Database(SQLITE_URL);
            sqlite.pragma('journal_mode = WAL');
            const ready = new Set();
            return {
                name: 'sqlite',
                async ensureTable(table) {
                    if (ready.has(table))
                        return;
                    sqlite.prepare(`
            CREATE TABLE IF NOT EXISTS "${table}" (
              key   TEXT NOT NULL PRIMARY KEY,
              value TEXT,
              ts    INTEGER NOT NULL DEFAULT 0
            )
          `).run();
                    ready.add(table);
                },
                async get(table, key) {
                    await this.ensureTable(table);
                    const row = sqlite.prepare(`SELECT value FROM "${table}" WHERE key=?`).get(key);
                    return row ? JSON.parse(row.value) : null;
                },
                async set(table, key, value) {
                    await this.ensureTable(table);
                    sqlite.prepare(`INSERT OR REPLACE INTO "${table}"(key, value, ts) VALUES(?, ?, ?)`).run(key, JSON.stringify(value), Date.now());
                },
                async del(table, key) {
                    await this.ensureTable(table);
                    sqlite.prepare(`DELETE FROM "${table}" WHERE key=?`).run(key);
                },
                async getAll(table) {
                    await this.ensureTable(table);
                    const rows = sqlite.prepare(`SELECT key, value FROM "${table}"`).all();
                    const result = {};
                    for (const row of rows)
                        result[row.key] = JSON.parse(row.value);
                    return result;
                },
                async getAllWithMeta(table) {
                    await this.ensureTable(table);
                    const rows = sqlite.prepare(`SELECT key, value, ts FROM "${table}"`).all();
                    return rows.map((row) => ({ key: row.key, value: JSON.parse(row.value), ts: Number(row.ts) || 0 }));
                }
            };
        }
        catch (e) {
            console.error('[pluginStore] SQLite adapter failed, falling back:', e.message);
        }
    }
    // ── File / memory fallback with Sequential Queue to prevent races ──────────
    const DATA_DIR = path.join(process.cwd(), 'data');
    if (!fs.existsSync(DATA_DIR))
        fs.mkdirSync(DATA_DIR, { recursive: true });
    const filePath = (table) => path.join(DATA_DIR, `${table}.json`);
    const fileQueues = new Map();
    const runSequentially = (table, task) => {
        const previous = fileQueues.get(table) || Promise.resolve();
        const next = previous.then(task, task); // keep execution moving even if tasks crash
        fileQueues.set(table, next);
        return next;
    };
    function readFile(table) {
        const fp = filePath(table);
        if (!fs.existsSync(fp))
            return {};
        try {
            return JSON.parse(fs.readFileSync(fp, 'utf-8'));
        }
        catch {
            return {};
        }
    }
    return {
        name: 'file',
        async ensureTable(_table) { },
        async get(table, key) {
            return runSequentially(table, () => readFile(table)[key] ?? null);
        },
        async set(table, key, value) {
            return runSequentially(table, () => {
                const data = readFile(table);
                data[key] = value;
                fs.writeFileSync(filePath(table), JSON.stringify(data, null, 2));
            });
        },
        async del(table, key) {
            return runSequentially(table, () => {
                const data = readFile(table);
                delete data[key];
                fs.writeFileSync(filePath(table), JSON.stringify(data, null, 2));
            });
        },
        async getAll(table) {
            return runSequentially(table, () => readFile(table));
        },
        async getAllWithMeta(table) {
            return runSequentially(table, () => {
                const data = readFile(table);
                return Object.entries(data).map(([key, value]) => ({ key, value, ts: 0 }));
            });
        }
    };
}
// ── Per-key mutex to prevent lost updates on concurrent read→modify→write ────
// get() and set() are independent round trips to the adapter — even the file
// adapter's per-table queue only serializes individual calls, not a get+set
// PAIR as one unit. Two concurrent callers can both read the same key before
// either has written back, and whichever set() lands last silently overwrites
// the other's change (e.g. a debit getting reverted by an unrelated identity
// sync that read the wallet a moment earlier). mutate() — and patch(), which
// is now built on it — hold a lock for the full read-modify-write cycle so
// concurrent callers on the same key are serialized instead of racing.
const keyLocks = new Map();
function withKeyLock(lockKey, task) {
    const previous = keyLocks.get(lockKey) || Promise.resolve();
    const next = previous.then(task, task); // keep the chain moving even if a task throws
    keyLocks.set(lockKey, next);
    // Release the entry once this task is the tail of the chain, so the map
    // doesn't grow by one entry per distinct key forever.
    const release = () => { if (keyLocks.get(lockKey) === next)
        keyLocks.delete(lockKey); };
    next.then(release, release);
    return next;
}
// ── Core store factory ────────────────────────────────────────────────────────
function makeStore(namespace, tableName, isRoot) {
    const physical = physicalName(namespace, tableName);
    const tag = `[pluginStore:${physical}]`;
    async function adapter() {
        return getAdapter();
    }
    const store = {
        async get(key) {
            try {
                const a = await adapter();
                return await a.get(physical, key);
            }
            catch (err) {
                console.error(`${tag} get("${key}"):`, err.message);
                return null;
            }
        },
        async set(key, value) {
            try {
                const a = await adapter();
                await a.set(physical, key, value);
            }
            catch (err) {
                console.error(`${tag} set("${key}"):`, err.message);
            }
        },
        async del(key) {
            try {
                const a = await adapter();
                await a.del(physical, key);
            }
            catch (err) {
                console.error(`${tag} del("${key}"):`, err.message);
            }
        },
        async getAll() {
            try {
                const a = await adapter();
                return await a.getAll(physical);
            }
            catch (err) {
                console.error(`${tag} getAll():`, err.message);
                return {};
            }
        },
        async has(key) {
            return (await this.get(key)) !== null;
        },
        async getOrDefault(key, defaultValue) {
            const value = await this.get(key);
            return value !== null ? value : defaultValue;
        },
        async patch(key, patch) {
            const lockKey = `${physical}::${key}`;
            await withKeyLock(lockKey, async () => {
                const a = await adapter();
                const existing = (await a.get(physical, key)) || {}; // throws on failure: never patch from a failed read
                await a.set(physical, key, { ...existing, ...patch });
            });
        },
        async mutate(key, updater) {
            // Same lock as patch() (keyed by physical table + key), so a patch()
            // call and a mutate() call on the same record can never interleave.
            const lockKey = `${physical}::${key}`;
            return withKeyLock(lockKey, async () => {
                const a = await adapter();
                const current = await a.get(physical, key); // throws on failure: never mutate from a failed read
                const updated = await updater(current);
                await a.set(physical, key, updated); // throws on failure: caller must know the write failed
                return updated;
            });
        },
        get namespace() { return namespace; },
        get tableName() { return tableName ?? null; },
        get physicalTable() { return physical; },
    };
    if (isRoot) {
        store.table = (name) => {
            if (!name || typeof name !== 'string' || /[^a-z0-9_]/i.test(name)) {
                throw new Error(`${tag} table name must be a non-empty alphanumeric string (got: "${name}")`);
            }
            return makeStore(namespace, name, false);
        };
    }
    return store;
}
export function createStore(namespace) {
    if (!namespace || typeof namespace !== 'string') {
        throw new Error('[pluginStore] namespace must be a non-empty string');
    }
    if (/[^a-z0-9_]/i.test(namespace)) {
        throw new Error(`[pluginStore] namespace "${namespace}" must contain only letters, digits, or underscores`);
    }
    return makeStore(namespace, undefined, true);
}
