const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const label = s => String(s).replace(/_/g, ' ');

function mediaTag(file) {
  if (!file) return '';
  const url = `/admin/media/${encodeURIComponent(file)}`;
  if (/\.(jpg|png|webp)$/.test(file)) return `<a href="${url}" target="_blank"><img src="${url}" alt="image" class="thumb"></a>`;
  if (/\.(ogg|mp3|m4a|aac)$/.test(file)) return `<audio controls preload="none" src="${url}"></audio>`;
  return `<a href="${url}" target="_blank">📎 file kholein</a>`;
}

export function renderDashboard({ businesses, business, stats, orders, conversations, chat, customer, paused, alerts = [],
  loadErrors = [], statuses, onboard, account, flash }) {
  const b = business;
  const q = s => encodeURIComponent(s);
  const isAppt = b.kind === 'appointments';
  const hidden = (extra = '') => `<input type="hidden" name="b" value="${esc(b.slug)}">${extra}`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(b.name)} · Inbox</title>
<style>
:root{--bg:#f4f5f2;--card:#fff;--ink:#1b1f1d;--mute:#66706a;--line:#e3e6e1;--accent:#0f7b5f;--warn:#b25e09;--bad:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#121513;--card:#1b1f1d;--ink:#e9ece9;--mute:#9aa49e;--line:#2b302d;--accent:#3fbf95;--warn:#e6a35a;--bad:#f2867e}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
header{padding:16px;display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap;border-bottom:1px solid var(--line);background:var(--card)}
h1{font-size:18px;margin:0}h2{font-size:14px;text-transform:uppercase;letter-spacing:.06em;color:var(--mute);margin:24px 0 8px}
main{max-width:980px;margin:0 auto;padding:0 16px 40px}
select,button,input,textarea{font:inherit;padding:6px 10px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--ink)}
button{cursor:pointer}.primary{background:var(--accent);color:#fff;border-color:var(--accent)}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:16px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px}.stat b{display:block;font-size:24px}
.stat span{color:var(--mute);font-size:13px}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}
.row{padding:12px 14px;border-top:1px solid var(--line);display:flex;gap:10px;justify-content:space-between;align-items:flex-start;flex-wrap:wrap}
.row:first-child{border-top:0}.mute{color:var(--mute);font-size:13px}a{color:var(--accent);text-decoration:none}
.pill{font-size:12px;padding:2px 8px;border-radius:99px;border:1px solid currentColor}.paused{color:var(--warn)}.bad{color:var(--bad)}
.bubbles{padding:14px;display:flex;flex-direction:column;gap:8px;max-height:60vh;overflow:auto}
.bub{max-width:80%;padding:8px 12px;border-radius:12px;white-space:pre-wrap;word-wrap:break-word}
.bub small{display:block;color:var(--mute);font-size:11px;margin-top:2px}
.user{align-self:flex-start;background:var(--bg);border:1px solid var(--line)}
.assistant{align-self:flex-end;background:color-mix(in srgb,var(--accent) 16%,var(--card))}
.owner{align-self:flex-end;background:color-mix(in srgb,var(--warn) 18%,var(--card))}
.thumb{max-width:220px;max-height:220px;border-radius:8px;display:block;margin-top:6px}audio{max-width:240px;margin-top:6px}
.empty{padding:20px;color:var(--mute);text-align:center}.flash{margin-top:16px;padding:10px 14px;border-radius:10px;background:color-mix(in srgb,var(--accent) 14%,var(--card))}
.alert{padding:10px 14px;border-top:1px solid var(--line)}.alert:first-child{border-top:0}
form.send{display:flex;gap:8px;padding:12px 14px;border-top:1px solid var(--line)}form.send textarea{flex:1;min-height:44px;resize:vertical}
code{font-size:12px;word-break:break-all}
</style></head><body>
<header><h1>${esc(b.name)} <span class="mute">· WhatsApp assistant${b.coexistence ? ' · app + bot' : ''}</span></h1>
<div style="display:flex;gap:8px"><form method="get"><select name="b" onchange="this.form.submit()">
${businesses.map(x => `<option value="${esc(x.slug)}"${x.slug === b.slug ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}
</select></form><form method="post" action="/admin/reload">${hidden()}<button title="Reload business files">↻</button></form></div></header>
<main>
${flash ? `<div class="flash">${esc(flash)}</div>` : ''}
${loadErrors.length ? `<div class="flash bad">Business files with errors (skipped):<br>${loadErrors.map(esc).join('<br>')}</div>` : ''}
<div class="stats">
<div class="stat"><b>${stats.messagesToday}</b><span>Messages today</span></div>
<div class="stat"><b>${stats.customers}</b><span>Customers</span></div>
<div class="stat"><b>${stats.ordersNew}</b><span>New ${isAppt ? 'bookings' : 'orders'}</span></div>
</div>

${alerts.length ? `<h2>Attention</h2><div class="card">${alerts.map(a => `<div class="alert"><span class="bad">⚠</span> ${esc(a.text)} <span class="mute">${esc(a.created_at)} UTC</span></div>`).join('')}</div>` : ''}

${chat ? `<h2>Chat with +${esc(customer)} ${paused ? '<span class="pill paused">bot paused</span>' : ''} · <a href="/admin?b=${q(b.slug)}">back</a></h2>
<div class="card"><div class="bubbles">
${chat.map(m => `<div class="bub ${esc(m.role)}">${esc(m.content)}${mediaTag(m.media)}<small>${m.role === 'owner' ? 'team · ' : m.role === 'assistant' ? 'bot · ' : ''}${esc(m.created_at)} UTC</small></div>`).join('') || '<div class="empty">No messages</div>'}
</div>
<form method="post" action="/admin/send" class="send">${hidden(`<input type="hidden" name="c" value="${esc(customer)}">`)}
<textarea name="text" placeholder="Customer ko reply likhein (bot is chat mein pause ho jayega)" required></textarea><button class="primary">Send</button></form>
<div class="row"><span class="mute">${paused ? 'Bot is chat mein chup hai.' : 'Bot is chat mein reply kar raha hai.'}</span>
${paused
    ? `<form method="post" action="/admin/resume">${hidden(`<input type="hidden" name="c" value="${esc(customer)}">`)}<button>Bot wapas on</button></form>`
    : `<form method="post" action="/admin/pause">${hidden(`<input type="hidden" name="c" value="${esc(customer)}">`)}<button>Bot off (main khud baat karunga)</button></form>`}
</div></div>` : ''}

<h2>${isAppt ? 'Bookings' : 'Orders'}</h2>
<div class="card">
${orders.map(o => `<div class="row"><div><b>#${o.id}</b> ${esc(o.customer_name || '')} <a href="/admin?b=${q(b.slug)}&c=${q(o.customer)}">+${esc(o.customer)}</a>
${o.flagged ? '<span class="pill bad">verify</span>' : ''}
<div>${o.items.map(i => `${esc(i.qty ?? 1)} × ${esc(i.name)}${i.price != null ? ` <span class="mute">Rs ${esc(i.price)}</span>` : ''}${i.unverified ? ' <span class="bad">(not in catalog)</span>' : ''}`).join('<br>')}</div>
${o.total ? `<div><b>Rs ${esc(o.total)}</b></div>` : ''}
${o.address ? `<div class="mute">📍 ${esc(o.address)}</div>` : ''}${o.notes ? `<div class="mute">📝 ${esc(o.notes)}</div>` : ''}
<div class="mute">${esc(o.created_at)} UTC</div></div>
<form method="post" action="/admin/order/${o.id}">${hidden()}
<select name="status" onchange="this.form.submit()">${statuses.map(s => `<option value="${s}"${s === o.status ? ' selected' : ''}>${label(s)}</option>`).join('')}</select>
<label class="mute" style="display:block;margin-top:4px"><input type="checkbox" name="notify" checked> customer ko batayein</label></form></div>`).join('')
  || `<div class="empty">No ${isAppt ? 'bookings' : 'orders'} yet</div>`}
</div>

<h2>Conversations</h2>
<div class="card">
${conversations.map(c => {
    const p = c.paused_until && new Date(c.paused_until + 'Z') > new Date();
    return `<div class="row"><div><a href="/admin?b=${q(b.slug)}&c=${q(c.customer)}">+${esc(c.customer)}</a>
${p ? '<span class="pill paused">human handling</span>' : ''}
<div class="mute">${c.last_role === 'owner' ? 'team: ' : c.last_role === 'assistant' ? 'bot: ' : ''}${esc(String(c.last_message).slice(0, 90))}</div></div><span class="mute">${esc(c.last_at)}</span></div>`;
  }).join('') || '<div class="empty">No conversations yet</div>'}
</div>

<h2>WhatsApp number</h2>
<div class="card"><div class="row"><div>
${account ? `Connected: <code>${esc(account.phone_number_id)}</code> ${account.coexistence ? '<span class="pill">coexistence</span>' : ''}<div class="mute">${esc(account.sync_status ?? '')}</div>`
    : b.phone_number_id && !String(b.phone_number_id).startsWith('PUT_') ? `From business file: <code>${esc(b.phone_number_id)}</code>` : '<span class="bad">Koi number connect nahi</span>'}
${onboard ? `<div class="mute" style="margin-top:8px">Client ke liye connect link (private rakhein):</div><code>${esc(onboard)}</code>` : ''}
</div></div></div>
</main><script>const bb=document.querySelector('.bubbles');if(bb)bb.scrollTop=bb.scrollHeight</script></body></html>`;
}
