// The AI salesman: Gemini + tools. Prices and bargaining limits are enforced by code.
import { findItem } from './businesses.js';
import { evaluateOffer } from './negotiation.js';
import { saveOrder } from './store.js';

// Comma-separated list, tried in order: when one is rate-limited or overloaded, the next one answers.
const GEMINI_MODELS = (process.env.GEMINI_MODEL || 'gemini-3.8-flash').split(',').map((m) => m.trim()).filter(Boolean);
const MODEL_COOLDOWN_MS = 5 * 60 * 1000;
const GEMINI_URL = (m) => `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`;

const TOOLS = [
  {
    functionDeclarations: [
      {
        name: 'get_catalog',
        description: 'Get the list of items with their normal prices and units. Call this before quoting any price.',
        parameters: { type: 'OBJECT', properties: {} },
      },
      {
        name: 'check_offer',
        description:
          'Use whenever the customer asks for a discount, says "kam karo", or names their own price. Returns what price you may agree to. ALWAYS obey its decision and price.',
        parameters: {
          type: 'OBJECT',
          properties: {
            item: { type: 'STRING', description: 'Item id or name' },
            quantity: { type: 'NUMBER', description: 'How many units the customer wants (default 1)' },
            offered_price: { type: 'NUMBER', description: 'Per-unit price the customer offered, in PKR. 0 if they just asked for discount without a number.' },
          },
          required: ['item', 'offered_price'],
        },
      },
      {
        name: 'add_to_cart',
        description: 'Add an item to the customer order. Uses the agreed bargained price if there is one, else the normal price.',
        parameters: {
          type: 'OBJECT',
          properties: {
            item: { type: 'STRING' },
            quantity: { type: 'NUMBER' },
          },
          required: ['item', 'quantity'],
        },
      },
      {
        name: 'view_cart',
        description: 'Show current cart with totals.',
        parameters: { type: 'OBJECT', properties: {} },
      },
      {
        name: 'remove_from_cart',
        description: 'Remove an item from the cart.',
        parameters: { type: 'OBJECT', properties: { item: { type: 'STRING' } }, required: ['item'] },
      },
      {
        name: 'place_order',
        description: 'Confirm and place the order. Only call after the customer has clearly confirmed the cart total and given name + address (or pickup).',
        parameters: {
          type: 'OBJECT',
          properties: {
            customer_name: { type: 'STRING' },
            address: { type: 'STRING', description: 'Delivery address, or "pickup"' },
            notes: { type: 'STRING' },
          },
          required: ['customer_name', 'address'],
        },
      },
      {
        name: 'handoff_to_owner',
        description: 'Use when the customer is angry, has a complaint, wants something not in the catalog, or insists on talking to a human.',
        parameters: { type: 'OBJECT', properties: { reason: { type: 'STRING' } }, required: ['reason'] },
      },
    ],
  },
];

function systemPrompt(b) {
  return `You are the WhatsApp sales assistant of "${b.name}" (${b.type || 'business'}) in Pakistan.
${b.persona || ''}

LANGUAGE: Reply in the customer's language/style — Roman Urdu if they write Roman Urdu, Urdu script if they write Urdu, English if English. Short WhatsApp-style messages (1–4 lines), friendly, like a smart shopkeeper. Use "aap". A light emoji is ok.

RATES: Never guess a price. Call get_catalog first. Prices are in PKR (Rs).

BARGAINING: Customers in Pakistan love to bargain — play along like a good dukandaar.
- Whenever they ask for a discount or name a price, call check_offer and follow its decision EXACTLY.
- "counter": offer that price as a favour. "final": say it is the last price, warmly but firmly. "accept": agree happily. "no_discount": price is fixed, offer value instead.
- Never invent a lower price yourself, never mention words like "minimum price", "floor" or "system".
- Do not offer a discount before they ask.

ORDERS: Use add_to_cart once a price is settled. Before place_order, show the cart total and ask for confirmation, name and address (or pickup). After place_order, share the order number and expected timing.

OTHER: If you don't know something (stock, timing not listed), say you will confirm with the owner and call handoff_to_owner. Never make promises outside this info. Stay on topic of the business.

BUSINESS INFO:
${b.info || '-'}
${b.delivery ? `Delivery: ${b.delivery}` : ''}
${b.hours ? `Timings: ${b.hours}` : ''}`;
}

function money(n) {
  return `Rs ${Math.round(n).toLocaleString('en-PK')}`;
}

function cartSummary(session) {
  const lines = session.cart.map((c) => ({ ...c, line_total: c.unit_price * c.quantity }));
  return { items: lines, total: lines.reduce((s, l) => s + l.line_total, 0) };
}

function runTool(name, args, ctx) {
  const { business: b, session, customer, notify } = ctx;
  switch (name) {
    case 'get_catalog':
      return {
        currency: 'PKR',
        items: b.items
          .filter((i) => i.available !== false)
          .map((i) => ({ id: i.id, name: i.name, price: i.price, unit: i.unit || 'piece', description: i.description || undefined })),
      };

    case 'check_offer': {
      const item = findItem(b, args.item);
      if (!item) return { error: 'item not found', hint: 'Call get_catalog and use the exact id.' };
      const qty = Math.max(1, Number(args.quantity) || 1);
      const st = (session.bargains[item.id] ||= {});
      const r = evaluateOffer(item, args.offered_price, qty, st, b.negotiation);
      return { item: item.name, normal_price: item.price, decision: r.decision, price: r.price, how_to_reply: r.message_hint };
    }

    case 'add_to_cart': {
      const item = findItem(b, args.item);
      if (!item) return { error: 'item not found' };
      if (item.available === false) return { error: 'out of stock' };
      const qty = Math.max(1, Math.round(Number(args.quantity) || 1));
      const unit = session.bargains[item.id]?.agreed ?? item.price;
      const existing = session.cart.find((c) => c.id === item.id);
      if (existing) {
        existing.quantity = qty;
        existing.unit_price = unit;
      } else session.cart.push({ id: item.id, name: item.name, quantity: qty, unit_price: unit });
      return cartSummary(session);
    }

    case 'view_cart':
      return cartSummary(session);

    case 'remove_from_cart': {
      const item = findItem(b, args.item);
      session.cart = session.cart.filter((c) => c.id !== item?.id);
      return cartSummary(session);
    }

    case 'place_order': {
      if (!session.cart.length) return { error: 'cart is empty' };
      const sum = cartSummary(session);
      const order = {
        order_no: `${(b.order_prefix || 'ORD').toUpperCase()}-${Date.now().toString(36).toUpperCase()}`,
        business: b.name,
        phone_number_id: b.phone_number_id,
        customer_phone: customer,
        customer_name: args.customer_name,
        address: args.address,
        notes: args.notes || '',
        ...sum,
        created_at: new Date().toISOString(),
      };
      saveOrder(order);
      notify?.(
        b,
        `🛒 New order ${order.order_no}\n${order.customer_name} (+${customer})\n` +
          sum.items.map((l) => `• ${l.quantity} × ${l.name} @ ${money(l.unit_price)}`).join('\n') +
          `\nTotal: ${money(sum.total)}\n📍 ${order.address}${order.notes ? `\n📝 ${order.notes}` : ''}`,
      );
      session.cart = [];
      session.bargains = {};
      return { ok: true, order_no: order.order_no, total: sum.total, eta: b.delivery || '' };
    }

    case 'handoff_to_owner':
      session.handoff = true;
      notify?.(b, `🙋 Customer +${customer} needs you: ${args.reason}`);
      return { ok: true, tell_customer: 'Owner will reply shortly.' };

    default:
      return { error: `unknown tool ${name}` };
  }
}

// model => time until which it is skipped (after a quota/overload error or timeout)
const coolingDown = new Map();

async function callModel(model, body) {
  const res = await fetch(GEMINI_URL(model), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: JSON.stringify(body),
    // A stuck request would block this customer's queue forever; on timeout the next model is tried.
    signal: AbortSignal.timeout(Number(process.env.GEMINI_TIMEOUT_MS) || 25000),
  });
  if (!res.ok) {
    const err = new Error(`Gemini ${model} ${res.status}: ${(await res.text()).slice(0, 300)}`);
    err.retryable = res.status === 429 || res.status >= 500;
    throw err;
  }
  return res.json();
}

async function callGemini(body) {
  const now = Date.now();
  const ready = GEMINI_MODELS.filter((m) => !(coolingDown.get(m) > now));
  // All cooling down: try them anyway rather than fail without asking.
  const order = ready.length ? ready : GEMINI_MODELS;
  let lastErr;
  for (const model of order) {
    try {
      return await callModel(model, body);
    } catch (err) {
      const retryable = err.retryable || err.name === 'TimeoutError';
      if (!retryable) throw err;
      coolingDown.set(model, Date.now() + MODEL_COOLDOWN_MS);
      console.warn(`[gemini] ${model} unavailable, trying next model:`, err.message.split('\n')[0]);
      lastErr = err;
    }
  }
  throw lastErr;
}

/** Process one customer message, return reply text. */
export async function reply(args) {
  const start = args.session.history.length;
  try {
    return await converse(args);
  } catch (err) {
    args.session.history.length = start; // roll back a half-finished turn
    throw err;
  }
}

async function converse({ business, session, customer, text, notify, llm = callGemini }) {
  session.history.push({ role: 'user', parts: [{ text }] });

  for (let step = 0; step < 6; step++) {
    const data = await llm({
      systemInstruction: { parts: [{ text: systemPrompt(business) }] },
      contents: session.history,
      tools: TOOLS,
      generationConfig: { temperature: 0.6, maxOutputTokens: 600 },
    });

    const content = data.candidates?.[0]?.content;
    if (!content?.parts?.length) {
      session.history.pop(); // drop the user turn so the chat stays valid
      return business.fallback_reply || 'Maazrat, thori der baad message karein 🙏';
    }
    // Keep the model turn as-is (includes thought signatures needed by Gemini).
    session.history.push({ role: 'model', parts: content.parts });

    const calls = content.parts.filter((p) => p.functionCall);
    if (!calls.length) {
      // Skip thinking parts (some models, e.g. Gemma, return them as text).
      return content.parts.map((p) => (p.thought ? '' : p.text || '')).join('').trim() || '👍';
    }

    session.history.push({
      role: 'user',
      parts: calls.map(({ functionCall: fc }) => ({
        functionResponse: { name: fc.name, response: runTool(fc.name, fc.args || {}, { business, session, customer, notify }) },
      })),
    });
  }
  const msg = 'Ek minute, main owner se confirm kar ke batata hoon 🙏';
  session.history.push({ role: 'model', parts: [{ text: msg }] });
  return msg;
}

export const _internals = { runTool, systemPrompt };
