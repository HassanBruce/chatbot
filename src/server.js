import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config, configProblems } from './config.js';
import { validSignature, extractEvents } from './whatsapp.js';
import { handleIncoming, handleEcho, handleStatus, ownerSend, notifyStatus, flushPending, STATUSES } from './bot.js';
import { allBusinesses, bySlug, loadBusinesses, loadErrors, withNumber } from './businesses.js';
import * as db from './db.js';
import { renderDashboard } from './dashboard.js';
import { renderOnboardPage, completeOnboarding, validKey, onboardLink, onboardingConfigured } from './onboard.js';

export function createApp({ awaitProcessing = false } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // behind Caddy
  app.use(express.json({ limit: '2mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));
  app.use((_req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' });
    next();
  });

  app.get('/health', (_req, res) => {
    try {
      db.getDb().prepare('SELECT 1').get();
      res.json({ ok: true, businesses: allBusinesses().length, configErrors: loadErrors.length });
    } catch (e) {
      res.status(503).json({ ok: false, error: e.message });
    }
  });

  // Meta webhook verification handshake
  app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    if (mode === 'subscribe' && config.verifyToken && token === config.verifyToken) {
      return res.status(200).send(req.query['hub.challenge']);
    }
    return res.sendStatus(403);
  });

  // Inbound events: customer messages, coexistence echoes, delivery statuses, sync webhooks
  app.post('/webhook', async (req, res) => {
    if (!validSignature(req.rawBody ?? Buffer.from(''), req.get('x-hub-signature-256'))) {
      return res.sendStatus(401);
    }
    const ev = extractEvents(req.body);
    for (const o of ev.other) console.log(`[webhook] ${o.field} for ${o.phoneNumberId ?? '-'} (acknowledged)`);
    const safe = (fn, x) => Promise.resolve().then(() => fn(x)).catch(e => {
      console.error('[webhook] handler error', e);
      return { error: e.message };
    });
    // Echoes first: if the owner replied in the same batch, the bot must already know.
    const work = (async () => {
      const echoes = await Promise.all(ev.echoes.map(e => safe(handleEcho, e)));
      const statuses = ev.statuses.map(s => handleStatus(s));
      const messages = await Promise.all(ev.messages.map(m => safe(handleIncoming, m)));
      return { messages, echoes, statuses };
    })();
    // Meta wants a fast 200; process after responding (tests can await).
    if (awaitProcessing) {
      const r = await work;
      return res.json({ results: r.messages, echoes: r.echoes, statuses: r.statuses });
    }
    res.sendStatus(200);
  });

  // ---- Client onboarding (Embedded Signup, private link per business) ----
  app.get('/onboard', (req, res) => {
    const b = bySlug(req.query.b);
    if (!b || !validKey(b.slug, req.query.k)) return res.status(404).send('Link invalid hai.');
    res.send(renderOnboardPage(b, req.query.k));
  });
  app.post('/onboard/complete', async (req, res) => {
    const { b: slug, k, code, phone_number_id, waba_id, coexistence, pin } = req.body ?? {};
    const b = bySlug(slug);
    if (!b || !validKey(slug, k)) return res.status(403).json({ ok: false, error: 'Link invalid hai.' });
    if (!onboardingConfigured()) return res.status(503).json({ ok: false, error: 'Onboarding configured nahi.' });
    const r = await completeOnboarding({ slug, code, phone_number_id, waba_id, coexistence: !!coexistence, pin });
    res.status(r.ok ? 200 : 400).json(r);
  });

  // ---- Admin dashboard (basic auth + brute-force lockout + same-origin POSTs) ----
  const fails = new Map(); // ip -> { n, until }
  const auth = (req, res, next) => {
    if (!config.adminPassword) return res.status(503).send('Set ADMIN_PASSWORD in .env to enable the dashboard.');
    const ip = req.ip;
    const f = fails.get(ip);
    if (f && f.until > Date.now()) return res.status(429).send('Bohot ghalat attempts. 15 minute baad try karein.');
    const [, b64] = (req.get('authorization') ?? '').split(' ');
    const decoded = Buffer.from(b64 ?? '', 'base64').toString();
    const pass = decoded.slice(decoded.indexOf(':') + 1);
    const a = crypto.createHash('sha256').update(pass).digest();
    const b = crypto.createHash('sha256').update(config.adminPassword).digest();
    if (b64 && crypto.timingSafeEqual(a, b)) { fails.delete(ip); return next(); }
    if (b64) {
      const n = (f?.n ?? 0) + 1;
      fails.set(ip, { n, until: n >= 10 ? Date.now() + 15 * 60 * 1000 : 0 });
    }
    res.set('WWW-Authenticate', 'Basic realm="wabot"').sendStatus(401);
  };
  const sameOrigin = (req, res, next) => {
    const origin = req.get('origin') ?? req.get('referer');
    if (!origin) return next(); // non-browser clients
    try {
      if (new URL(origin).host === req.get('host')) return next();
    } catch { /* fallthrough */ }
    res.status(403).send('Cross-site request blocked');
  };
  const adminHeaders = (_req, res, next) => {
    res.set({
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; media-src 'self'; frame-ancestors 'none'",
      'Cache-Control': 'no-store',
    });
    next();
  };
  app.use('/admin', adminHeaders, auth);
  app.post('/admin/*', sameOrigin);

  const back = (b, c, flash) =>
    `/admin?b=${encodeURIComponent(b ?? '')}${c ? `&c=${encodeURIComponent(c)}` : ''}${flash ? `&f=${encodeURIComponent(flash)}` : ''}`;

  app.get('/admin', (req, res) => {
    const businesses = allBusinesses();
    const b = withNumber(bySlug(req.query.b) ?? businesses[0]);
    if (!b) return res.send(`No businesses configured. Add a JSON file in ./businesses${loadErrors.length ? `<pre>${loadErrors.join('\n')}</pre>` : ''}`);
    const account = db.accountForSlug(b.slug);
    res.send(renderDashboard({
      businesses, business: b,
      stats: db.stats(b.slug),
      orders: db.listOrders(b.slug, 50),
      conversations: db.listConversations(b.slug, 30),
      chat: req.query.c ? db.history(b.slug, req.query.c, 200) : null,
      customer: req.query.c ?? null,
      paused: req.query.c ? db.isPaused(b.slug, req.query.c) : false,
      alerts: db.listAlerts(b.slug),
      loadErrors,
      statuses: STATUSES[b.kind === 'appointments' ? 'appointments' : 'orders'],
      onboard: onboardingConfigured() ? onboardLink(b.slug) : null,
      account,
      flash: req.query.f ?? null,
    }));
  });

  app.post('/admin/order/:id', async (req, res) => {
    const b = withNumber(bySlug(req.body.b));
    const order = db.getOrder(Number(req.params.id));
    const status = String(req.body.status ?? '');
    if (!b || !order || order.business !== b.slug) return res.status(404).send('Not found');
    if (!STATUSES[b.kind === 'appointments' ? 'appointments' : 'orders'].includes(status)) return res.status(400).send('Bad status');
    db.setOrderStatus(order.id, status);
    let flash = `#${order.id} → ${status}`;
    if (req.body.notify === 'on' && status !== order.status) {
      const r = await notifyStatus(b, order, status);
      flash += r.ok ? (r.skipped ? '' : ' · customer ko bata diya') : ` · customer ko message nahi gaya (${r.error})`;
    }
    res.redirect(back(b.slug, null, flash));
  });

  app.post('/admin/send', async (req, res) => {
    const b = withNumber(bySlug(req.body.b));
    const text = String(req.body.text ?? '').trim();
    if (!b || !req.body.c || !text) return res.redirect(back(req.body.b, req.body.c, 'Message khali hai'));
    const r = await ownerSend(b, req.body.c, text.slice(0, 4000));
    res.redirect(back(b.slug, req.body.c, r.ok ? 'Bhej diya — bot is chat mein paused hai' : `Nahi gaya: ${r.error}`));
  });

  app.post('/admin/resume', (req, res) => {
    db.resume(req.body.b, req.body.c);
    res.redirect(back(req.body.b, req.body.c, 'Bot on'));
  });
  app.post('/admin/pause', (req, res) => {
    db.pause(req.body.b, req.body.c, config.handoffPauseHours);
    res.redirect(back(req.body.b, req.body.c, `Bot ${config.handoffPauseHours} ghante ke liye off`));
  });

  app.post('/admin/reload', (req, res) => {
    loadBusinesses();
    res.redirect(back(req.body.b, null, loadErrors.length ? `Reload: ${loadErrors.length} file(s) mein error` : 'Reloaded'));
  });

  app.get('/admin/media/:file', (req, res) => {
    const name = path.basename(req.params.file);
    const file = path.resolve(config.dataDir, 'media', name);
    if (!/^[a-z0-9-]+-\d+-[0-9a-f]{8}\.[a-z0-9]+$/.test(name) || !fs.existsSync(file)) return res.sendStatus(404);
    res.sendFile(file);
  });

  return app;
}

function startMaintenance() {
  const run = () => {
    try { db.cleanup(); const f = db.backup(); if (f) console.log(`[maint] backup ${f}`); }
    catch (e) { console.error('[maint] failed', e.message); }
  };
  setTimeout(run, 60 * 1000).unref();
  setInterval(run, 24 * 3600 * 1000).unref();
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const problems = configProblems();
  if (problems.length) {
    const msg = problems.map(p => ` - ${p}`).join('\n');
    if (config.production) { console.error(`Refusing to start in production:\n${msg}`); process.exit(1); }
    console.warn(`Config warnings (ok for local dev):\n${msg}`);
  }
  db.getDb();
  const n = loadBusinesses().length;
  const server = createApp().listen(config.port, () => {
    console.log(`wabot listening on :${config.port} — ${n} business(es) loaded, model ${config.aiModel}`);
  });
  startMaintenance();

  let stopping = false;
  const shutdown = async sig => {
    if (stopping) return;
    stopping = true;
    console.log(`[wabot] ${sig}: finishing pending replies…`);
    server.close();
    await Promise.race([flushPending(), new Promise(r => setTimeout(r, 20000))]);
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('unhandledRejection', e => console.error('[wabot] unhandled rejection', e));
}
