// Loads every business config from /businesses/*.json.
// Each WhatsApp number (phone_number_id) maps to exactly one business,
// so ONE server can run bots for many clients.
import fs from 'node:fs';
import path from 'node:path';

const DIR = process.env.BUSINESSES_DIR || path.resolve('businesses');

function normalize(b, file) {
  if (!b.phone_number_id) throw new Error(`${file}: phone_number_id missing`);
  if (!Array.isArray(b.items) || b.items.length === 0) throw new Error(`${file}: items[] missing`);
  for (const it of b.items) {
    if (!it.id || !it.name || typeof it.price !== 'number') {
      throw new Error(`${file}: every item needs id, name, price`);
    }
    // min_price = the lowest the owner will accept. Defaults to list price (no bargaining).
    if (typeof it.min_price !== 'number') it.min_price = it.price;
    if (it.min_price > it.price) throw new Error(`${file}: ${it.id} min_price > price`);
  }
  b.negotiation = { max_rounds: 3, ...(b.negotiation || {}) };
  return b;
}

export function loadBusinesses(dir = DIR) {
  const map = new Map();
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const b = normalize(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')), f);
    if (map.has(b.phone_number_id)) throw new Error(`duplicate phone_number_id in ${f}`);
    map.set(b.phone_number_id, b);
  }
  return map;
}

export function findItem(business, query) {
  if (!query) return null;
  const q = String(query).toLowerCase().trim();
  return (
    business.items.find((i) => i.id.toLowerCase() === q) ||
    business.items.find((i) => i.name.toLowerCase() === q) ||
    business.items.find((i) => i.name.toLowerCase().includes(q) || q.includes(i.name.toLowerCase())) ||
    null
  );
}
