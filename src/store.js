// Simple per-customer session store (in memory, saved to disk every few seconds).
// Enough for a few businesses; swap for Redis/Postgres when you grow.
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.jsonl');
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // forget a chat after 24h of silence
const MAX_TURNS = 12; // user messages kept in AI context

fs.mkdirSync(DATA_DIR, { recursive: true });

let sessions = {};
try {
  sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
} catch {
  sessions = {};
}

let dirty = false;
setInterval(() => {
  if (!dirty) return;
  dirty = false;
  fs.writeFile(SESSIONS_FILE, JSON.stringify(sessions), () => {});
}, 3000).unref();

export function getSession(businessId, customer) {
  const key = `${businessId}:${customer}`;
  let s = sessions[key];
  if (!s || Date.now() - s.updatedAt > SESSION_TTL_MS) {
    s = sessions[key] = { history: [], cart: [], bargains: {}, handoff: false, updatedAt: Date.now() };
  }
  return s;
}

export function touch(session) {
  session.updatedAt = Date.now();
  trimHistory(session);
  dirty = true;
}

// Keep the last MAX_TURNS user text messages. Always cut at a user *text*
// message so a functionCall is never separated from its functionResponse.
function trimHistory(session) {
  const h = session.history;
  const userIdx = [];
  h.forEach((c, i) => {
    if (c.role === 'user' && c.parts?.some((p) => typeof p.text === 'string')) userIdx.push(i);
  });
  if (userIdx.length > MAX_TURNS) session.history = h.slice(userIdx[userIdx.length - MAX_TURNS]);
}

export function resetSession(businessId, customer) {
  delete sessions[`${businessId}:${customer}`];
  dirty = true;
}

export function saveOrder(order) {
  fs.appendFileSync(ORDERS_FILE, JSON.stringify(order) + '\n');
}

// Deduplicate webhook deliveries (Meta retries).
const seen = new Map();
export function alreadySeen(id) {
  const now = Date.now();
  for (const [k, t] of seen) if (now - t > 10 * 60 * 1000) seen.delete(k);
  if (seen.has(id)) return true;
  seen.set(id, now);
  return false;
}
