// Talk to a business bot in your terminal — no WhatsApp needed.
// Usage: node --no-warnings scripts/chat.js demo-restaurant
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { bySlug, allBusinesses, systemPrompt, priceOrder } from '../src/businesses.js';
import { chat, parseAiJson } from '../src/ai.js';
import { config } from '../src/config.js';

const slug = process.argv[2] ?? allBusinesses()[0]?.slug;
const b = bySlug(slug);
if (!b) { console.error(`No business "${slug}". Available: ${allBusinesses().map(x => x.slug).join(', ')}`); process.exit(1); }
if (!config.aiApiKey) { console.error('Set AI_API_KEY in .env first.'); process.exit(1); }

const history = [{ role: 'system', content: systemPrompt(b) }];
const rl = readline.createInterface({ input: stdin, output: stdout });
console.log(`Chatting as a customer of "${b.name}" (model ${config.aiModel}). Ctrl+C to quit.\n`);

while (true) {
  const text = await rl.question('you> ');
  if (!text.trim()) continue;
  history.push({ role: 'user', content: text });
  try {
    const r = parseAiJson(await chat(history));
    history.push({ role: 'assistant', content: r.reply });
    console.log(`bot> ${r.reply}`);
    if (r.action === 'order') {
      const p = priceOrder(b, r.order.items);
      console.log('     [ORDER]', JSON.stringify({ ...r.order, items: p.items }), `total=Rs ${p.total}${p.flagged ? ' ⚠ verify' : ''}`);
    }
    if (r.action === 'handoff') console.log('     [HANDOFF]', r.handoff_reason ?? '');
  } catch (e) {
    console.log('     [AI ERROR]', e.message);
  }
}
