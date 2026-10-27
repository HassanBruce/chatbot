// WhatsApp Cloud API helpers.
const GRAPH = `https://graph.facebook.com/${process.env.GRAPH_VERSION || 'v25.0'}`;

// Each business may use its own token (when it lives in the client's own WABA).
export function tokenFor(business) {
  return (business.access_token_env && process.env[business.access_token_env]) || process.env.WHATSAPP_TOKEN;
}

async function graph(business, payload) {
  const res = await fetch(`${GRAPH}/${business.phone_number_id}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenFor(business)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`WhatsApp ${res.status}: ${JSON.stringify(body.error || body)}`);
  return body;
}

export function sendText(business, to, text) {
  // WhatsApp text limit is 4096 chars.
  return graph(business, { to, type: 'text', text: { body: String(text).slice(0, 4096), preview_url: false } });
}

// Blue ticks + "typing…" indicator while the AI thinks.
export function markReadAndTyping(business, messageId) {
  return graph(business, {
    status: 'read',
    message_id: messageId,
    typing_indicator: { type: 'text' },
  }).catch(() => {}); // cosmetic, never fail on this
}
