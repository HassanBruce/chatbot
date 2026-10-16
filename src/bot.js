import { config } from './config.js';
import { byPhoneNumberId, systemPrompt, priceOrder } from './businesses.js';
import * as db from './db.js';
import { chat, parseAiJson } from './ai.js';
import { sendText, sendTemplate, markRead, downloadMedia } from './whatsapp.js';

const FALLBACK = 'Shukriya aapke message ka! Hamari team thori der mein aapko reply karegi. 🙏';
const UNSUPPORTED = 'Abhi main sirf text messages samajh sakta hoon. Barah-e-karam apna sawal likh kar bhej dein. 🙏';
const VOICE = 'Voice note mil gaya 🙏 Main abhi voice nahi sun sakta — barah-e-karam likh kar bhej dein, ya team member sun kar jald reply karega.';
const RATE_LIMITED = 'Aapke bohot saare messages aa gaye hain 🙏 Team member jald aapse rabta karega.';

export const STATUSES = {
  orders: ['new', 'confirmed', 'out_for_delivery', 'delivered', 'cancelled'],
  appointments: ['new', 'confirmed', 'completed', 'cancelled', 'no_show'],
};
const STATUS_MESSAGES = {
  orders: {
    confirmed: '✅ Aapka order #{id} confirm ho gaya hai. Shukriya!',
    out_for_delivery: '🛵 Aapka order #{id} raste mein hai, thori der mein pohanch jayega.',
    delivered: '🎉 Order #{id} deliver ho gaya. Shukriya! Dobara zaroor order karein.',
    cancelled: '❌ Order #{id} cancel ho gaya hai. Koi sawal ho to isi chat mein likh dein.',
  },
  appointments: {
    confirmed: '✅ Aapki booking #{id} confirm hai. {notes}',
    completed: 'Shukriya aane ka! 🙏 Agli dafa bhi isi chat pe booking kar sakte hain.',
    cancelled: '❌ Booking #{id} cancel ho gayi hai. Nayi booking ke liye isi chat mein likh dein.',
  },
};

const digits = s => String(s ?? '').replace(/\D/g, '');
const keyOf = (business, customer) => `${business.slug}:${customer}`;

// ---------------------------------------------------------------------------
// Per-chat debounce + lock: customers often send "bhai" / "menu" / "bhej do" as three
// messages. We wait DEBOUNCE_MS for them to finish, then answer once, and never run two
// AI calls for the same chat at the same time.
// ---------------------------------------------------------------------------
const pending = new Map(); // key -> { timer, resolve, fire }
const locks = new Map();   // key -> promise tail

function withLock(key, fn) {
  const run = (locks.get(key) ?? Promise.resolve()).then(fn);
  const tail = run.catch(() => {});
  locks.set(key, tail);
  tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  return run;
}

function schedule(business, msg) {
  const key = keyOf(business, msg.from);
  const prev = pending.get(key);
  if (prev) { clearTimeout(prev.timer); prev.resolve({ skipped: 'batched' }); }
  return new Promise(resolve => {
    const fire = () => {
      pending.delete(key);
      withLock(key, () => respond(business, msg)).then(resolve, e => {
        console.error('[bot] respond failed', e);
        resolve({ error: e.message });
      });
    };
    pending.set(key, { timer: setTimeout(fire, config.debounceMs), resolve, fire });
  });
}

function cancelPending(business, customer, reason) {
  const key = keyOf(business, customer);
  const p = pending.get(key);
  if (p) { clearTimeout(p.timer); pending.delete(key); p.resolve({ skipped: reason }); }
}

/** For graceful shutdown: answer everything that is waiting, then wait for in-flight replies. */
export async function flushPending() {
  for (const p of [...pending.values()]) { clearTimeout(p.timer); p.fire(); }
  await Promise.all([...locks.values()]);
}

// ---------------------------------------------------------------------------
// Inbound customer message
// ---------------------------------------------------------------------------
export async function handleIncoming(msg) {
  const business = byPhoneNumberId(msg.phoneNumberId);
  if (!business) {
    console.warn(`[bot] no business for phone_number_id=${msg.phoneNumberId}`);
    return { skipped: 'unknown-business' };
  }
  if (!db.markProcessed(msg.id)) return { skipped: 'duplicate' };

  const slug = business.slug;
  markRead(business, msg.id);

  // Owner commands sent to the bot number from the owner's own (personal) WhatsApp
  if (business.owner_whatsapp && digits(msg.from) === digits(business.owner_whatsapp) && msg.text && !msg.media) {
    return ownerCommand(business, msg.text.trim());
  }

  if (msg.media?.kind === 'sticker') return { skipped: 'sticker' };

  // Keep a copy of media (payment screenshots, voice notes) for the dashboard
  let mediaFile = null;
  if (msg.media) mediaFile = await downloadMedia(business, msg.media.id, msg.media.mime);
  const label = msg.media ? `[${msg.media.voice ? 'voice note' : msg.media.kind}]` : '';
  const content = [label, msg.text].filter(Boolean).join(' ');

  if (!content) {
    await sendText(business, msg.from, UNSUPPORTED);
    return { replied: 'unsupported' };
  }

  db.saveMessage(slug, msg.from, 'user', content, mediaFile);

  if (db.isPaused(slug, msg.from)) {
    return { skipped: 'paused-for-human' }; // owner is handling this chat
  }

  const recent = db.recentUserMessages(slug, msg.from);
  if (recent > config.maxMsgsPerHour) {
    if (recent === config.maxMsgsPerHour + 1) {
      await sendText(business, msg.from, RATE_LIMITED);
      db.pause(slug, msg.from, 1);
      await notifyOwner(business, `⚠️ +${msg.from} ne 1 ghante mein ${recent} messages bheje. Bot is chat mein 1 ghanta band.`);
    }
    return { skipped: 'rate-limited' };
  }

  if (msg.media && (msg.media.kind === 'audio')) {
    await reply(business, msg.from, VOICE);
    await notifyOwner(business, `🎤 +${msg.from}${msg.name ? ` (${msg.name})` : ''} ne voice note bheja hai. Dashboard pe sun sakte hain.`);
    return { replied: 'voice' };
  }
  if (msg.media) {
    notifyOwner(business, `📎 +${msg.from}${msg.name ? ` (${msg.name})` : ''} ne ${msg.media.kind} bheji hai${msg.text ? `: "${msg.text}"` : ''}. Dashboard pe dekh sakte hain.`);
  }

  return schedule(business, { ...msg, text: content });
}

async function reply(business, customer, text) {
  const r = await sendText(business, customer, text);
  db.saveMessage(business.slug, customer, 'assistant', text);
  return r;
}

async function respond(business, msg) {
  const slug = business.slug;
  if (db.isPaused(slug, msg.from)) return { skipped: 'paused-for-human' };

  const messages = [
    { role: 'system', content: systemPrompt(business) },
    ...(msg.name ? [{ role: 'system', content: `Customer's WhatsApp name: ${msg.name}` }] : []),
    ...db.history(slug, msg.from, config.historyLimit).map(m => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.role === 'owner' ? `(Team member) ${m.content}` : m.content,
    })),
  ];

  let result;
  try {
    result = parseAiJson(await chat(messages));
  } catch (e) {
    console.error(`[bot] AI failed for ${slug}:`, e.message);
    db.addAlert(slug, `AI error: ${e.message}`);
    await reply(business, msg.from, FALLBACK);
    await notifyOwner(business, `⚠️ Bot AI error. Customer +${msg.from} ne likha:\n"${msg.text}"\nKhud reply kar dein.`);
    return { replied: 'fallback' };
  }

  // The owner may have jumped in from the WhatsApp Business app while the AI was thinking.
  if (db.isPaused(slug, msg.from)) return { skipped: 'owner-took-over' };

  let text = result.reply?.trim() || FALLBACK;

  if (result.action === 'order') {
    const appt = business.kind === 'appointments';
    const priced = priceOrder(business, result.order.items);
    const order = { ...result.order, items: priced.items };
    const orderId = db.saveOrder(slug, msg.from, order, { total: priced.total, flagged: priced.flagged });
    const lines = priced.items.map(i => `• ${i.qty} x ${i.name}${i.price != null ? ` — Rs ${i.price * i.qty}` : ''}`).join('\n');

    // Server-generated receipt: totals come from the catalog, not from the AI.
    text += `\n\n🧾 ${appt ? 'Booking' : 'Order'} #${orderId}\n${lines}` +
      (!appt && priced.total && !priced.flagged ? `\nTotal: Rs ${priced.total}` : '') +
      (priced.flagged ? '\nFinal amount team confirm karegi.' : '') +
      (order.notes && appt ? `\n🕒 ${order.notes}` : '');
    await reply(business, msg.from, text);

    await notifyOwner(business,
      `🛒 New ${appt ? 'booking' : 'order'} #${orderId}\n` +
      `Customer: ${order.customer_name || msg.name || ''} (+${msg.from})\n${lines}\n` +
      (priced.total ? `Total: Rs ${priced.total}\n` : '') +
      (order.address ? `Address: ${order.address}\n` : '') +
      (order.notes ? `Notes: ${order.notes}\n` : '') +
      (priced.flagged ? '⚠️ Kuch items/prices catalog se match nahi hue — verify karein.' : ''));
    return { replied: true, orderId, total: priced.total, flagged: priced.flagged };
  }

  await reply(business, msg.from, text);

  if (result.action === 'handoff') {
    db.pause(slug, msg.from, config.handoffPauseHours);
    await notifyOwner(business,
      `🙋 Customer +${msg.from} ko insaan chahiye.\nReason: ${result.handoff_reason || '-'}\nLast message: "${msg.text}"\n\n` +
      (business.coexistence
        ? `Apne WhatsApp Business app se seedha reply karein. Bot ${config.handoffPauseHours} ghante chup rahega.`
        : `Reply karne ke liye bot number pe likhein:\nreply ${msg.from} <message>\nBot wapas on: resume ${msg.from}`));
    return { replied: true, handoff: true };
  }

  return { replied: true };
}

// ---------------------------------------------------------------------------
// Coexistence: owner replied from the WhatsApp Business app (smb_message_echoes)
// ---------------------------------------------------------------------------
export async function handleEcho(echo) {
  const business = byPhoneNumberId(echo.phoneNumberId);
  if (!business) return { skipped: 'unknown-business' };
  // Our own API sends are recorded as processed when sent, so they can never be mistaken for the owner.
  if (!db.markProcessed(echo.id)) return { skipped: 'duplicate' };
  if (echo.type === 'revoke' || echo.type === 'edit') return { skipped: echo.type };

  const slug = business.slug;
  const customer = digits(echo.to);
  const content = [echo.media ? `[${echo.media.kind}]` : '', echo.text].filter(Boolean).join(' ') || `[${echo.type}]`;
  db.saveMessage(slug, customer, 'owner', content);

  // Owner ends a message with the marker (default 🤖) → hand the chat back to the bot.
  if (config.resumeMarker && echo.text?.trim().endsWith(config.resumeMarker)) {
    db.resume(slug, customer);
    return { echo: 'resumed' };
  }
  db.pause(slug, customer, config.ownerReplyPauseHours);
  cancelPending(business, customer, 'owner-took-over');
  return { echo: 'paused' };
}

// ---------------------------------------------------------------------------
// Delivery statuses — surface failures instead of silently losing messages
// ---------------------------------------------------------------------------
const ERROR_HINTS = {
  131047: '24 ghante se zyada ho gaye — customer ke naye message ke baghair free-form message nahi jata.',
  131026: 'Number WhatsApp pe nahi hai ya message receive nahi kar sakta.',
  131049: 'Meta ne marketing limit ki wajah se message roka.',
  131051: 'Ye message type support nahi.',
  130429: 'Rate limit — bohot tezi se messages bheje gaye.',
};
export function handleStatus(s) {
  if (s.status !== 'failed') return { status: s.status };
  const business = byPhoneNumberId(s.phoneNumberId);
  const e = s.errors[0] ?? {};
  const hint = ERROR_HINTS[e.code] ?? e.title ?? e.message ?? 'unknown error';
  console.warn(`[wa] delivery failed to ${s.to}: ${e.code} ${hint}`);
  if (business) db.addAlert(business.slug, `Message +${s.to} ko deliver nahi hua (${e.code ?? '?'}): ${hint}`);
  return { status: 'failed', code: e.code };
}

// ---------------------------------------------------------------------------
// Owner helpers (also used by the dashboard)
// ---------------------------------------------------------------------------
export async function notifyOwner(business, text) {
  const owner = digits(business.owner_whatsapp);
  if (!owner) return null;
  const r = await sendText(business, owner, text);
  if (r.ok) return r;
  // Outside the owner's 24h window free-form fails; fall back to an approved template if configured.
  const tpl = business.owner_alert_template || config.ownerAlertTemplate;
  if (tpl) {
    const t = await sendTemplate(business, owner, tpl, business.owner_alert_template_lang || config.ownerAlertTemplateLang, [text]);
    if (t.ok) return t;
  }
  db.addAlert(business.slug, `Owner ko WhatsApp alert nahi gaya (${r.code ?? r.error}). Tip: owner apne number se bot ko roz ek message bheje, ya OWNER_ALERT_TEMPLATE set karein. Alert: ${text}`);
  return r;
}

/** Send a message to a customer as the business (dashboard / owner command). Pauses the bot. */
export async function ownerSend(business, customer, body) {
  const slug = business.slug;
  customer = digits(customer);
  const last = db.lastUserMessageAt(slug, customer);
  if (!last || Date.now() - last.getTime() > 24 * 3600 * 1000) {
    return { ok: false, error: 'Customer ka aakhri message 24 ghante se purana hai — WhatsApp free-form message allow nahi karta.' };
  }
  const r = await sendText(business, customer, body);
  if (!r.ok) return r;
  db.pause(slug, customer, config.handoffPauseHours);
  db.saveMessage(slug, customer, 'owner', body);
  cancelPending(business, customer, 'owner-took-over');
  return r;
}

/** Order/booking status changed → tell the customer (if a message is defined and the window is open). */
export async function notifyStatus(business, order, status) {
  const kind = business.kind === 'appointments' ? 'appointments' : 'orders';
  const tpl = business.status_messages?.[status] ?? STATUS_MESSAGES[kind][status];
  if (!tpl) return { ok: true, skipped: 'no-message' };
  const text = tpl.replace('{id}', order.id).replace('{notes}', order.notes ?? '').replace('{name}', order.customer_name ?? '').trim();
  const last = db.lastUserMessageAt(business.slug, order.customer);
  if (!last || Date.now() - last.getTime() > 24 * 3600 * 1000) {
    db.addAlert(business.slug, `#${order.id} status "${status}" customer ko nahi bheja: 24 ghante ki window band hai.`);
    return { ok: false, error: 'window-closed' };
  }
  const r = await sendText(business, order.customer, text);
  if (r.ok) db.saveMessage(business.slug, order.customer, 'assistant', text);
  return r;
}

async function ownerCommand(business, text) {
  const slug = business.slug;
  const owner = digits(business.owner_whatsapp);
  let m;
  if ((m = text.match(/^reply\s+\+?(\d{8,15})\s+([\s\S]+)$/i))) {
    const [, customer, body] = m;
    const r = await ownerSend(business, customer, body);
    await sendText(business, owner, r.ok ? `✅ Sent to +${customer}. Bot is paused for this chat.` : `❌ Nahi gaya: ${r.error}`);
    return { owner: 'reply', ok: r.ok };
  }
  if ((m = text.match(/^resume\s+\+?(\d{8,15})$/i))) {
    db.resume(slug, m[1]);
    await sendText(business, owner, `✅ Bot resumed for +${m[1]}.`);
    return { owner: 'resume' };
  }
  if ((m = text.match(/^pause\s+\+?(\d{8,15})$/i))) {
    db.pause(slug, m[1], config.handoffPauseHours);
    cancelPending(business, m[1], 'owner-took-over');
    await sendText(business, owner, `⏸️ Bot paused for +${m[1]} (${config.handoffPauseHours}h).`);
    return { owner: 'pause' };
  }
  if (/^orders?$/i.test(text)) {
    const orders = db.listOrders(slug, 5);
    const body = orders.length
      ? orders.map(o => `#${o.id} ${o.status} — ${o.customer_name || '+' + o.customer}: ${o.items.map(i => `${i.qty}x ${i.name}`).join(', ')}${o.total ? ` (Rs ${o.total})` : ''}`).join('\n')
      : 'Abhi koi order nahi.';
    await sendText(business, owner, body);
    return { owner: 'orders' };
  }
  await sendText(business, owner,
    'Owner commands:\n• reply <number> <message>\n• pause <number>\n• resume <number>\n• orders');
  return { owner: 'help' };
}
