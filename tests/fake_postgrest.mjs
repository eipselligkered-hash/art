// Minimal stand-in for Supabase's PostgREST (just what the CLI uses): GET with select/eq/order, POST insert, PATCH/DELETE ?id=eq.
import http from 'node:http';
export function startFake(db, key = 'test-service-key') {
  const log = [];
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x'); const m = u.pathname.match(/^\/rest\/v1\/(\w+)$/);
    log.push(`${req.method} ${u.pathname}${u.search}`);
    if (req.headers.apikey !== key || req.headers.authorization !== `Bearer ${key}`) { res.writeHead(401); return res.end('{"message":"bad key"}'); }
    if (!m || !db[m[1]]) { res.writeHead(404); return res.end(JSON.stringify({ code: 'PGRST205', message: `Could not find the table 'public.${m?.[1]}' in the schema cache` })); }
    const table = db[m[1]];
    const filt = [...u.searchParams].filter(([k]) => !['select', 'order'].includes(k));
    const pass = (row) => filt.every(([k, v]) => { const op = v.slice(0, v.indexOf('.')), val = v.slice(v.indexOf('.') + 1); return op === 'eq' && String(row[k]) === val; });
    let body = ''; for await (const ch of req) body += ch;
    if (req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(table.filter(pass))); }
    if (req.method === 'POST') {
      const rows = [].concat(JSON.parse(body)).map((r, i) => {
        if (!r.owner_id) throw new Error('owner_id required (not-null)');
        return { id: `srv-${m[1]}-${table.length + i + 1}`, created_at: new Date().toISOString(), ...r };
      });
      if (m[1] === 'art_ticks' && rows.some((r) => table.some((t) => t.item_id === r.item_id && t.done_on === r.done_on))) { res.writeHead(409); return res.end('{"message":"duplicate key value violates unique constraint"}'); }
      table.push(...rows); res.writeHead(201, { 'Content-Type': 'application/json' });
      return res.end(req.headers.prefer?.includes('return=representation') ? JSON.stringify(rows) : '');
    }
    if (req.method === 'PATCH') { const patch = JSON.parse(body); table.filter(pass).forEach((r) => Object.assign(r, patch)); res.writeHead(204); return res.end(); }
    if (req.method === 'DELETE') { db[m[1]] = table.filter((r) => !pass(r)); res.writeHead(204); return res.end(); }
    res.writeHead(405); res.end();
  });
  return new Promise((ok) => srv.listen(0, () => ok({ url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close(), log, get db() { return db; } })));
}
