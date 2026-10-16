import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import * as db from './db.js';

/** Token for a business: JSON override → onboarded account (DB) → global .env token. */
export function tokenFor(business) {
  return business.access_token || db.getAccount(business.phone_number_id)?.access_token || config.waToken;
}

const graphUrl = p => `${config.graphBase}/${config.graphVersion}/${p.replace(/^\//, '')}`;

/** Low-level Graph API call. Returns { ok, status, data, error }. Never throws. */
export async function graph(token, p, { method = 'POST', body } = {}) {
  try {
    const res = await fetch(graphUrl(p), {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return { ok: res.ok, status: res.status, data, error: res.ok ? null : data?.error ?? { message: text } };
  } catch (e) {
    return { ok: false, status: 0, data: null, error: { message: e.message } };
  }
}

async function send(business, payload) {
  const r = await graph(tokenFor(business), `${business.phone_number_id}/messages`, {
    body: { messaging_product: 'whatsapp', recipient_type: 'individual', ...payload },
  });
  if (!r.ok) {
    console.error(`[wa] send to ${payload.to} failed: ${r.status} ${JSON.stringify(r.error)}`);
    return { ok: false, code: r.error?.code, error: r.error?.message ?? 'send failed' };
  }
  const id = r.data?.messages?.[0]?.id;
  // Remember our own message ids so a coexistence echo of them is never mistaken for the owner.
  if (id) db.markProcessed(id);
  return { ok: true, id };
}

/** Free-form text (only delivers inside the 24h customer service window). */
export function sendText(business, to, body) {
  return send(business, { to, type: 'text', text: { preview_url: false, body: String(body).slice(0, 4000) } });
}

/**
 * Approved template message (works outside the 24h window).
 * Template body params can't contain newlines/tabs or 4+ spaces, so we flatten them.
 */
export function sendTemplate(business, to, name, lang, params = []) {
  const clean = s => String(s).replace(/[\n\t]+/g, ' | ').replace(/ {4,}/g, ' ').slice(0, 1000);
  return send(business, {
    to, type: 'template',
    template: {
      name, language: { code: lang },
      ...(params.length ? { components: [{ type: 'body', parameters: params.map(p => ({ type: 'text', text: clean(p) })) }] } : {}),
    },
  });
}

/** Marks a message as read (blue ticks) — makes the bot feel responsive. */
export function markRead(business, messageId) {
  return graph(tokenFor(business), `${business.phone_number_id}/messages`, {
    body: { messaging_product: 'whatsapp', status: 'read', message_id: messageId },
  });
}

const EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a', 'audio/aac': 'aac', 'video/mp4': 'mp4', 'application/pdf': 'pdf',
};

/**
 * Downloads inbound media (payment screenshots, voice notes…) so the owner can open it
 * from the dashboard. Meta's media URLs expire, so we keep a copy. Returns the file name or null.
 */
export async function downloadMedia(business, mediaId, mime) {
  if (!config.mediaDownload || !mediaId) return null;
  try {
    const token = tokenFor(business);
    const meta = await graph(token, mediaId, { method: 'GET' });
    if (!meta.ok || !meta.data?.url) return null;
    const res = await fetch(meta.data.url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > config.mediaMaxBytes) return null;
    const type = (mime || meta.data.mime_type || '').split(';')[0].trim();
    const name = `${business.slug}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${EXT[type] ?? 'bin'}`;
    const dir = path.join(config.dataDir, 'media');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), buf);
    return name;
  } catch (e) {
    console.error('[wa] media download failed', e.message);
    return null;
  }
}

/** Verifies Meta's X-Hub-Signature-256 header against the raw body. */
export function validSignature(rawBody, header) {
  if (!config.appSecret) return !config.production; // never skip the check in production
  if (!header?.startsWith('sha256=')) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', config.appSecret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Turns one inbound/echo message object into { text, media } we can store and reason about. */
function describe(m) {
  switch (m.type) {
    case 'text': return { text: m.text?.body ?? '' };
    case 'button': return { text: m.button?.text ?? '' };
    case 'interactive': return { text: m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? '' };
    case 'location': {
      const l = m.location ?? {};
      const label = [l.name, l.address].filter(Boolean).join(', ');
      return { text: `[Location shared: https://maps.google.com/?q=${l.latitude},${l.longitude}${label ? ` (${label})` : ''}]` };
    }
    case 'image': case 'video': case 'document': case 'audio': case 'sticker': {
      const o = m[m.type] ?? {};
      return { text: o.caption ?? '', media: { kind: m.type, id: o.id, mime: o.mime_type, voice: !!o.voice, filename: o.filename } };
    }
    case 'contacts': return { text: `[Contact card: ${(m.contacts ?? []).map(c => c.name?.formatted_name).join(', ')}]` };
    case 'order': return { text: `[Catalog order: ${(m.order?.product_items ?? []).map(p => `${p.quantity}x ${p.product_retailer_id}`).join(', ')}]` };
    default: return { text: '' };
  }
}

/**
 * Splits a webhook payload into what we care about:
 *  - messages: customers writing to the business
 *  - echoes:   coexistence — the owner replied from the WhatsApp Business app (field smb_message_echoes)
 *  - statuses: delivery receipts / failures for messages we sent
 *  - other:    history / smb_app_state_sync etc. (acknowledged, logged)
 */
export function extractEvents(payload) {
  const out = { messages: [], echoes: [], statuses: [], other: [] };
  for (const entry of payload?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const v = change.value ?? {};
      const phoneNumberId = v.metadata?.phone_number_id;
      const names = Object.fromEntries((v.contacts ?? []).map(c => [c.wa_id, c.profile?.name]));

      for (const m of v.messages ?? []) {
        if (m.type === 'reaction' || m.type === 'system' || m.type === 'unsupported') continue;
        out.messages.push({ id: m.id, from: m.from, name: names[m.from], type: m.type, phoneNumberId, ...describe(m) });
      }
      for (const e of v.message_echoes ?? []) {
        out.echoes.push({ id: e.id, to: e.to, type: e.type, phoneNumberId, ...describe(e) });
      }
      for (const s of v.statuses ?? []) {
        out.statuses.push({ id: s.id, status: s.status, to: s.recipient_id, errors: s.errors ?? [], phoneNumberId });
      }
      if (!v.messages && !v.message_echoes && !v.statuses) out.other.push({ field: change.field, phoneNumberId });
    }
  }
  return out;
}

/** Back-compat helper used by older code/tests. */
export const extractMessages = payload => extractEvents(payload).messages;
