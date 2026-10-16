import { assessBids, cleanBids } from './engine.mjs';

const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const fail = (message, status = 400) => json({ success: false, error: message }, status);
const ok = data => json({ success: true, data });
const idNumber = value => /^\d+$/.test(value || '') && Number(value) > 0 ? Number(value) : null;
const shortText = (value, size) => String(value || '').trim().slice(0, size);
const verifiedUrl = value => {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.href.length > 1200 || !url.hostname.includes('.')) return null;
    url.hash = '';
    return url;
  } catch { return null; }
};
async function payload(request) {
  const bytes = Number(request.headers.get('content-length') || 0);
  if (bytes > 80000) throw new Error('Request exceeds 80 KB.');
  const body = await request.text();
  if (body.length > 80000) throw new Error('Request exceeds 80 KB.');
  try { return JSON.parse(body); } catch { throw new Error('Expected JSON payload.'); }
}
function authenticated(request, env) {
  if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 16) return false;
  const authorization = request.headers.get('authorization') || '';
  const candidate = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (candidate.length !== env.ADMIN_TOKEN.length) return false;
  let diff = 0;
  for (let i = 0; i < candidate.length; i++) diff |= candidate.charCodeAt(i) ^ env.ADMIN_TOKEN.charCodeAt(i);
  return diff === 0;
}
async function requireAuction(db, id) {
  return db.prepare("SELECT a.*, m.seller_tag, m.notes FROM auctions a LEFT JOIN auction_notes m ON a.id=m.auction_id WHERE a.id=? AND a.status != 'deleted'").bind(id).first();
}
async function history(db, auction, rows) {
  if (!auction.seller_tag) return {};
  const peer = await db.prepare(`SELECT a.id, b.bidder_id FROM auctions a
    JOIN auction_notes m ON m.auction_id=a.id JOIN bids b ON b.auction_id=a.id
    WHERE m.seller_tag=? AND a.id != ? AND a.status != 'deleted'
    GROUP BY a.id,b.bidder_id LIMIT 2500`).bind(auction.seller_tag, auction.id).all();
  const grouped = new Map();
  for (const bid of peer.results || []) {
    if (!grouped.has(bid.bidder_id)) grouped.set(bid.bidder_id, new Set());
    grouped.get(bid.bidder_id).add(bid.id);
  }
  const observed = new Set((peer.results || []).map(b => b.id)).size;
  return Object.fromEntries(rows.map(b => [b.bidder, { sellerAuctions: grouped.get(b.bidder)?.size || 0, sellerParticipation: observed ? (grouped.get(b.bidder)?.size || 0) / observed : 0 }]));
}
async function applyAnalysis(env, auction, bids) {
  const score = assessBids(bids, { startPrice: auction.start_price, previousByBidder: await history(env.DB, auction, bids) });
  const operations = [
    env.DB.prepare('DELETE FROM alerts WHERE auction_id=?').bind(auction.id),
    env.DB.prepare("UPDATE auctions SET risk_level=?,risk_score=?,current_price=?,last_checked=datetime('now'),updated_at=datetime('now'),status='analyzed' WHERE id=?").bind(score.level, score.score, score.maximum, auction.id)
  ];
  if (score.rules.length) operations.push(env.DB.prepare('INSERT INTO alerts (auction_id,risk_level,summary,violations,evidence,ml_confidence,acknowledged) VALUES (?,?,?,?,?,NULL,0)').bind(auction.id, score.level, `${score.rules.length} observed pattern${score.rules.length > 1 ? 's' : ''}`, JSON.stringify(score.rules), JSON.stringify(score.rules.map(r => r.evidence))));
  await env.DB.batch(operations);
  return score;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS?.fetch(request) || new Response('Not found', { status: 404 });
    if (request.method === 'OPTIONS') return new Response(null, { status: 405 });
    if (url.pathname === '/api/health' && request.method === 'GET') return ok({ status: 'healthy', version: 2, storage: Boolean(env.DB), authConfigured: Boolean(env.ADMIN_TOKEN && env.ADMIN_TOKEN.length >= 16) });
    if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 16) return fail('Admin token is not configured. Set ADMIN_TOKEN as a Cloudflare Worker secret.', 503);
    if (!authenticated(request, env)) return fail('Unauthorized. Enter your administrator token.', 401);
    if (!env.DB) return fail('D1 binding is missing.', 503);
    try {
      if (url.pathname === '/api/auctions' && request.method === 'GET') {
        const result = await env.DB.prepare(`SELECT a.id,a.auction_id,a.source,a.url,a.item_name,a.current_price,a.start_price,a.status,a.risk_level,a.risk_score,a.last_checked,a.created_at,m.seller_tag,
          (SELECT COUNT(*) FROM bids WHERE auction_id=a.id) bid_count FROM auctions a LEFT JOIN auction_notes m ON m.auction_id=a.id
          WHERE a.status != 'deleted' ORDER BY a.updated_at DESC LIMIT 100`).all();
        return ok(result.results || []);
      }
      if (url.pathname === '/api/auctions' && request.method === 'POST') {
        const body = await payload(request);
        const address = verifiedUrl(body.url);
        if (!address) return fail('Enter a valid public HTTPS auction URL.');
        const auctionId = `${address.hostname}:${address.pathname}${address.search}`.slice(0, 500);
        const name = shortText(body.name || address.pathname.split('/').filter(Boolean).at(-1) || 'New auction', 180);
        const opening = body.startPrice === '' || body.startPrice == null ? null : Number(body.startPrice);
        if (opening !== null && (!Number.isFinite(opening) || opening < 0 || opening > 1e9)) return fail('Opening price must be a nonnegative number.');
        const row = await env.DB.prepare(`INSERT INTO auctions(auction_id,source,url,item_name,start_price,status,updated_at)
          VALUES(?,?,?,?,?,'watching',datetime('now')) ON CONFLICT(auction_id) DO UPDATE SET
          item_name=excluded.item_name,start_price=excluded.start_price,url=excluded.url,updated_at=datetime('now') RETURNING id`).bind(auctionId, address.hostname, address.href, name, opening).first();
        await env.DB.prepare(`INSERT INTO auction_notes(auction_id,seller_tag,notes) VALUES(?,?,?) ON CONFLICT(auction_id) DO UPDATE SET seller_tag=excluded.seller_tag,notes=excluded.notes`).bind(row.id, shortText(body.sellerTag, 100) || null, shortText(body.notes, 1000)).run();
        return ok({ id: row.id, name, notice: 'Saved. Import visible bid history to calculate risk; URL-only registration does not extract bids.' });
      }
      if (url.pathname === '/api/stats' && request.method === 'GET') {
        const [auctions, bids, alerts] = await Promise.all([
          env.DB.prepare("SELECT COUNT(*) total,COALESCE(SUM(CASE WHEN status='analyzed' THEN 1 ELSE 0 END),0) analyzed,COALESCE(SUM(CASE WHEN risk_level IN ('HIGH','CRITICAL') THEN 1 ELSE 0 END),0) flagged FROM auctions WHERE status != 'deleted'").first(),
          env.DB.prepare('SELECT COUNT(*) total FROM bids').first(),
          env.DB.prepare('SELECT COUNT(*) total FROM alerts WHERE acknowledged=0').first()
        ]);
        return ok({ auctions: auctions?.total || 0, analyzed: auctions?.analyzed || 0, flagged: auctions?.flagged || 0, bids: bids?.total || 0, alerts: alerts?.total || 0 });
      }
      if (url.pathname === '/api/alerts' && request.method === 'GET') {
        const res = await env.DB.prepare(`SELECT al.id,al.auction_id,al.risk_level,al.summary,al.violations,al.evidence,al.acknowledged,al.created_at,a.item_name FROM alerts al JOIN auctions a ON al.auction_id=a.id WHERE a.status!='deleted' ORDER BY al.created_at DESC LIMIT 100`).all();
        return ok((res.results || []).map(r => ({ ...r, violations: JSON.parse(r.violations || '[]'), evidence: JSON.parse(r.evidence || '[]') })));
      }
      const match = url.pathname.match(/^\/api\/auctions\/(\d+)(?:\/(bids|analyze))?$/);
      if (match) {
        const id = idNumber(match[1]);
        const action = match[2];
        const auction = await requireAuction(env.DB, id);
        if (!auction) return fail('Auction not found.', 404);
        if (!action && request.method === 'GET') {
          const [bids, alerts] = await Promise.all([
            env.DB.prepare('SELECT bidder_id bidder,amount,bid_time time,bid_order FROM bids WHERE auction_id=? ORDER BY bid_order ASC,id ASC LIMIT 500').bind(id).all(),
            env.DB.prepare('SELECT * FROM alerts WHERE auction_id=? ORDER BY created_at DESC LIMIT 10').bind(id).all()
          ]);
          return ok({ auction, bids: bids.results || [], alerts: (alerts.results || []).map(r => ({ ...r, violations: JSON.parse(r.violations || '[]') })) });
        }
        if (action === 'bids' && request.method === 'POST') {
          const body = await payload(request);
          const bids = cleanBids(body.bids);
          const operations = [env.DB.prepare('DELETE FROM bids WHERE auction_id=?').bind(id)];
          for (let i=0; i<bids.length; i++) operations.push(env.DB.prepare('INSERT INTO bids(auction_id,bidder_id,amount,bid_time,bid_order) VALUES(?,?,?,?,?)').bind(id,bids[i].bidder,bids[i].amount,bids[i].time||null,i+1));
          await env.DB.batch(operations);
          const score = await applyAnalysis(env, auction, bids);
          return ok(score);
        }
        if (action === 'analyze' && request.method === 'POST') {
          const res = await env.DB.prepare('SELECT bidder_id bidder,amount,bid_time time FROM bids WHERE auction_id=? ORDER BY bid_order ASC,id ASC').bind(id).all();
          if (!(res.results || []).length) return fail('Import bid history before analyzing.');
          return ok(await applyAnalysis(env, auction, res.results));
        }
        if (!action && request.method === 'DELETE') {
          await env.DB.batch([
            env.DB.prepare('DELETE FROM alerts WHERE auction_id=?').bind(id),
            env.DB.prepare('DELETE FROM bids WHERE auction_id=?').bind(id),
            env.DB.prepare('DELETE FROM auction_notes WHERE auction_id=?').bind(id),
            env.DB.prepare("UPDATE auctions SET status='deleted',updated_at=datetime('now') WHERE id=?").bind(id)
          ]);
          return ok({ deleted: true });
        }
      }
      const acknowledgement = url.pathname.match(/^\/api\/alerts\/(\d+)\/acknowledge$/);
      if (acknowledgement && request.method === 'POST') {
        await env.DB.prepare('UPDATE alerts SET acknowledged=1 WHERE id=?').bind(Number(acknowledgement[1])).run();
        return ok({ acknowledged: true });
      }
      return fail('Endpoint not found.', 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unexpected error';
      if (message.includes('no such table')) return fail('D1 schema is missing. Apply migrations before using the app.', 503);
      if (/Invalid|Expected|Provide|Request exceeds/.test(message)) return fail(message);
      console.error('API request failed', message);
      return fail('Operation failed. Check Worker logs and database configuration.', 500);
    }
  }
};
