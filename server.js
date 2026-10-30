'use strict';
// n100n — n8n-like local automation engine (zero dependency)
// Jalankan: node --env-file=.env server.js
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const PORT = Number(process.env.APP_PORT || 5679);
const HOST = process.env.APP_HOST || '0.0.0.0';
const PASSWORD = process.env.APP_PASSWORD || 'changeme';
const SECRET = process.env.APP_SECRET || 'n100n-secret';
const API_TOKEN = process.env.APP_API_TOKEN || '';
const MAX_PARALLEL = Math.max(1, Number(process.env.APP_MAX_PARALLEL || 2));
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = process.env.APP_DATA_DIR ? path.resolve(process.env.APP_DATA_DIR) : path.join(ROOT, 'data');

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'n100n.db'));
db.exec(`
CREATE TABLE IF NOT EXISTS workflows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0,
  trigger TEXT NOT NULL DEFAULT 'manual',
  trigger_cfg TEXT NOT NULL DEFAULT '{}',
  nodes TEXT NOT NULL DEFAULT '[]',
  error_workflow_id INTEGER,
  last_run TEXT,
  created TEXT NOT NULL,
  updated TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS executions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  trigger TEXT,
  started TEXT NOT NULL,
  finished TEXT,
  input TEXT,
  output TEXT,
  error TEXT,
  log TEXT
);
CREATE INDEX IF NOT EXISTS idx_exec_wf ON executions(workflow_id, id DESC);
`);

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, Number(ms) || 0)));
const clip = (s, n = 200000) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + '... [truncated]' : s);
const nowIso = () => new Date().toISOString();

// ---------- template engine ----------
function evalExpr(expr, scope) {
  try {
    return vm.runInNewContext(expr, scope, { timeout: 2000 });
  } catch {
    return undefined;
  }
}

function render(tpl, scope) {
  if (typeof tpl !== 'string') return tpl;
  const whole = tpl.match(/^\s*\{\{([\s\S]+)\}\}\s*$/);
  if (whole) {
    const v = evalExpr(whole[1], scope);
    return v === undefined ? '' : v;
  }
  return tpl.replace(/\{\{([\s\S]+?)\}\}/g, (_, e) => {
    const v = evalExpr(e, scope);
    if (v === undefined || v === null) return '';
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

function deepRender(value, scope) {
  if (typeof value === 'string') return render(value, scope);
  if (Array.isArray(value)) return value.map((v) => deepRender(v, scope));
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = deepRender(value[k], scope);
    return out;
  }
  return value;
}

function scopeFor(ctx, item) {
  return {
    $json: item === undefined ? null : item,
    $items: ctx.items,
    $env: Object.assign({}, process.env),
    $now: nowIso(),
    $workflow: { id: ctx.wf.id, name: ctx.wf.name },
    $execution: { id: ctx.execId },
  };
}

// ---------- node handlers ----------
async function runNode(ctx, node) {
  const items = ctx.items;
  const cfg = node.config || {};
  const first = items[0] === undefined ? {} : items[0];
  const scope = scopeFor(ctx, first);

  switch (node.type) {
    case 'manual':
    case 'webhook':
    case 'schedule':
    case 'trigger':
      return items;

    case 'set': {
      const out = [];
      for (const item of items) {
        const s = scopeFor(ctx, item);
        const merged = Object.assign({}, item);
        for (const [k, v] of Object.entries(cfg.fields || {})) merged[k] = deepRender(v, s);
        out.push(merged);
      }
      return out;
    }

    case 'if': {
      const keep = [];
      for (const item of items) {
        const s = scopeFor(ctx, item);
        const ok = Boolean(evalExpr(String(cfg.condition || 'true'), s));
        if (ok !== Boolean(cfg.invert)) keep.push(item);
      }
      return keep;
    }

    case 'code': {
      const sandbox = {
        JSON, Math, Date, Number, String, Boolean, Array, Object, RegExp, Promise,
        console: { log: (...a) => ctx.log.push(a.map(String).join(' ')) },
      };
      const fn = new vm.Script(`(async function(items, $env, $now, $workflow){${cfg.code || 'return items;'}\n})`)
        .runInNewContext(sandbox, { timeout: 5000 });
      const result = await fn(items, Object.assign({}, process.env), nowIso(), { id: ctx.wf.id, name: ctx.wf.name });
      if (!Array.isArray(result)) throw new Error('node code harus me-return array');
      // normalisasi ke realm host (objek dari vm punya prototype beda)
      return JSON.parse(JSON.stringify(result));
    }

    case 'http': {
      const call = async (item) => {
        const s = scopeFor(ctx, item);
        const url = render(String(cfg.url || ''), s);
        if (!url) throw new Error('config.url kosong');
        const headers = deepRender(cfg.headers || {}, s);
        let body;
        if (cfg.body !== undefined && cfg.body !== '') {
          const b = deepRender(cfg.body, s);
          body = typeof b === 'string' ? b : JSON.stringify(b);
          if (!headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/json';
        }
        const res = await fetch(url, {
          method: String(cfg.method || 'GET').toUpperCase(),
          headers,
          body,
          signal: AbortSignal.timeout(Number(cfg.timeoutMs || 30000)),
        });
        const text = await res.text();
        let data;
        try { data = JSON.parse(text); } catch { data = text; }
        if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + String(text).slice(0, 300));
        return data;
      };
      if (cfg.each) {
        const out = [];
        for (const item of items) {
          const d = await call(item);
          if (Array.isArray(d)) out.push(...d); else out.push(d);
          if (cfg.delayMs) await sleep(cfg.delayMs);
        }
        return out;
      }
      const d = await call(first);
      return Array.isArray(d) ? d : [d];
    }

    case 'telegram': {
      const token = render(String(cfg.token || '{{ $env.TELEGRAM_TOKEN }}'), scope);
      if (!token) throw new Error('token telegram kosong');
      const out = [];
      for (const item of items) {
        const s = scopeFor(ctx, item);
        const chat = render(String(cfg.chat_id || '{{ $env.TELEGRAM_CHAT_ID }}'), s);
        const text = render(String(cfg.text || ''), s);
        if (!chat) throw new Error('chat_id kosong');
        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chat, text, parse_mode: cfg.parse_mode || undefined }),
          signal: AbortSignal.timeout(Number(cfg.timeoutMs || 15000)),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.ok === false) throw new Error('telegram gagal: ' + (data.description || res.status));
        out.push({ ok: true, message_id: data.result && data.result.message_id });
        if (cfg.delayMs) await sleep(cfg.delayMs);
      }
      return out;
    }

    case 'file': {
      const action = String(cfg.action || 'read');
      const out = [];
      for (const item of items) {
        const s = scopeFor(ctx, item);
        const p = render(String(cfg.path || ''), s);
        if (!p) throw new Error('config.path kosong');
        if (action === 'read') {
          out.push({ path: p, content: fs.readFileSync(p, 'utf8') });
        } else {
          const content = String(render(String(cfg.content ?? ''), s));
          fs.mkdirSync(path.dirname(p), { recursive: true });
          if (action === 'append') fs.appendFileSync(p, content); else fs.writeFileSync(p, content);
          out.push({ path: p, ok: true });
        }
        if (cfg.delayMs) await sleep(cfg.delayMs);
      }
      return out;
    }

    case 'delay':
      await sleep(cfg.ms || 1000);
      return items;

    case 'respond':
      ctx.response = {
        status: Number(cfg.status || 200),
        body: deepRender(cfg.body === undefined ? { ok: true } : cfg.body, scope),
      };
      return items;

    case 'workflow': {
      const sub = getWorkflow(Number(cfg.workflow_id));
      if (!sub) throw new Error('sub-workflow tidak ditemukan: ' + cfg.workflow_id);
      const res = await executeWorkflow(sub, items, 'sub', (ctx.depth || 0) + 1);
      if (res.status !== 'success') throw new Error('sub-workflow gagal: ' + (res.error || ''));
      ctx.log.push('sub-workflow #' + sub.id + ' -> ' + res.items.length + ' item');
      return res.items;
    }

    case 'stop':
      return [];

    default:
      throw new Error('tipe node tidak dikenal: ' + node.type);
  }
}

// ---------- engine ----------
let running = 0;
const waiting = [];
async function limit(fn) {
  while (running >= MAX_PARALLEL) await new Promise((r) => waiting.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    const next = waiting.shift();
    if (next) next();
  }
}

function hydrate(row) {
  if (!row) return null;
  let nodes = [];
  let triggerCfg = {};
  try { nodes = JSON.parse(row.nodes || '[]'); } catch {}
  try { triggerCfg = JSON.parse(row.trigger_cfg || '{}'); } catch {}
  return Object.assign({}, row, { nodes, trigger_cfg: triggerCfg });
}

function getWorkflow(id) {
  return hydrate(db.prepare('SELECT * FROM workflows WHERE id=?').get(id));
}

async function executeWorkflow(wf, items, trigger, depth = 0) {
  if (depth > 5) throw new Error('sub-workflow terlalu dalam (rekursi?)');
  const input = Array.isArray(items) ? items : [items];
  const exec = db.prepare('INSERT INTO executions(workflow_id,status,trigger,started,input) VALUES(?,?,?,?,?)')
    .run(wf.id, 'running', trigger || 'manual', nowIso(), clip(JSON.stringify(input)));
  const execId = Number(exec.lastInsertRowid);
  const ctx = { wf, items: input, execId, log: [], response: null, depth };

  try {
    for (const node of wf.nodes) {
      const t0 = Date.now();
      ctx.items = await runNode(ctx, node);
      ctx.log.push(`${node.name || node.type}: ok, ${ctx.items.length} item, ${Date.now() - t0}ms`);
    }
    db.prepare('UPDATE executions SET status=?,finished=?,output=?,log=? WHERE id=?')
      .run('success', nowIso(), clip(JSON.stringify(ctx.items)), clip(ctx.log.join('\n')), execId);
    return { status: 'success', execution_id: execId, items: ctx.items, response: ctx.response, log: ctx.log };
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    ctx.log.push('ERROR: ' + msg);
    db.prepare('UPDATE executions SET status=?,finished=?,error=?,log=? WHERE id=?')
      .run('error', nowIso(), msg, clip(ctx.log.join('\n')), execId);
    if (wf.error_workflow_id && depth === 0) {
      try {
        const ew = getWorkflow(wf.error_workflow_id);
        if (ew) await executeWorkflow(ew, [{ workflow_id: wf.id, workflow: wf.name, execution_id: execId, error: msg }], 'error', depth + 1);
      } catch (e2) {
        ctx.log.push('error-workflow gagal: ' + e2.message);
      }
    }
    return { status: 'error', execution_id: execId, error: msg, log: ctx.log };
  }
}

const runWorkflow = (wf, items, trigger, depth = 0) => limit(() => executeWorkflow(wf, items, trigger, depth));

// ---------- auth ----------
const sessionToken = () => crypto.createHmac('sha256', SECRET).update(PASSWORD).digest('hex');
const parseCookies = (h = '') => Object.fromEntries(h.split(';').map((p) => p.trim().split('=')).filter((p) => p.length === 2).map(([k, v]) => [k, decodeURIComponent(v)]));
function authed(req) {
  if (parseCookies(req.headers.cookie || '').sid === sessionToken()) return true;
  if (API_TOKEN && req.headers['x-api-key'] === API_TOKEN) return true;
  return false;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers));
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function readBody(req, limitBytes = 5 * 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limitBytes) throw new Error('payload terlalu besar');
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { _raw: text }; }
}

// ---------- webhook ----------
async function handleWebhook(req, res, url) {
  const p = decodeURIComponent(url.pathname.slice('/webhook/'.length));
  const rows = db.prepare('SELECT * FROM workflows WHERE active=1').all().map(hydrate);
  const wf = rows.find((w) => w.trigger === 'webhook' && (w.trigger_cfg.path || '') === p);
  if (!wf) return send(res, 404, { ok: false, error: 'webhook tidak ditemukan: ' + p });
  const method = String(wf.trigger_cfg.method || 'any').toUpperCase();
  if (method !== 'ANY' && method !== req.method) return send(res, 405, { ok: false, error: 'method tidak diizinkan' });

  const body = await readBody(req).catch(() => ({}));
  const items = [{
    body,
    query: Object.fromEntries(url.searchParams),
    headers: req.headers,
    method: req.method,
  }];

  if (url.searchParams.get('wait') === '1' || wf.trigger_cfg.wait) {
    const result = await runWorkflow(wf, items, 'webhook');
    if (result.status !== 'success') return send(res, 500, { ok: false, execution_id: result.execution_id, error: result.error });
    if (result.response) return send(res, result.response.status || 200, result.response.body);
    return send(res, 200, { ok: true, execution_id: result.execution_id, output: result.items });
  }
  runWorkflow(wf, items, 'webhook').catch((e) => console.error('webhook run', e.message));
  return send(res, 202, { ok: true, accepted: true });
}

// ---------- REST API ----------
async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // api, resource, id, action
  const resource = parts[1];
  const id = parts[2] ? Number(parts[2]) : null;
  const action = parts[3];

  if (resource === 'health') return send(res, 200, { ok: true, workflows: db.prepare('SELECT COUNT(*) c FROM workflows').get().c });

  if (resource === 'workflows') {
    if (!id && req.method === 'GET') {
      const rows = db.prepare('SELECT id,name,active,trigger,trigger_cfg,error_workflow_id,last_run,updated FROM workflows ORDER BY id').all();
      return send(res, 200, rows.map(hydrate));
    }
    if (!id && req.method === 'POST') {
      const body = await readBody(req);
      const now = nowIso();
      const r = db.prepare('INSERT INTO workflows(name,active,trigger,trigger_cfg,nodes,error_workflow_id,created,updated) VALUES(?,?,?,?,?,?,?,?)')
        .run(String(body.name || 'Workflow baru'), body.active ? 1 : 0, body.trigger || 'manual',
          JSON.stringify(body.trigger_cfg || {}), JSON.stringify(body.nodes || [{ type: 'manual', name: 'Start', config: {} }]),
          body.error_workflow_id || null, now, now);
      return send(res, 201, getWorkflow(Number(r.lastInsertRowid)));
    }
    if (id && req.method === 'GET') {
      const wf = getWorkflow(id);
      return wf ? send(res, 200, wf) : send(res, 404, { error: 'workflow tidak ada' });
    }
    if (id && req.method === 'PUT') {
      const body = await readBody(req);
      const wf = getWorkflow(id);
      if (!wf) return send(res, 404, { error: 'workflow tidak ada' });
      db.prepare('UPDATE workflows SET name=?,active=?,trigger=?,trigger_cfg=?,nodes=?,error_workflow_id=?,updated=? WHERE id=?')
        .run(body.name ?? wf.name, body.active !== undefined ? (body.active ? 1 : 0) : wf.active,
          body.trigger ?? wf.trigger, JSON.stringify(body.trigger_cfg ?? wf.trigger_cfg),
          typeof body.nodes === 'string' ? body.nodes : JSON.stringify(body.nodes ?? wf.nodes),
          body.error_workflow_id ?? wf.error_workflow_id, nowIso(), id);
      return send(res, 200, getWorkflow(id));
    }
    if (id && req.method === 'DELETE') {
      db.prepare('DELETE FROM workflows WHERE id=?').run(id);
      db.prepare('DELETE FROM executions WHERE workflow_id=?').run(id);
      return send(res, 200, { ok: true });
    }
    if (id && action === 'run' && req.method === 'POST') {
      const wf = getWorkflow(id);
      if (!wf) return send(res, 404, { error: 'workflow tidak ada' });
      const body = await readBody(req);
      const items = body.items ?? body.input ?? [{}];
      const result = await runWorkflow(wf, items, 'api');
      return send(res, result.status === 'success' ? 200 : 500, result);
    }
  }

  if (resource === 'executions') {
    if (!id && req.method === 'GET') {
      const wfId = url.searchParams.get('workflow_id');
      const rows = wfId
        ? db.prepare('SELECT id,workflow_id,status,trigger,started,finished,error FROM executions WHERE workflow_id=? ORDER BY id DESC LIMIT 100').all(Number(wfId))
        : db.prepare('SELECT id,workflow_id,status,trigger,started,finished,error FROM executions ORDER BY id DESC LIMIT 100').all();
      return send(res, 200, rows);
    }
    if (id && req.method === 'GET') {
      const row = db.prepare('SELECT * FROM executions WHERE id=?').get(id);
      return row ? send(res, 200, row) : send(res, 404, { error: 'eksekusi tidak ada' });
    }
  }

  return send(res, 404, { error: 'endpoint tidak ada' });
}

// ---------- static ----------
function serveStatic(res, file) {
  const p = path.join(PUBLIC_DIR, file);
  if (!p.startsWith(PUBLIC_DIR) || !fs.existsSync(p)) return send(res, 404, { error: 'not found' });
  const ext = path.extname(p);
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
  res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
  res.end(fs.readFileSync(p));
}

// ---------- http server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/webhook/')) return await handleWebhook(req, res, url);

    if (url.pathname === '/api/login' && req.method === 'POST') {
      const body = await readBody(req);
      const given = String(body.password || '');
      const ok = given.length === PASSWORD.length &&
        crypto.timingSafeEqual(Buffer.from(given), Buffer.from(PASSWORD));
      if (!ok) return send(res, 401, { error: 'password salah' });
      return send(res, 200, { ok: true }, {
        'Set-Cookie': `sid=${sessionToken()}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000`,
      });
    }

    if (url.pathname === '/api/logout') {
      return send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; Path=/; Max-Age=0' });
    }

    if (url.pathname.startsWith('/api/')) {
      if (!authed(req)) return send(res, 401, { error: 'unauthorized' });
      if (url.pathname === '/api/session') return send(res, 200, { ok: true });
      return await handleApi(req, res, url);
    }

    if (req.method === 'GET') {
      if (url.pathname === '/' || url.pathname === '/index.html') return serveStatic(res, 'index.html');
      return send(res, 404, { error: 'not found' });
    }
    return send(res, 405, { error: 'method tidak diizinkan' });
  } catch (e) {
    return send(res, 500, { error: e.message });
  }
});

// ---------- scheduler ----------
setInterval(() => {
  try {
    const rows = db.prepare("SELECT * FROM workflows WHERE active=1 AND trigger='schedule'").all().map(hydrate);
    const now = Date.now();
    for (const wf of rows) {
      const every = Math.max(1, Number(wf.trigger_cfg.every_minutes || 5)) * 60000;
      const last = wf.last_run ? Date.parse(wf.last_run) : 0;
      if (now - last < every) continue;
      db.prepare('UPDATE workflows SET last_run=? WHERE id=?').run(nowIso(), wf.id);
      runWorkflow(wf, [{ schedule: nowIso() }], 'schedule').catch((e) => console.error('schedule', e.message));
    }
  } catch (e) {
    console.error('scheduler:', e.message);
  }
}, 20000).unref();

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`n100n jalan di http://${HOST}:${PORT} (data: ${DATA_DIR})`);
  });
}

module.exports = { render, deepRender, evalExpr, runNode, executeWorkflow, runWorkflow, getWorkflow, db, server, hydrate };
