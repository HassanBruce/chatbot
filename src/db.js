import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

let db;

export function getDb() {
  if (db) return db;
  const file = config.dataDir === ':memory:'
    ? ':memory:'
    : (fs.mkdirSync(config.dataDir, { recursive: true }), path.join(config.dataDir, 'wabot.sqlite'));
  db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business TEXT NOT NULL,
      customer TEXT NOT NULL,
      role TEXT NOT NULL,              -- 'user' | 'assistant' | 'owner'
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(business, customer, id);

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business TEXT NOT NULL,
      customer TEXT NOT NULL,
      customer_name TEXT,
      items TEXT NOT NULL,             -- JSON array
      address TEXT,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS conversations (
      business TEXT NOT NULL,
      customer TEXT NOT NULL,
      paused_until TEXT,
      PRIMARY KEY (business, customer)
    );

    CREATE TABLE IF NOT EXISTS processed (
      wa_message_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Numbers connected through Embedded Signup (incl. coexistence with the Business app)
    CREATE TABLE IF NOT EXISTS wa_accounts (
      phone_number_id TEXT PRIMARY KEY,
      business_slug TEXT NOT NULL,
      waba_id TEXT,
      access_token TEXT,
      coexistence INTEGER NOT NULL DEFAULT 0,
      sync_status TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Things the owner must know about (failed deliveries, AI outages)
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  // Lightweight migrations for databases created by v1
  addColumn('messages', 'media', 'TEXT');
  addColumn('orders', 'total', 'INTEGER');
  addColumn('orders', 'flagged', 'INTEGER NOT NULL DEFAULT 0');
  return db;
}

function addColumn(table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

/** Returns true the first time we see this WhatsApp message id (Meta retries webhooks). */
export function markProcessed(waMessageId) {
  if (!waMessageId) return true;
  const r = getDb().prepare('INSERT OR IGNORE INTO processed (wa_message_id) VALUES (?)').run(waMessageId);
  return r.changes === 1;
}

export function saveMessage(business, customer, role, content, media = null) {
  getDb().prepare('INSERT INTO messages (business, customer, role, content, media) VALUES (?,?,?,?,?)')
    .run(business, customer, role, content, media);
}

export function history(business, customer, limit) {
  const rows = getDb().prepare(
    'SELECT role, content, media, created_at FROM messages WHERE business=? AND customer=? ORDER BY id DESC LIMIT ?'
  ).all(business, customer, limit);
  return rows.reverse();
}

/** Customer messages in the last hour (rate limiting). */
export function recentUserMessages(business, customer) {
  return getDb().prepare(
    `SELECT COUNT(*) n FROM messages WHERE business=? AND customer=? AND role='user' AND created_at > datetime('now','-1 hour')`
  ).get(business, customer).n;
}

/** When did this customer last write to us? (24h service window) */
export function lastUserMessageAt(business, customer) {
  const r = getDb().prepare(
    `SELECT created_at FROM messages WHERE business=? AND customer=? AND role='user' ORDER BY id DESC LIMIT 1`
  ).get(business, customer);
  return r ? new Date(r.created_at + 'Z') : null;
}

export function saveOrder(business, customer, order, { total = null, flagged = false } = {}) {
  const r = getDb().prepare(
    'INSERT INTO orders (business, customer, customer_name, items, address, notes, total, flagged) VALUES (?,?,?,?,?,?,?,?)'
  ).run(business, customer, order.customer_name ?? null, JSON.stringify(order.items ?? []),
        order.address ?? null, order.notes ?? null, total, flagged ? 1 : 0);
  return Number(r.lastInsertRowid);
}

export function getOrder(id) {
  const o = getDb().prepare('SELECT * FROM orders WHERE id=?').get(id);
  return o ? { ...o, items: JSON.parse(o.items) } : null;
}

export function isPaused(business, customer) {
  const row = getDb().prepare('SELECT paused_until FROM conversations WHERE business=? AND customer=?')
    .get(business, customer);
  return !!(row?.paused_until && new Date(row.paused_until + 'Z') > new Date());
}

export function pause(business, customer, hours) {
  getDb().prepare(`
    INSERT INTO conversations (business, customer, paused_until)
    VALUES (?, ?, datetime('now', ?))
    ON CONFLICT(business, customer) DO UPDATE SET paused_until = excluded.paused_until
  `).run(business, customer, `+${hours} hours`);
}

export function resume(business, customer) {
  getDb().prepare('UPDATE conversations SET paused_until=NULL WHERE business=? AND customer=?')
    .run(business, customer);
}

export function listOrders(business, limit = 100) {
  return getDb().prepare('SELECT * FROM orders WHERE business=? ORDER BY id DESC LIMIT ?')
    .all(business, limit).map(o => ({ ...o, items: JSON.parse(o.items) }));
}

export function setOrderStatus(id, status) {
  getDb().prepare('UPDATE orders SET status=? WHERE id=?').run(status, id);
}

export function listConversations(business, limit = 50) {
  return getDb().prepare(`
    WITH last AS (
      SELECT customer, MAX(id) AS last_id, COUNT(*) AS n
      FROM messages WHERE business = ? GROUP BY customer
    )
    SELECT l.customer, l.last_id, l.n, m.content AS last_message, m.role AS last_role, m.created_at AS last_at, c.paused_until
    FROM last l
    JOIN messages m ON m.id = l.last_id
    LEFT JOIN conversations c ON c.business = ? AND c.customer = l.customer
    ORDER BY l.last_id DESC LIMIT ?
  `).all(business, business, limit);
}

export function stats(business) {
  const d = getDb();
  return {
    messagesToday: d.prepare(`SELECT COUNT(*) n FROM messages WHERE business=? AND role='user' AND date(created_at)=date('now')`).get(business).n,
    customers: d.prepare('SELECT COUNT(DISTINCT customer) n FROM messages WHERE business=?').get(business).n,
    ordersNew: d.prepare(`SELECT COUNT(*) n FROM orders WHERE business=? AND status='new'`).get(business).n,
  };
}

// ---- connected numbers (Embedded Signup) ----
export function saveAccount(a) {
  getDb().prepare(`
    INSERT INTO wa_accounts (phone_number_id, business_slug, waba_id, access_token, coexistence, sync_status)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(phone_number_id) DO UPDATE SET business_slug=excluded.business_slug, waba_id=excluded.waba_id,
      access_token=excluded.access_token, coexistence=excluded.coexistence, sync_status=excluded.sync_status
  `).run(String(a.phone_number_id), a.business_slug, a.waba_id ?? null, a.access_token ?? null, a.coexistence ? 1 : 0, a.sync_status ?? null);
}
export function getAccount(phoneNumberId) {
  if (!phoneNumberId) return null;
  return getDb().prepare('SELECT * FROM wa_accounts WHERE phone_number_id=?').get(String(phoneNumberId)) ?? null;
}
export function accountForSlug(slug) {
  return getDb().prepare('SELECT * FROM wa_accounts WHERE business_slug=? ORDER BY created_at DESC LIMIT 1').get(slug) ?? null;
}

// ---- alerts ----
export function addAlert(business, text) {
  getDb().prepare('INSERT INTO alerts (business, text) VALUES (?,?)').run(business, String(text).slice(0, 1000));
}
export function listAlerts(business, limit = 10) {
  return getDb().prepare(`SELECT * FROM alerts WHERE business=? AND created_at > datetime('now','-3 days') ORDER BY id DESC LIMIT ?`)
    .all(business, limit);
}

// ---- maintenance ----
/** Drops dedupe ids older than 7 days and alerts older than 30 days. */
export function cleanup() {
  const d = getDb();
  d.exec(`DELETE FROM processed WHERE created_at < datetime('now','-7 days');
          DELETE FROM alerts WHERE created_at < datetime('now','-30 days');`);
}

/** Consistent online backup to data/backups/wabot-YYYY-MM-DD.sqlite; keeps the last N days. */
export function backup(keepDays = config.backupKeepDays) {
  if (config.dataDir === ':memory:') return null;
  const dir = path.join(config.dataDir, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `wabot-${new Date().toISOString().slice(0, 10)}.sqlite`);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  getDb().exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const old = fs.readdirSync(dir).filter(f => /^wabot-\d{4}-\d{2}-\d{2}\.sqlite$/.test(f)).sort().slice(0, -keepDays);
  for (const f of old) fs.unlinkSync(path.join(dir, f));
  return file;
}
