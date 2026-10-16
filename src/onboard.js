import crypto from 'node:crypto';
import { config } from './config.js';
import * as db from './db.js';
import { graph } from './whatsapp.js';

/**
 * Embedded Signup: the client opens a private link, logs in with Facebook and picks their number.
 * "Coexistence" mode keeps their WhatsApp Business app working on the same number.
 *
 * Needs (Meta App Dashboard): META_APP_ID, WA_APP_SECRET, an Embedded Signup configuration (ES_CONFIG_ID),
 * your DOMAIN in "Allowed domains" for the JavaScript SDK, and Tech Provider status (or test with your own
 * business while the app is in development mode — Meta's rules change, so check the docs).
 */

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function secret() {
  return `onboard:${config.adminPassword}:${config.appSecret}`;
}
export function onboardKey(slug) {
  return crypto.createHmac('sha256', secret()).update(slug).digest('hex').slice(0, 32);
}
export function validKey(slug, k) {
  const a = Buffer.from(onboardKey(slug));
  const b = Buffer.from(String(k ?? ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
export function onboardLink(slug) {
  return `${config.domain ? `https://${config.domain}` : ''}/onboard?b=${encodeURIComponent(slug)}&k=${onboardKey(slug)}`;
}
export const onboardingConfigured = () => !!(config.metaAppId && config.esConfigId && config.appSecret);

export function renderOnboardPage(business, key) {
  const ready = onboardingConfigured();
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect WhatsApp · ${esc(business.name)}</title>
<style>
:root{--bg:#f4f5f2;--card:#fff;--ink:#1b1f1d;--mute:#66706a;--line:#e3e6e1;--accent:#0f7b5f;--warn:#b25e09}
@media (prefers-color-scheme:dark){:root{--bg:#121513;--card:#1b1f1d;--ink:#e9ece9;--mute:#9aa49e;--line:#2b302d;--accent:#3fbf95;--warn:#e6a35a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:560px;margin:0 auto;padding:32px 16px}h1{font-size:22px;margin:0 0 4px}.mute{color:var(--mute)}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px;margin-top:16px}
button{font:inherit;width:100%;padding:12px;border-radius:10px;border:0;background:var(--accent);color:#fff;cursor:pointer;margin-top:10px}
button.alt{background:transparent;color:var(--ink);border:1px solid var(--line)}
input{font:inherit;padding:10px;border-radius:8px;border:1px solid var(--line);width:100%;background:var(--card);color:var(--ink)}
ul{padding-left:20px;margin:8px 0}#out{margin-top:16px;white-space:pre-wrap}.warn{color:var(--warn)}
</style></head><body><main>
<h1>${esc(business.name)}</h1>
<div class="mute">WhatsApp assistant connect karein</div>
${ready ? `
<div class="card">
<b>Option 1 — Mera number already WhatsApp Business app pe hai</b> <span class="mute">(recommended)</span>
<ul class="mute"><li>App chalta rahega, bot saath mein reply karega</li><li>Aap app se reply karein to bot us chat mein khud chup ho jata hai</li>
<li>Broadcast lists aur kuch app features band ho jate hain</li><li>Phone pe WhatsApp Business app update aur open rakhein</li></ul>
<button onclick="launch(true)">WhatsApp Business app wala number connect karein</button>
</div>
<div class="card">
<b>Option 2 — Naya number (sirf API)</b>
<div class="mute">Ye number phir normal WhatsApp app pe nahi chalega. 6-digit PIN chunein (two-step verification).</div>
<input id="pin" inputmode="numeric" maxlength="6" placeholder="6-digit PIN" style="margin-top:10px">
<button class="alt" onclick="launch(false)">Naya number connect karein</button>
</div>` : `<div class="card warn">Onboarding abhi configure nahi hai (META_APP_ID, ES_CONFIG_ID, WA_APP_SECRET).</div>`}
<div id="out" class="mute"></div>
</main>
${ready ? `<script>
const B=${JSON.stringify(business.slug)},K=${JSON.stringify(key)};let session=null;
const out=t=>document.getElementById('out').textContent=t;
window.fbAsyncInit=function(){FB.init({appId:${JSON.stringify(config.metaAppId)},autoLogAppEvents:true,xfbml:false,version:${JSON.stringify(config.graphVersion)}})};
window.addEventListener('message',ev=>{
  try{ if(!new URL(ev.origin).hostname.endsWith('facebook.com'))return;
    const d=typeof ev.data==='string'?JSON.parse(ev.data):ev.data;
    if(d&&d.type==='WA_EMBEDDED_SIGNUP'){ if(String(d.event||'').startsWith('FINISH'))session=d.data||{};
      else if(d.event==='CANCEL')out('Cancel ho gaya'+(d.data&&d.data.current_step?' ('+d.data.current_step+')':'')+'.');
      else if(d.event==='ERROR')out('Error: '+JSON.stringify(d.data)); } }catch(e){}
});
function launch(coex){
  const pin=coex?null:document.getElementById('pin').value.trim();
  if(!coex&&!/^\\d{6}$/.test(pin)){out('6-digit PIN likhein.');return}
  out('Facebook window khul rahi hai…');
  FB.login(r=>{ if(r.authResponse&&r.authResponse.code)finish(r.authResponse.code,coex,pin); else out('Login complete nahi hua.'); },
    {config_id:${JSON.stringify(config.esConfigId)},response_type:'code',override_default_response_type:true,
     extras:Object.assign({setup:{},sessionInfoVersion:'3'},coex?{featureType:'whatsapp_business_app_onboarding'}:{})});
}
async function finish(code,coex,pin){
  out('Connect ho raha hai, 1-2 minute lag sakte hain…');
  for(let i=0;i<40&&!session;i++)await new Promise(r=>setTimeout(r,250));
  const res=await fetch('/onboard/complete',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({b:B,k:K,code,coexistence:coex,pin,phone_number_id:session&&session.phone_number_id,waba_id:session&&session.waba_id})});
  const j=await res.json().catch(()=>({error:'Server error'}));
  out(j.ok?'✅ Ho gaya! '+(j.message||''):'❌ '+(j.error||'Kuch ghalat ho gaya'));
}
</script>
<script async defer crossorigin="anonymous" src="https://connect.facebook.net/en_US/sdk.js"></script>` : ''}
</body></html>`;
}

/** Exchanges the Embedded Signup code, subscribes our app to the WABA, and (coexistence) starts the sync. */
export async function completeOnboarding({ slug, code, phone_number_id, waba_id, coexistence, pin }) {
  if (!code || !phone_number_id || !waba_id) {
    return { ok: false, error: 'Signup se phone_number_id / waba_id nahi mila. Dobara try karein.' };
  }
  const steps = [];

  // 1. code → business integration token
  const q = new URLSearchParams({ client_id: config.metaAppId, client_secret: config.appSecret, code });
  let token;
  try {
    const r = await fetch(`${config.graphBase}/${config.graphVersion}/oauth/access_token?${q}`, { signal: AbortSignal.timeout(15000) });
    const j = await r.json();
    token = j.access_token;
    if (!token) return { ok: false, error: `Token exchange failed: ${j.error?.message ?? r.status}` };
  } catch (e) {
    return { ok: false, error: `Token exchange failed: ${e.message}` };
  }

  // 2. receive this WABA's webhooks
  const sub = await graph(token, `${waba_id}/subscribed_apps`);
  steps.push(`subscribe:${sub.ok ? 'ok' : sub.error?.message}`);
  if (!sub.ok) return { ok: false, error: `Webhook subscription failed: ${sub.error?.message}` };

  if (coexistence) {
    // 3. Coexistence: sync contacts + history once, within 24h of onboarding (Meta requirement)
    for (const sync_type of ['smb_app_state_sync', 'history']) {
      const s = await graph(token, `${phone_number_id}/smb_app_data`, { body: { messaging_product: 'whatsapp', sync_type } });
      steps.push(`${sync_type}:${s.ok ? 'ok' : s.error?.message}`);
    }
  } else {
    // 3. New API-only number must be registered with a 2-step PIN
    const reg = await graph(token, `${phone_number_id}/register`, { body: { messaging_product: 'whatsapp', pin } });
    steps.push(`register:${reg.ok ? 'ok' : reg.error?.message}`);
    if (!reg.ok) return { ok: false, error: `Number register nahi hua: ${reg.error?.message}` };
  }

  db.saveAccount({ phone_number_id, business_slug: slug, waba_id, access_token: token, coexistence, sync_status: steps.join(', ') });
  console.log(`[onboard] ${slug} connected ${phone_number_id} (coexistence=${!!coexistence}) ${steps.join(', ')}`);
  return {
    ok: true,
    message: coexistence
      ? 'Bot aapke number pe live hai. WhatsApp Business app chalta rahega — aap app se reply karein to bot us chat mein chup ho jayega.'
      : 'Bot aapke number pe live hai.',
    steps,
  };
}
