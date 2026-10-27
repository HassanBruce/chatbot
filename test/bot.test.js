import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wabot-'));
const { evaluateOffer } = await import('../src/negotiation.js');
const { loadBusinesses } = await import('../src/businesses.js');
const { reply } = await import('../src/agent.js');

const lawn = { id: 'lawn', name: 'Lawn', price: 4500, min_price: 3800, bulk: { min_qty: 3, min_price: 3500 } };
const cfg = { max_rounds: 3, round_to: 50 };

test('never goes below floor, counters move down, ends at final', () => {
  const st = {};
  const r1 = evaluateOffer(lawn, 3000, 1, st, cfg);
  assert.equal(r1.decision, 'counter');
  assert.ok(r1.price < 4500 && r1.price > 3800, `r1 ${r1.price}`);
  const r2 = evaluateOffer(lawn, 3000, 1, st, cfg);
  assert.equal(r2.decision, 'counter');
  assert.ok(r2.price < r1.price && r2.price >= 3800, `r2 ${r2.price}`);
  const r3 = evaluateOffer(lawn, 3000, 1, st, cfg);
  assert.equal(r3.decision, 'final');
  assert.equal(r3.price, 3800);
  const r4 = evaluateOffer(lawn, 3000, 1, st, cfg);
  assert.equal(r4.price, 3800, 'stays at floor');
  assert.equal(st.agreed, undefined);
});

test('accepts a reasonable offer at the customer price', () => {
  const st = {};
  const r = evaluateOffer(lawn, 4300, 1, st, cfg);
  assert.equal(r.decision, 'accept');
  assert.equal(st.agreed, 4300);
});

test('bulk quantity unlocks lower floor', () => {
  const st = {};
  let r;
  for (let i = 0; i < 4; i++) r = evaluateOffer(lawn, 3000, 3, st, cfg);
  assert.equal(r.price, 3500);
});

test('fixed price item gives no discount', () => {
  const r = evaluateOffer({ id: 's', name: 'Shawl', price: 2500, min_price: 2500 }, 2000, 1, {}, cfg);
  assert.equal(r.decision, 'no_discount');
  assert.equal(r.price, 2500);
});

test('sample business config loads', () => {
  const m = loadBusinesses(path.resolve('businesses'));
  assert.ok(m.get('1381552225045299'));
});

test('full flow with a fake LLM: catalog → bargain → cart → order', async () => {
  const business = loadBusinesses(path.resolve('businesses')).get('1381552225045299');
  const session = { history: [], cart: [], bargains: {}, handoff: false };
  const notes = [];
  const script = [
    { functionCall: { name: 'get_catalog', args: {} } },
    { text: 'Lawn 3 piece Rs 4,500 ka hai baji' },
    { functionCall: { name: 'check_offer', args: { item: 'lawn-3pc', offered_price: 4000, quantity: 1 } } },
    { text: 'ok' },
    { functionCall: { name: 'check_offer', args: { item: 'lawn-3pc', offered_price: 4000, quantity: 1 } } },
    { text: 'ok' },
    { functionCall: { name: 'add_to_cart', args: { item: 'lawn-3pc', quantity: 1 } } },
    { functionCall: { name: 'place_order', args: { customer_name: 'Ayesha', address: 'Model Town Lahore' } } },
    { text: 'Order ho gaya!' },
  ];
  const seenToolResults = [];
  const llm = async (body) => {
    const last = body.contents.at(-1);
    if (last.parts[0].functionResponse) seenToolResults.push(last.parts[0].functionResponse.response);
    // make sure the floor is never sent to the model
    assert.ok(!JSON.stringify(body).includes('3800'), 'min_price leaked to LLM');
    return { candidates: [{ content: { role: 'model', parts: [script.shift()] } }] };
  };
  const run = (text) => reply({ business, session, customer: '923000000000', text, llm, notify: (_b, t) => notes.push(t) });

  assert.match(await run('lawn ka rate?'), /4,500/);
  await run('4000 kar do');
  await run('4000 final');
  assert.equal(await run('theek hai bhej do, Ayesha, Model Town'), 'Order ho gaya!');

  const order = seenToolResults.find((r) => r.order_no);
  assert.ok(order, 'order placed');
  assert.ok(order.total >= 3800 && order.total <= 4500);
  assert.match(notes[0], /New order/);
  assert.equal(session.cart.length, 0);
  const lines = fs.readFileSync(path.join(process.env.DATA_DIR, 'orders.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
});
