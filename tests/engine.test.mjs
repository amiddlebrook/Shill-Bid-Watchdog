import test from 'node:test';
import assert from 'node:assert/strict';
import { assessBids, cleanBids } from '../src/engine.mjs';

test('empty or short observations do not accuse bidders', () => {
  assert.deepEqual(assessBids([]).rules, []);
  assert.equal(assessBids([{bidder:'a',amount:10},{bidder:'b',amount:11}]).level, 'NONE');
});
test('detects specific concentration and repeated alternating bids', () => {
  const bids = Array.from({length: 12}, (_,i) => ({bidder:i % 2?'b':'a', amount:10+i}));
  const result = assessBids(bids, {startPrice:2});
  assert(result.score >= 45);
  assert(result.rules.some(r => r.id === 'two-bidder'));
  assert(result.rules.some(r => r.id === 'repeat-duel'));
  assert(result.rules.some(r => r.id === 'price-multiple'));
});
test('seller evidence requires multiple observed auction records', () => {
  const bids = Array.from({length: 8}, (_,i) => ({bidder:i % 2 ? 'b' : 'a', amount:10+i}));
  assert(!assessBids(bids, { previousByBidder: {a:{sellerAuctions:1,sellerParticipation:1}} }).rules.some(r=>r.id==='seller-follower'));
  assert(assessBids(bids, { previousByBidder: {a:{sellerAuctions:4,sellerParticipation:.8}} }).rules.some(r=>r.id==='seller-follower'));
});
test('validates import rows and numeric amounts', () => {
  assert.throws(()=>cleanBids([{bidder:'a',amount:0},{bidder:'b',amount:10}]),/Invalid amount/);
  assert.throws(()=>cleanBids([{bidder:'<img>',amount:1},{bidder:'b',amount:2}]),/Invalid bidder/);
  assert.equal(cleanBids([{bidder:'a',amount:'1.256'},{bidder:'b',amount:2}])[0].amount, 1.26);
});
