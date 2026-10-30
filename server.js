'use strict';
// n100n — engine automasi lokal (n8n-like), zero dependency.
// Jalankan: node --env-file=.env server.js

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const store = require('./lib/store');
const { render, deepRender, evalExpr, makeScope } = require('./lib/template');
const engine = require('./lib/engine');
const { NODE_TYPES } = require('./lib/nodes');

engine.setStore(store);

const VERSION = '1.2.0';
const ROOT = __dirname;
const PORT = Number(process.env.APP_PORT || 5679);
const HOST = process.env.APP_HOST || '0.0.0.0';
const PASSWORD = process.env.APP_PASSWORD || 'changeme';
const SECRET = process.env.APP_SECRET || 'n100n-secret';
const API_TOKEN = process.env.APP_API_TOKEN || '';
const CORS_ORIGIN = process.env.APP_CORS_ORIGIN || '';
const PUBLIC_DIR = path.join(ROOT, 'public');
const SEED = process.env.APP_SEED !== '0';

// ---------- util ----------
const nowIso = () => new Date().toISOString();

function send(res, status, body, headers = {}) {
  const h = Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers);
  if (CORS_ORIGIN) {
    h['Access-Control-Allow-Origin'] = CORS_ORIGIN;
    h['Access-Control-Allow-Headers'] = 'content-type,x-api-key,x-webhook-token';
    h['Access-Control-Allow-Methods'] = 'GET,POST,PUT,DELETE,OPTIONS';
  }
  res.writeHead(status, h);
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function readBody(req, limitBytes = 5 * 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limitBytes) throw new Error('payload terlalu besar (maks ' + limitBytes + ' byte)');
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { _raw: text }; }
}

// ---------- auth ----------
const sessionToken = () => crypto.createHmac('sha256', SECRET).update(PASSWORD).digest('hex');
const parseCookies = (h = '') => Object.fromEntries(
  h.split(';').map((p) => p.trim().split('=')).filter((p) => p.length === 2).map(([k, v]) => [k, decodeURIComponent(v)])
);
function authed(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  if (cookies.sid && crypto.timingSafeEqual(Buffer.from(cookies.sid), Buffer.from(sessionToken()))) return true;
  if (API_TOKEN && req.headers['x-api-key'] === API_TOKEN) return true;
  return false;
}

// proteksi brute force login sederhana
const loginAttempts = new Map();
function loginBlocked(ip) {
  const rec = loginAttempts.get(ip);
  if (!rec) return 0;
  if (rec.until > Date.now()) return Math.ceil((rec.until - Date.now()) / 1000);
  return 0;
}
function noteLoginFail(ip) {
  const rec = loginAttempts.get(ip) || { count: 0, until: 0 };
  rec.count += 1;
  if (rec.count >= 5) { rec.until = Date.now() + 60000; rec.count = 0; }
  loginAttempts.set(ip, rec);
}

function checkPassword(given) {
  const a = Buffer.from(String(given));
  const b = Buffer.from(PASSWORD);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ---------- webhook ----------
async function handleWebhook(req, res, url) {
  const rest = url.pathname.slice('/webhook/'.length);
  const p = decodeURIComponent(rest);
  const wf = store.listWorkflows().find((w) => w.active && w.trigger === 'webhook' && String(w.trigger_cfg.path || '') === p);
  if (!wf) return send(res, 404, { ok: false, error: 'webhook tidak ditemukan: ' + p });

  if (wf.trigger_cfg.token) {
    const given = req.headers['x-webhook-token'] || url.searchParams.get('token') || '';
    if (given !== wf.trigger_cfg.token) return send(res, 401, { ok: false, error: 'token webhook salah' });
  }

  const method = String(wf.trigger_cfg.method || 'any').toUpperCase();
  if (method !== 'ANY' && method !== req.method) return send(res, 405, { ok: false, error: 'method tidak diizinkan' });

  const body = await readBody(req).catch(() => ({}));
  const items = [{
    body,
    query: Object.fromEntries(url.searchParams),
    headers: req.headers,
    method: req.method,
    path: p,
  }];

  // Jalankan di latar belakang, tapi tetap kembalikan execution_id supaya bisa dipantau
  // (KRA memakainya untuk poll /api/executions/:id).
  const jalanLatar = async () => {
    let execId = 0;
    let selesaiId;
    const dapatId = new Promise((r) => { selesaiId = r; });
    engine
      .runWorkflow(wf, items, 'webhook', 0, { onStart: (id) => { execId = id; selesaiId(id); } })
      .catch((e) => console.error('webhook run:', e.message));
    await Promise.race([dapatId, new Promise((r) => setTimeout(r, 2000))]);
    return execId;
  };

  const wantWait = url.searchParams.get('wait') === '1' || wf.trigger_cfg.wait;
  if (url.searchParams.get('async') === '1' && !wantWait) {
    const execId = await jalanLatar();
    return send(res, 202, {
      ok: true, accepted: true, execution_id: execId || undefined,
      poll: execId ? '/api/executions/' + execId + '?wait=1' : undefined,
    });
  }
  if (wantWait) {
    const result = await engine.runWorkflow(wf, items, 'webhook');
    if (result.status !== 'success') {
      return send(res, 500, { ok: false, execution_id: result.execution_id, error: result.error });
    }
    if (result.response) return send(res, result.response.status || 200, result.response.body);
    return send(res, 200, { ok: true, execution_id: result.execution_id, output: result.items });
  }
  const execId = await jalanLatar();
  return send(res, 202, {
    ok: true, accepted: true, execution_id: execId || undefined,
    poll: execId ? '/api/executions/' + execId + '?wait=1' : undefined,
  });
}

// ---------- REST API ----------
async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // api, resource, id, action
  const resource = parts[1] || '';
  const seg2 = parts[2] || '';
  const id = /^\d+$/.test(seg2) ? Number(seg2) : null;
  // /api/workflows/import      -> action "import"
  // /api/workflows/5/run       -> id 5, action "run"
  const action = parts[3] || (id === null ? seg2 : '');

  if (resource === 'version') return send(res, 200, { version: VERSION, node: process.version });

  if (resource === 'nodes') {
    return send(res, 200, Object.entries(NODE_TYPES).map(([type, def]) => ({ type, label: def.label, group: def.group })));
  }

  if (resource === 'workflows') {
    if (!id && req.method === 'GET') return send(res, 200, store.listWorkflows());

    // catatan: `action` dicek lebih dulu supaya /api/workflows/import tidak dianggap create biasa
    if (!id && !action && req.method === 'POST') {
      const body = await readBody(req);
      return send(res, 201, store.createWorkflow(body));
    }

    if (!id && action === 'import' && req.method === 'POST') {
      const body = await readBody(req);
      const list = Array.isArray(body) ? body : Array.isArray(body.workflows) ? body.workflows : [body.workflow || body];
      const created = list.map((raw) => store.createWorkflow({
        name: raw.name || 'Import',
        active: raw.active,
        trigger: raw.trigger,
        trigger_cfg: raw.trigger_cfg,
        nodes: raw.nodes,
        settings: raw.settings,
        error_workflow_id: raw.error_workflow_id,
      }));
      return send(res, 201, { ok: true, created: created.map((w) => ({ id: w.id, name: w.name })) });
    }

    if (id && req.method === 'GET') {
      const wf = store.getWorkflow(id);
      if (!wf) return send(res, 404, { error: 'workflow tidak ada' });
      if (action === 'export') {
        const { id: _id, last_run, created, updated, ...rest } = wf;
        return send(res, 200, rest, { 'Content-Disposition': `attachment; filename="workflow-${id}.json"` });
      }
      return send(res, 200, wf);
    }

    if (id && req.method === 'PUT') {
      const body = await readBody(req);
      const wf = store.updateWorkflow(id, body);
      return wf ? send(res, 200, wf) : send(res, 404, { error: 'workflow tidak ada' });
    }

    if (id && req.method === 'DELETE') {
      if (!store.getWorkflow(id)) return send(res, 404, { error: 'workflow tidak ada' });
      store.deleteWorkflow(id);
      return send(res, 200, { ok: true });
    }

    if (id && action === 'validate' && req.method === 'POST') {
      const wf = store.getWorkflow(id);
      if (!wf) return send(res, 404, { error: 'workflow tidak ada' });
      const body = await readBody(req);
      const check = engine.validateWorkflow({ nodes: body.nodes || wf.nodes });
      return send(res, check.ok ? 200 : 422, check);
    }

    if (id && action === 'toggle' && req.method === 'POST') {
      const wf = store.getWorkflow(id);
      if (!wf) return send(res, 404, { error: 'workflow tidak ada' });
      const body = await readBody(req);
      const active = body.active !== undefined ? Boolean(body.active) : !wf.active;
      return send(res, 200, store.updateWorkflow(id, { active }));
    }

    if (id && action === 'run' && req.method === 'POST') {
      const wf = store.getWorkflow(id);
      if (!wf) return send(res, 404, { error: 'workflow tidak ada' });
      const body = await readBody(req);
      const items = body.items !== undefined ? body.items : body.input !== undefined ? body.input : [{}];
      const isAsync = url.searchParams.get('async') === '1' || body.async === true;

      if (isAsync) {
        let resolveId;
        const gotId = new Promise((r) => { resolveId = r; });
        const promise = engine.runWorkflow(wf, items, 'api', 0, { onStart: resolveId });
        const execution_id = await gotId;
        promise.then((r) => {
          if (r.status === 'error') console.error('async run #' + execution_id + ':', r.error);
        }).catch((e) => console.error('async run:', e.message));
        return send(res, 202, { ok: true, accepted: true, execution_id, poll: `/api/executions/${execution_id}` });
      }

      const result = await engine.runWorkflow(wf, items, 'api');
      return send(res, result.status === 'success' ? 200 : 500, result);
    }
  }

  if (resource === 'executions') {
    if (!id && req.method === 'GET') {
      const wfId = url.searchParams.get('workflow_id');
      return send(res, 200, store.listExecutions({
        workflowId: wfId ? Number(wfId) : null,
        status: url.searchParams.get('status'),
        limit: url.searchParams.get('limit'),
      }));
    }
    if (id && req.method === 'GET') {
      const row = store.getExecution(id);
      if (!row) return send(res, 404, { error: 'eksekusi tidak ada' });
      // dukung long-poll ringan: ?wait=selesai
      if (url.searchParams.get('wait') === '1' && row.status === 'running') {
        const deadline = Date.now() + Math.min(Number(url.searchParams.get('timeoutMs') || 30000), 120000);
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 500));
          const cur = store.getExecution(id);
          if (cur.status !== 'running') return send(res, 200, cur);
        }
        return send(res, 200, store.getExecution(id));
      }
      return send(res, 200, row);
    }
    if (!id && req.method === 'DELETE') {
      return send(res, 200, { ok: true, dihapus: store.pruneExecutions(Number(url.searchParams.get('keep') || 500)) });
    }
  }

  if (resource === 'stats' && req.method === 'GET') {
    return send(res, 200, Object.assign({ ok: true }, store.stats({
      days: url.searchParams.get('days'),
    })));
  }

  if (resource === 'health') {
    return send(res, 200, {
      ok: true,
      version: VERSION,
      node: process.version,
      uptime_s: Math.round(process.uptime()),
      workflows: store.db.prepare('SELECT COUNT(*) c FROM workflows').get().c,
      active: store.db.prepare('SELECT COUNT(*) c FROM workflows WHERE active=1').get().c,
      running: store.db.prepare("SELECT COUNT(*) c FROM executions WHERE status='running'").get().c,
    });
  }

  return send(res, 404, { error: 'endpoint tidak ada' });
}

// ---------- static ----------
function serveStatic(res, file) {
  const p = path.join(PUBLIC_DIR, file);
  if (!p.startsWith(PUBLIC_DIR) || !fs.existsSync(p)) return send(res, 404, { error: 'not found' });
  const ext = path.extname(p).toLowerCase();
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.json': 'application/json; charset=utf-8',
  };
  res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  res.end(fs.readFileSync(p));
}

// ---------- http server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'OPTIONS' && CORS_ORIGIN) return send(res, 204, '');
    if (url.pathname.startsWith('/webhook/')) return await handleWebhook(req, res, url);

    if (url.pathname === '/api/login' && req.method === 'POST') {
      const ip = req.socket.remoteAddress || 'unknown';
      const blocked = loginBlocked(ip);
      if (blocked) return send(res, 429, { error: `terlalu banyak percobaan, coba lagi ${blocked} detik` });
      const body = await readBody(req);
      if (!checkPassword(body.password)) {
        noteLoginFail(ip);
        return send(res, 401, { error: 'password salah' });
      }
      loginAttempts.delete(ip);
      return send(res, 200, { ok: true }, {
        'Set-Cookie': `sid=${sessionToken()}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000`,
      });
    }

    if (url.pathname === '/api/logout') {
      return send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; Path=/; Max-Age=0' });
    }

    if (url.pathname === '/api/health') {
      return send(res, 200, {
        ok: true, version: VERSION, node: process.version,
        uptime_s: Math.round(process.uptime()),
        workflows: store.db.prepare('SELECT COUNT(*) c FROM workflows').get().c,
      });
    }

    if (url.pathname.startsWith('/api/')) {
      if (!authed(req)) return send(res, 401, { error: 'unauthorized' });
      if (url.pathname === '/api/session') return send(res, 200, { ok: true });
      return await handleApi(req, res, url);
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (url.pathname === '/') return serveStatic(res, 'index.html');
      if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
      return serveStatic(res, url.pathname.replace(/^\/+/, ''));
    }
    return send(res, 405, { error: 'method tidak diizinkan' });
  } catch (e) {
    console.error('http:', e.message);
    return send(res, 500, { error: e.message });
  }
});

// ---------- scheduler ----------
function tzParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone, hour12: false, weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const days = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute),
    weekday: days[parts.weekday] !== undefined ? days[parts.weekday] : date.getUTCDay(),
  };
}

// Apakah workflow schedule harus jalan sekarang?
function scheduleDue(wf, now = new Date()) {
  const cfg = wf.trigger_cfg || {};
  const last = wf.last_run ? Date.parse(wf.last_run) : 0;
  const nowMs = now.getTime();
  const mode = String(cfg.mode || (cfg.at ? 'daily' : 'interval')).toLowerCase();

  if (mode === 'interval') {
    const every = Math.max(1, Number(cfg.every_minutes || 5)) * 60000;
    return nowMs - last >= every;
  }

  const tz = cfg.timezone || 'Asia/Jakarta';
  const at = String(cfg.at || '07:00');
  const m = at.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return false;
  const p = tzParts(now, tz);
  if (p.hour !== Number(m[1]) || p.minute !== Number(m[2])) return false;
  if (mode === 'weekly') {
    const days = Array.isArray(cfg.days) && cfg.days.length ? cfg.days.map(Number) : [1];
    if (!days.includes(p.weekday)) return false;
  } else if (Array.isArray(cfg.days) && cfg.days.length) {
    if (!cfg.days.map(Number).includes(p.weekday)) return false;
  }
  // jangan dobel dalam satu menit yang sama
  return nowMs - last > 60000;
}

const schedulerTick = () => {
  try {
    const rows = store.listWorkflows().filter((w) => w.active && w.trigger === 'schedule');
    for (const wf of rows) {
      if (!scheduleDue(wf)) continue;
      store.markRun(wf.id, nowIso());
      engine.runWorkflow(wf, [{ schedule: nowIso() }], 'schedule').catch((e) => console.error('schedule:', e.message));
    }
  } catch (e) {
    console.error('scheduler:', e.message);
  }
};

let scheduler = null;
function startScheduler(intervalMs = 20000) {
  if (scheduler) return scheduler;
  scheduler = setInterval(schedulerTick, intervalMs);
  scheduler.unref();
  return scheduler;
}

// ---------- seed workflow contoh ----------
// Semua file workflows/*.json dimuat saat database masih kosong.
function seedIfEmpty() {
  if (!SEED) return [];
  if (store.db.prepare('SELECT COUNT(*) c FROM workflows').get().c > 0) return [];
  const dir = path.join(ROOT, 'workflows');
  if (!fs.existsSync(dir)) return [];
  const dimuat = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    try {
      const wf = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      const created = store.createWorkflow(wf);
      dimuat.push(created);
      console.log(`seed: "${created.name}" (#${created.id}) dari workflows/${file}`);
    } catch (e) {
      console.error('seed gagal (' + file + '):', e.message);
    }
  }
  return dimuat;
}

function bootstrap() {
  if (PASSWORD === 'changeme' || PASSWORD.length < 8) {
    console.warn('PERINGATAN: APP_PASSWORD masih default/pendek. Ganti di .env sebelum dipakai di jaringan.');
  }
  if (!API_TOKEN) console.warn('PERINGATAN: APP_API_TOKEN kosong -> integrasi lewat API key tidak aktif.');
  seedIfEmpty();
  store.pruneExecutions(500);
}

if (require.main === module) {
  bootstrap();
  server.listen(PORT, HOST, () => {
    console.log(`n100n v${VERSION} jalan di http://${HOST}:${PORT} (data: ${store.DATA_DIR})`);
    startScheduler();
  });
  const shutdown = (sig) => {
    console.log('\n' + sig + ' diterima, mematikan...');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

module.exports = {
  server, store, engine, bootstrap, startScheduler, scheduleDue, tzParts,
  render, deepRender, evalExpr, makeScope,
  runNode: require('./lib/nodes').runNode,
  executeWorkflow: engine.executeWorkflow,
  runWorkflow: engine.runWorkflow,
  validateWorkflow: engine.validateWorkflow,
  getWorkflow: (id) => store.getWorkflow(id),
  hydrate: store.hydrate,
  db: store.db,
  VERSION,
};
