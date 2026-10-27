// Bargaining is decided HERE in code, not by the AI.
// The AI only talks; it can never go below the owner's min_price,
// because it never even sees min_price.

function roundTo(n, step) {
  return Math.ceil(n / step) * step;
}

// Floor for this quantity (bulk orders can unlock a lower floor).
export function floorFor(item, quantity = 1) {
  if (item.bulk && quantity >= item.bulk.min_qty && typeof item.bulk.min_price === 'number') {
    return Math.min(item.min_price, item.bulk.min_price);
  }
  return item.min_price;
}

/**
 * state: per-customer, per-item { rounds, lastCounter, agreed }
 * returns { decision, price, message_hint }
 *   decision: 'accept' | 'counter' | 'final' | 'no_discount'
 */
export function evaluateOffer(item, offered, quantity, state, cfg = {}) {
  const maxRounds = cfg.max_rounds ?? 3;
  const step = cfg.round_to ?? 10;
  const list = item.price;
  const floor = floorFor(item, quantity);
  const gap = list - floor;

  if (gap <= 0) {
    return { decision: 'no_discount', price: list, message_hint: 'Fixed price item. Politely say this is already the best price; offer something else instead (quality, quick delivery).' };
  }

  offered = Number(offered);
  if (!Number.isFinite(offered) || offered <= 0) {
    return { decision: 'counter', price: state.lastCounter ?? list, message_hint: 'Customer did not name a clear price. Ask what price they have in mind.' };
  }

  // Customer offered list price or more: accept at list price.
  if (offered >= list) {
    state.agreed = list;
    return { decision: 'accept', price: list, message_hint: 'Deal at the normal price.' };
  }

  state.rounds = (state.rounds ?? 0) + 1;

  // Concession schedule: first counter gives ~30% of the gap, then ~60%, then the floor.
  const fractions = [0.3, 0.6, 1.0];
  const idx = Math.min(state.rounds - 1, fractions.length - 1);
  let counter = roundTo(list - gap * fractions[idx], step);
  if (state.rounds >= maxRounds) counter = floor;
  counter = Math.max(floor, Math.min(list, counter));
  // Never move backwards (never raise the price after a lower counter).
  if (state.lastCounter != null) counter = Math.min(counter, state.lastCounter);

  // Offer meets our current counter (and is above floor) → accept THEIR price.
  if (offered >= counter && offered >= floor) {
    state.agreed = offered;
    return { decision: 'accept', price: offered, message_hint: 'Accept happily, maybe with a small friendly line like "aap ke liye special".' };
  }

  state.lastCounter = counter;

  if (counter <= floor) {
    // At the floor — nothing more to give.
    if (offered >= floor) {
      state.agreed = offered;
      return { decision: 'accept', price: offered, message_hint: 'Accept.' };
    }
    return {
      decision: 'final',
      price: floor,
      message_hint: 'This is the FINAL price. Say it warmly but firmly (e.g. "is se kam mumkin nahi, already loss par de rahe hain"). Do not lower again.',
    };
  }

  return {
    decision: 'counter',
    price: counter,
    message_hint: 'Counter with this price. Act like it is a favour, mention quality/value. Do not reveal any lower number.',
  };
}
