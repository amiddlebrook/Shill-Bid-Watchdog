// Transparent heuristics: an alert is a reason to review evidence, never an accusation.
export function assessBids(bids, context = {}) {
  const items = bids.map((b, i) => ({ bidder: String(b.bidder ?? b.bidder_id ?? '').trim(), amount: Number(b.amount), index: i }));
  const valid = items.filter(b => b.bidder && Number.isFinite(b.amount) && b.amount > 0);
  const counts = new Map();
  for (const b of valid) counts.set(b.bidder, (counts.get(b.bidder) || 0) + 1);
  const leaders = [...counts].sort((a, b) => b[1] - a[1]);
  const rules = [];
  const add = (id, title, points, explanation, evidence) => rules.push({ id, title, points, explanation, evidence });
  if (valid.length >= 6 && leaders[0]?.[1] / valid.length >= .45) {
    add('dominant-bidder', 'Bidder concentration', 21, 'One bidder placed at least 45% of recorded bids.', `${leaders[0][0]}: ${leaders[0][1]} of ${valid.length} bids`);
  }
  if (valid.length >= 8 && leaders.length >= 2 && (leaders[0][1] + leaders[1][1]) / valid.length >= .75) {
    add('two-bidder', 'Two-bidder concentration', 14, 'Two bidders account for at least 75% of bids.', `${leaders[0][0]} and ${leaders[1][0]}: ${leaders[0][1] + leaders[1][1]} of ${valid.length}`);
  }
  const pairs = new Map();
  for (let i = 1; i < valid.length; i++) {
    if (valid[i].bidder === valid[i - 1].bidder) continue;
    const pair = [valid[i].bidder, valid[i - 1].bidder].sort().join(' / ');
    pairs.set(pair, (pairs.get(pair) || 0) + 1);
  }
  const duel = [...pairs].sort((a, b) => b[1] - a[1])[0];
  if (valid.length >= 6 && duel?.[1] >= 5) add('repeat-duel', 'Repeated head-to-head bidding', 18, 'The same pair alternated across at least five bid transitions.', `${duel[0]}: ${duel[1]} transitions`);
  const start = Number(context.startPrice);
  const maximum = Math.max(0, ...valid.map(b => b.amount));
  if (Number.isFinite(start) && start > 0 && maximum >= start * 5 && valid.length >= 3) {
    add('price-multiple', 'Large increase from opening price', 12, 'Highest observed bid exceeds five times the documented opening price.', `$${maximum.toFixed(2)} vs $${start.toFixed(2)} opening`);
  }
  let penny = 0;
  for (let i = 1; i < valid.length; i++) {
    const difference = Math.round((valid[i].amount - valid[i-1].amount) * 100);
    if (difference === 1) penny++;
  }
  if (valid.length >= 6 && penny >= 3) add('penny-steps', 'Repeated one-cent increments', 12, 'Multiple successive bids increased by precisely one cent.', `${penny} one-cent increments`);
  const previous = context.previousByBidder || {};
  if (valid.length >= 6) {
    const recurring = leaders.find(([id, count]) => count >= 3 && previous[id]?.sellerAuctions >= 3 && previous[id]?.sellerParticipation >= .6);
    if (recurring) add('seller-follower', 'Recurring seller participation', 20, 'A frequent bidder also appears in a high share of other observed auctions from the same tagged seller.', `${recurring[0]}: ${previous[recurring[0]].sellerAuctions} seller auctions, ${Math.round(previous[recurring[0]].sellerParticipation * 100)}% observed coverage`);
  }
  const score = Math.min(100, rules.reduce((sum, r) => sum + r.points, 0));
  const level = score >= 65 ? 'CRITICAL' : score >= 45 ? 'HIGH' : score >= 25 ? 'MEDIUM' : score > 0 ? 'LOW' : 'NONE';
  return { score, level, rules, totalBids: valid.length, uniqueBidders: counts.size, maximum, caveat: 'Patterns are screening signals, not proof of shill bidding. Missing or incomplete bid histories can change every result.' };
}

export function cleanBids(bids) {
  if (!Array.isArray(bids) || bids.length < 2 || bids.length > 200) throw new Error('Provide between 2 and 200 bid records.');
  return bids.map((b, i) => {
    const bidder = String(b.bidder ?? b.bidder_id ?? '').trim();
    const amount = Number(b.amount);
    const time = b.time ?? b.bid_time ?? '';
    if (!bidder || bidder.length > 80 || !/^[^<>\u0000-\u001f]+$/.test(bidder)) throw new Error(`Invalid bidder in row ${i + 1}.`);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1e9) throw new Error(`Invalid amount in row ${i + 1}.`);
    if (String(time).length > 100) throw new Error(`Invalid timestamp in row ${i + 1}.`);
    return { bidder, amount: Math.round(amount * 100) / 100, time: String(time) };
  });
}
