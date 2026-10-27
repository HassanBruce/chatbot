import crypto from 'node:crypto';
import express from 'express';
import { loadBusinesses } from './businesses.js';
import { reply } from './agent.js';
import { getSession, touch, resetSession, alreadySeen } from './store.js';
import { sendText, markReadAndTyping } from './whatsapp.js';

const { VERIFY_TOKEN, APP_SECRET, PORT = 3000 } = process.env;
for (const k of ['VERIFY_TOKEN', 'GEMINI_API_KEY']) {
  if (!process.env[k]) console.warn(`⚠️  ${k} is not set`);
}
if (!APP_SECRET) console.warn('⚠️  APP_SECRET not set — webhook signatures are NOT verified');

let businesses = loadBusinesses();
console.log(`Loaded ${businesses.size} business(es):`, [...businesses.values()].map((b) => b.name).join(', '));

const app = express();
app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => (req.rawBody = buf) }));

app.get('/health', (_req, res) => res.json({ ok: true, businesses: businesses.size }));

// 1) Meta verification handshake
app.get('/webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && token && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

function validSignature(req) {
  if (!APP_SECRET) return true;
  const sig = req.get('x-hub-signature-256') || '';
  const expected = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(req.rawBody || '').digest('hex');
  return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

// 2) Incoming messages
app.post('/webhook', (req, res) => {
  if (!validSignature(req)) return res.sendStatus(401);
  res.sendStatus(200); // answer Meta fast, work in background

  for (const entry of req.body.entry || []) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      const business = businesses.get(v.metadata?.phone_number_id);
      if (!business) {
        if (v.messages) console.warn('Message for unknown phone_number_id', v.metadata?.phone_number_id);
        continue;
      }
      for (const msg of v.messages || []) {
        if (alreadySeen(msg.id)) continue;
        enqueue(`${business.phone_number_id}:${msg.from}`, () => handle(business, msg));
      }
    }
  }
});

// Process one customer's messages in order (they often send 3 messages in a row).
const queues = new Map();
function enqueue(key, job) {
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.then(job).catch((e) => console.error(e)).finally(() => {
    if (queues.get(key) === next) queues.delete(key);
  });
  queues.set(key, next);
}

function notifyOwner(business, text) {
  if (!business.owner_phone) return;
  sendText(business, business.owner_phone, text).catch((e) =>
    console.error(`[${business.name}] owner notify failed (owner must message the bot number once every 24h):`, e.message),
  );
}

async function handle(business, msg) {
  const from = msg.from;
  const isOwner = business.owner_phone && from === business.owner_phone;

  if (msg.type !== 'text') {
    if (!isOwner) await sendText(business, from, business.non_text_reply || 'Abhi main sirf text messages samajh sakta hoon, please likh kar bhej dein 🙏');
    return;
  }
  const text = msg.text.body.trim();

  if (text.toLowerCase() === '#reset') {
    resetSession(business.phone_number_id, from);
    return sendText(business, from, '🔄 Chat reset');
  }

  // Owner commands, sent from the owner's own WhatsApp to the bot number
  if (isOwner && text.startsWith('#')) {
    const [cmd, arg] = text.split(/\s+/);
    if (cmd === '#resume' && arg) {
      getSession(business.phone_number_id, arg.replace(/\D/g, '')).handoff = false;
      return sendText(business, from, `✅ Bot dobara active for +${arg.replace(/\D/g, '')}`);
    }
    if (cmd === '#reload') {
      businesses = loadBusinesses();
      return sendText(business, from, '✅ Rates/config reload ho gaye');
    }
    return sendText(business, from, 'Commands: #resume <number>, #reload, #reset');
  }

  const session = getSession(business.phone_number_id, from);
  if (session.handoff) return; // owner is handling this customer manually

  markReadAndTyping(business, msg.id);
  try {
    const answer = await reply({ business, session, customer: from, text, notify: notifyOwner });
    touch(session);
    await sendText(business, from, answer);
  } catch (e) {
    console.error(`[${business.name}] reply failed:`, e.message);
    await sendText(business, from, business.fallback_reply || 'Maazrat, thori der baad message karein 🙏').catch(() => {});
  }
}

app.listen(PORT, () => console.log(`wabot listening on :${PORT}`));
