// Chat with the bot in your terminal — no WhatsApp needed.
//   npm run chat                 (first business)
//   npm run chat -- rehmat       (business whose name matches)
import readline from 'node:readline/promises';
import { loadBusinesses } from './businesses.js';
import { reply } from './agent.js';

const all = [...loadBusinesses().values()];
const pick = process.argv[2]?.toLowerCase();
const business = (pick && all.find((b) => b.name.toLowerCase().includes(pick))) || all[0];
const session = { history: [], cart: [], bargains: {}, handoff: false };
const notify = (_b, t) => console.log(`\n\x1b[33m[owner ko message]\n${t}\x1b[0m\n`);

console.log(`Chatting with "${business.name}". Ctrl+C to exit.\n`);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
for (;;) {
  const text = (await rl.question('aap: ')).trim();
  if (!text) continue;
  try {
    console.log(`bot: ${await reply({ business, session, customer: '920000000000', text, notify })}\n`);
  } catch (e) {
    console.error('error:', e.message);
  }
}
