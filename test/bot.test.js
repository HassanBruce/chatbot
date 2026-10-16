import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wabot-test-'));
process.env.DATA_DIR = tmp;
process.env.BUSINESSES_DIR = './test/fixtures';
process.env.WA_VERIFY_TOKEN = 'verify-me';
process.env.WA_APP_SECRET = 'secret';
process.env.ADMIN_PASSWORD = 'pw';
process.env.AI_API_KEY = 'k';
process.env.DEBOUNCE_MS = '0';
process.env.META_APP_ID = 'app1';
process.env.ES_CONFIG_ID = 'cfg1';
process.env.MAX_MSGS_PER_HOUR = '5';

const { createApp } = await import('../src/server.js');
const { parseAiJson } = await import('../src/ai.js');
const { config, configProblems } = await import('../src/config.js');
const { priceOrder, bySlug, loadErrors, systemPrompt } = await import('../src/businesses.js');
const { onboardKey } = await import('../src/onboard.js');

// ---- fake fetch: records Graph calls, returns scripted AI replies ----
const realFetch = globalThis.fetch;
let sent = [];       // outgoing WhatsApp messages
let graphCalls = []; // every Graph API call
let aiQueue = [];
let aiRequests = [];
let failTo = {};     // recipient -> error code for the next sends
let msgSeq = 0;
globalThis.fetch = async (url, opts = {}) => {
  url = String(url);
  if (url.startsWith('http://127.0.0.1')) return realFetch(url, opts);
  if (url.includes('lookaside.fbsbx.com')) return new Response(Buffer.from('fake-jpeg-bytes'), { status: 200 });
  if (url.includes('graph.facebook.com')) {
    const body = opts.body ? JSON.parse(opts.body) : null;
    graphCalls.push({ url, method: opts.method ?? 'GET', body });
    if (url.includes('/oauth/access_token')) return Response.json({ access_token: 'biz-token' });
    if (url.match(/\/media-\w+$/)) return Response.json({ url: 'https://lookaside.fbsbx.com/x', mime_type: 'image/jpeg' });
    if (url.endsWith('/messages') && body?.type) {
      if (failTo[body.to] && body.type === 'text') return Response.json({ error: { code: failTo[body.to], message: 'nope' } }, { status: 400 });
      sent.push({ to: body.to, type: body.type, text: body.text?.body, template: body.template, auth: opts.headers?.Authorization });
      return Response.json({ messages: [{ id: `wamid.out.${++msgSeq}` }] });
    }
    return Response.json({ success: true });
  }
  if (url.includes('/chat/completions')) {
    aiRequests.push(JSON.parse(opts.body));
    const next = aiQueue.shift();
    if (next instanceof Error) return new Response('rate', { status: 429 });
    return Response.json({ choices: [{ message: { content: next ?? '{"reply":"ok","action":"none"}' } }] });
  }
  throw new Error('unexpected fetch ' + url);
};

let base;
before(async () => {
  const server = createApp({ awaitProcessing: true }).listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  server.unref();
});
beforeEach(() => { sent = []; aiQueue = []; aiRequests = []; graphCalls = []; failTo = {}; config.debounceMs = 0; });

let seq = 0;
const AUTH = { Authorization: 'Basic ' + Buffer.from('admin:pw').toString('base64') };
function wrap(value) {
  return { object: 'whatsapp_business_account', entry: [{ changes: [{ value, field: 'messages' }] }] };
}
function payload(from, text, phoneNumberId = '111') {
  return wrap({
    metadata: { phone_number_id: phoneNumberId },
    contacts: [{ wa_id: from, profile: { name: 'Ali' } }],
    messages: [{ id: `wamid.${++seq}`, from, type: 'text', text: { body: text } }],
  });
}
function rawMessage(from, m, phoneNumberId = '111') {
  return wrap({ metadata: { phone_number_id: phoneNumberId }, contacts: [{ wa_id: from, profile: { name: 'Ali' } }], messages: [{ id: `wamid.${++seq}`, from, ...m }] });
}
function echo(to, text, { id = `wamid.echo.${++seq}`, phoneNumberId = '111' } = {}) {
  return { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'smb_message_echoes', value: {
    messaging_product: 'whatsapp', metadata: { phone_number_id: phoneNumberId },
    message_echoes: [{ from: '15550000000', to, id, timestamp: '1739321024', type: 'text', text: { body: text } }],
  } }] }] };
}
async function post(body, sign = true) {
  const raw = JSON.stringify(body);
  const sig = 'sha256=' + crypto.createHmac('sha256', 'secret').update(raw).digest('hex');
  const res = await fetch(`${base}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(sign ? { 'X-Hub-Signature-256': sig } : {}) },
    body: raw,
  });
  return { status: res.status, json: res.status === 200 ? await res.json() : null };
}
const form = (pathname, data, headers = {}) => fetch(`${base}${pathname}`, {
  method: 'POST', redirect: 'manual',
  headers: { ...AUTH, 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
  body: new URLSearchParams(data).toString(),
});

// ---------------------------------------------------------------- basics
test('webhook verification handshake', async () => {
  const ok = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42`);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), '42');
  const bad = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42`);
  assert.equal(bad.status, 403);
});

test('rejects unsigned webhook', async () => {
  const r = await post(payload('923111111111', 'hi'), false);
  assert.equal(r.status, 401);
});

test('answers a question; prompt carries current local time', async () => {
  aiQueue.push('{"reply":"Ji, hum 12 baje se 1 baje raat tak open hain.","action":"none"}');
  const r = await post(payload('923111111111', 'timing kya hai?'));
  assert.equal(r.status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, '923111111111');
  assert.match(sent[0].text, /open/);
  assert.match(aiRequests[0].messages[0].content, /CURRENT DATE AND TIME/);
});

test('confirmed order: totals come from the catalog, not the AI', async () => {
  aiQueue.push(JSON.stringify({
    reply: 'Shukriya Ali! Aapka order confirm ho gaya.',
    action: 'order',
    // AI got the karahi price wrong on purpose
    order: { customer_name: 'Ali', items: [{ name: 'chicken karahi (half)', qty: 1, price: 999 }, { name: 'Naan', qty: 4, price: 40 }], address: 'H-12 Johar Town', notes: '' },
  }));
  const r = await post(payload('923222222222', 'haan confirm'));
  const res = r.json.results[0];
  assert.ok(res.orderId > 0);
  assert.equal(res.total, 1560);
  assert.equal(res.flagged, false);
  assert.equal(sent.length, 2);
  assert.match(sent[0].text, /🧾 Order #\d+[\s\S]*Total: Rs 1560/);
  assert.equal(sent[1].to, '923009999999'); // owner
  assert.match(sent[1].text, /Total: Rs 1560/);
});

test('unknown items are flagged for the owner', () => {
  const p = priceOrder(bySlug('test-shop'), [{ name: 'Pizza', qty: 2, price: 100 }, { name: 'Naan', qty: 2 }]);
  assert.equal(p.flagged, true);
  assert.equal(p.items[0].unverified, true);
  assert.equal(p.total, 80);
  const d = priceOrder({ catalog: [], deals: [{ name: 'Family Deal', price: 4200 }] }, [{ name: 'family deal', qty: 1 }]);
  assert.equal(d.total, 4200);
});

test('handoff pauses the bot until resumed by owner', async () => {
  aiQueue.push('{"reply":"Maazrat! Team member abhi reply karega.","action":"handoff","handoff_reason":"complaint"}');
  await post(payload('923333333333', 'khana thanda tha, refund chahiye'));
  assert.equal(sent.length, 2); // customer + owner
  sent = [];
  const r = await post(payload('923333333333', 'hello??'));
  assert.equal(r.json.results[0].skipped, 'paused-for-human');
  assert.equal(sent.length, 0);

  await post(payload('923009999999', 'reply 923333333333 Sorry Ali bhai, refund kar dete hain'));
  assert.equal(sent[0].to, '923333333333');
  await post(payload('923009999999', 'resume 923333333333'));
  sent = [];
  aiQueue.push('{"reply":"Ji farmaiye!","action":"none"}');
  await post(payload('923333333333', 'thanks'));
  assert.equal(sent[0].text, 'Ji farmaiye!');
  // the owner's reply is in the AI's context, labelled
  assert.ok(aiRequests.at(-1).messages.some(m => m.content.startsWith('(Team member) Sorry Ali bhai')));
});

test('AI outage sends fallback instead of silence and raises an alert', async () => {
  aiQueue.push(new Error(), new Error(), new Error());
  const r = await post(payload('923444444444', 'menu?'));
  assert.equal(r.json.results[0].replied, 'fallback');
  assert.match(sent[0].text, /team/);
  const html = await (await fetch(`${base}/admin?b=test-shop`, { headers: AUTH })).text();
  assert.match(html, /AI error/);
});

test('duplicate webhook deliveries are ignored', async () => {
  const p = payload('923555555555', 'hi');
  await post(p);
  const r = await post(p);
  assert.equal(r.json.results[0].skipped, 'duplicate');
  assert.equal(sent.length, 1);
});

// ---------------------------------------------------------------- coexistence
test('coexistence: owner reply from the Business app pauses the bot', async () => {
  const c = '923600000001';
  await post(payload(c, 'salam'));
  sent = []; aiRequests = [];
  const e = await post(echo(c, 'Walaikum salam, main Hassan, bataiye'));
  assert.equal(e.json.echoes[0].echo, 'paused');
  const r = await post(payload(c, 'bhai price kya hai'));
  assert.equal(r.json.results[0].skipped, 'paused-for-human');
  assert.equal(sent.length, 0);
  assert.equal(aiRequests.length, 0);
});

test('coexistence: owner ends a message with 🤖 to hand the chat back', async () => {
  const c = '923600000002';
  await post(echo(c, 'Main dekh leta hoon'));
  await post(echo(c, 'Baqi details assistant bata dega 🤖'));
  aiQueue.push('{"reply":"Ji zaroor!","action":"none"}');
  const r = await post(payload(c, 'ok menu bhejo'));
  assert.equal(r.json.results[0].replied, true);
});

test('coexistence: echoes of the bot\'s own API messages are ignored', async () => {
  const c = '923600000003';
  await post(payload(c, 'hi'));
  // Meta should not echo API sends, but if it ever does, the id is already known
  const r = await post(echo(c, 'ok', { id: `wamid.out.${msgSeq}` }));
  assert.equal(r.json.echoes[0].skipped, 'duplicate');
  aiQueue.push('{"reply":"ji","action":"none"}');
  const r2 = await post(payload(c, 'aur?'));
  assert.equal(r2.json.results[0].replied, true);
});

test('coexistence: owner reply while the bot is waiting cancels the bot reply', async () => {
  config.debounceMs = 300;
  const c = '923600000004';
  const pending = post(payload(c, 'koi hai?'));
  await new Promise(r => setTimeout(r, 50));
  await post(echo(c, 'Ji main hoon'));
  const r = await pending;
  assert.equal(r.json.results[0].skipped, 'owner-took-over');
  assert.equal(aiRequests.length, 0);
  assert.equal(sent.length, 0);
});

// ---------------------------------------------------------------- production behaviour
test('debounce: three quick messages get one combined reply', async () => {
  config.debounceMs = 200;
  const c = '923700000001';
  aiQueue.push('{"reply":"Ji, menu ye hai…","action":"none"}');
  const results = await Promise.all([post(payload(c, 'bhai')), post(payload(c, 'menu')), post(payload(c, 'bhej do'))]);
  const outcomes = results.map(r => r.json.results[0]);
  assert.equal(outcomes.filter(o => o.skipped === 'batched').length, 2);
  assert.equal(aiRequests.length, 1);
  assert.equal(sent.length, 1);
  const userTurns = aiRequests[0].messages.filter(m => m.role === 'user').map(m => m.content);
  assert.deepEqual(userTurns.slice(-3).sort(), ['bhai', 'bhej do', 'menu']);
});

test('location message becomes an address the AI can use', async () => {
  const c = '923700000002';
  await post(rawMessage(c, { type: 'location', location: { latitude: 31.47, longitude: 74.27, name: 'Home' } }));
  const last = aiRequests[0].messages.at(-1).content;
  assert.match(last, /\[Location shared: https:\/\/maps\.google\.com\/\?q=31\.47,74\.27 \(Home\)\]/);
});

test('image (payment screenshot) is saved, owner alerted, viewable in dashboard', async () => {
  const c = '923700000003';
  aiQueue.push('{"reply":"Shukriya, team payment check karegi.","action":"none"}');
  await post(rawMessage(c, { type: 'image', image: { id: 'media-abc', mime_type: 'image/jpeg', caption: 'payment kar di' } }));
  assert.ok(sent.some(s => s.to === '923009999999' && /image bheji/.test(s.text)));
  assert.match(aiRequests[0].messages.at(-1).content, /^\[image\] payment kar di$/);
  const html = await (await fetch(`${base}/admin?b=test-shop&c=${c}`, { headers: AUTH })).text();
  const src = html.match(/src="(\/admin\/media\/[^"]+)"/)[1];
  const img = await fetch(base + src, { headers: AUTH });
  assert.equal(img.status, 200);
  assert.equal((await fetch(base + src)).status, 401); // media needs login
});

test('voice note: polite reply, owner alerted, no AI call', async () => {
  const c = '923700000004';
  const r = await post(rawMessage(c, { type: 'audio', audio: { id: 'media-voice', mime_type: 'audio/ogg; codecs=opus', voice: true } }));
  assert.equal(r.json.results[0].replied, 'voice');
  assert.equal(aiRequests.length, 0);
  assert.match(sent[0].text, /Voice note/);
});

test('rate limit protects the AI bill from spam', async () => {
  const c = '923700000005';
  for (let i = 0; i < 5; i++) await post(payload(c, `msg ${i}`));
  const r = await post(payload(c, 'spam'));
  assert.equal(r.json.results[0].skipped, 'rate-limited');
  const r2 = await post(payload(c, 'spam again'));
  assert.ok(['rate-limited', 'paused-for-human'].includes(r2.json.results[0].skipped));
  assert.equal(aiRequests.length, 5);
});

test('failed delivery status shows up as an alert', async () => {
  const r = await post(wrap({ metadata: { phone_number_id: '111' }, statuses: [{ id: 'wamid.z', status: 'failed', recipient_id: '923700000006', errors: [{ code: 131047, title: 'Re-engagement message' }] }] }));
  assert.equal(r.json.statuses[0].code, 131047);
  const html = await (await fetch(`${base}/admin?b=test-shop`, { headers: AUTH })).text();
  assert.match(html, /923700000006/);
  assert.match(html, /24 ghante/);
});

test('owner alert falls back to an approved template outside the 24h window', async () => {
  config.ownerAlertTemplate = 'owner_alert';
  failTo['923009999999'] = 131047;
  aiQueue.push('{"reply":"Team reply karegi","action":"handoff","handoff_reason":"x"}');
  await post(payload('923700000007', 'manager se baat karao'));
  const tpl = sent.find(s => s.type === 'template');
  assert.equal(tpl.to, '923009999999');
  assert.equal(tpl.template.name, 'owner_alert');
  assert.doesNotMatch(tpl.template.components[0].parameters[0].text, /\n/);
  config.ownerAlertTemplate = '';
});

// ---------------------------------------------------------------- dashboard
test('dashboard requires password, shows orders, locks out brute force', async () => {
  assert.equal((await fetch(`${base}/admin`)).status, 401);
  const res = await fetch(`${base}/admin?b=test-shop`, { headers: AUTH });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Chicken Karahi/);
});

test('dashboard reply goes to the customer and pauses the bot', async () => {
  const c = '923800000001';
  await post(payload(c, 'order kab aayega?'));
  sent = [];
  const r = await form('/admin/send', { b: 'test-shop', c, text: 'Bas 10 minute bhai' });
  assert.equal(r.status, 302);
  assert.equal(sent[0].to, c);
  assert.equal(sent[0].text, 'Bas 10 minute bhai');
  const again = await post(payload(c, 'ok'));
  assert.equal(again.json.results[0].skipped, 'paused-for-human');
});

test('dashboard refuses to message a customer outside the 24h window', async () => {
  const r = await form('/admin/send', { b: 'test-shop', c: '923899999999', text: 'hello' });
  assert.match(decodeURIComponent(r.headers.get('location')), /24 ghante/);
  assert.equal(sent.length, 0);
});

test('order status change notifies the customer', async () => {
  const c = '923800000002';
  aiQueue.push(JSON.stringify({ reply: 'Done', action: 'order', order: { customer_name: 'Sara', items: [{ name: 'Naan', qty: 2 }], address: 'DHA' } }));
  const { json } = await post(payload(c, 'confirm'));
  const id = json.results[0].orderId;
  sent = [];
  await form(`/admin/order/${id}`, { b: 'test-shop', status: 'out_for_delivery', notify: 'on' });
  assert.equal(sent[0].to, c);
  assert.match(sent[0].text, new RegExp(`order #${id} raste mein`));
});

test('cross-site POST to the dashboard is blocked', async () => {
  const r = await form('/admin/resume', { b: 'test-shop', c: '1' }, { Origin: 'https://evil.example' });
  assert.equal(r.status, 403);
});

test('a broken business file is skipped, others keep working', () => {
  assert.ok(loadErrors.some(e => e.startsWith('broken.json')));
  assert.ok(bySlug('test-shop'));
});

test('appointments business uses booking wording', async () => {
  aiQueue.push(JSON.stringify({ reply: 'Booking ho gayi', action: 'order', order: { customer_name: 'Zara', items: [{ name: 'Checkup', qty: 1 }], notes: 'Kal 6pm' } }));
  await post(payload('923900000001', 'haan', '222'));
  assert.match(sent[0].text, /🧾 Booking #\d+[\s\S]*🕒 Kal 6pm/);
  assert.match(systemPrompt(bySlug('test-clinic')), /SERVICES/);
});

// ---------------------------------------------------------------- onboarding
test('embedded signup (coexistence) connects a number and routes its messages', async () => {
  const bad = await fetch(`${base}/onboard?b=test-onboarded&k=wrong`);
  assert.equal(bad.status, 404);
  const k = onboardKey('test-onboarded');
  const page = await fetch(`${base}/onboard?b=test-onboarded&k=${k}`);
  assert.match(await page.text(), /whatsapp_business_app_onboarding/);

  const res = await fetch(`${base}/onboard/complete`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ b: 'test-onboarded', k, code: 'c0de', coexistence: true, phone_number_id: '333', waba_id: 'waba9' }),
  });
  const j = await res.json();
  assert.equal(j.ok, true, JSON.stringify(j));
  assert.ok(graphCalls.some(c => c.url.endsWith('/waba9/subscribed_apps')));
  assert.ok(graphCalls.some(c => c.url.endsWith('/333/smb_app_data') && c.body.sync_type === 'history'));
  assert.ok(graphCalls.some(c => c.url.endsWith('/333/smb_app_data') && c.body.sync_type === 'smb_app_state_sync'));

  sent = [];
  aiQueue.push('{"reply":"Ji, cat food available hai","action":"none"}');
  await post(payload('923910000001', 'cat food hai?', '333'));
  assert.equal(sent[0].text, 'Ji, cat food available hai');
  assert.equal(sent[0].auth, 'Bearer biz-token'); // uses the client's own token
});

// ---------------------------------------------------------------- misc
test('production refuses unsafe config', () => {
  assert.ok(configProblems({ appSecret: '', verifyToken: 'change-me-random-string', adminPassword: 'short', aiApiKey: '' }).length === 4);
  assert.equal(configProblems({ appSecret: 's', verifyToken: 'rand0m', adminPassword: 'a-long-password-123', aiApiKey: 'k' }).length, 0);
});

test('parseAiJson tolerates fences and junk', () => {
  assert.equal(parseAiJson('```json\n{"reply":"hi","action":"none"}\n```').reply, 'hi');
  assert.equal(parseAiJson('just text').reply, 'just text');
  assert.equal(parseAiJson('{"reply":"x","action":"order"}').action, 'none'); // order w/o items
});
