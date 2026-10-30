'use strict';
// Registry node. Setiap handler menerima (run, node, items) dan mengembalikan:
//   - array items                         -> output "main"
//   - { main: [], true: [], false: [], ... } -> output bercabang (dipakai ifElse/switch)
// Engine yang mengurus routing ke node berikutnya.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { render, deepRender, evalExpr, makeScope } = require('./template');
const { runSheet } = require('./sheets');

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, Number(ms) || 0)));

// ---------- helper ----------
function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function normalizeItems(items) {
  const arr = asArray(items);
  return arr.length ? arr : [{}];
}

function makeLogger(run) {
  return (msg) => run.log.push('[log] ' + String(msg));
}

// Konversi nilai config menjadi string yang sudah dirender; undefined -> ''.
function tpl(value, scope, run, fallback = '') {
  if (value === undefined || value === null) return fallback;
  const out = deepRender(value, scope, (e) => run.log.push('[template] ' + e.message));
  return out === undefined ? fallback : out;
}

// ---------- node handlers ----------
const NODE_TYPES = {
  // --- trigger (passthrough) ---
  manual: { label: 'Start manual', group: 'trigger' },
  webhook: { label: 'Webhook', group: 'trigger' },
  schedule: { label: 'Schedule', group: 'trigger' },
  trigger: { label: 'Trigger', group: 'trigger' },

  noop: { label: 'No-op (lanjut)', group: 'core' },

  set: { label: 'Set fields', group: 'core' },
  code: { label: 'Code (JS)', group: 'core' },
  log: { label: 'Log', group: 'core' },
  if: { label: 'Filter (if)', group: 'flow' },
  ifElse: { label: 'If / Else', group: 'flow' },
  switch: { label: 'Switch', group: 'flow' },
  delay: { label: 'Delay', group: 'flow' },
  wait: { label: 'Wait', group: 'flow' },
  stop: { label: 'Stop', group: 'flow' },
  respond: { label: 'Respond webhook', group: 'flow' },
  workflow: { label: 'Sub-workflow', group: 'flow' },

  http: { label: 'HTTP request', group: 'action' },
  telegram: { label: 'Telegram', group: 'action' },
  file: { label: 'File', group: 'action' },
  sheet: { label: 'Sheet (Google/CSV)', group: 'action' },
};

// --- core ---
NODE_TYPES.noop.run = (run, node, items) => items;

NODE_TYPES.set.run = (run, node, items) => {
  const cfg = node.config || {};
  const out = [];
  for (const item of items) {
    const scope = makeScope(run, item, items);
    const merged = Object.assign({}, item);
    for (const [k, v] of Object.entries(cfg.fields || {})) merged[k] = tpl(v, scope, run);
    out.push(merged);
  }
  return out;
};

NODE_TYPES.code.run = async (run, node, items) => {
  const cfg = node.config || {};
  const code = String(cfg.code || 'return items;');
  const sandbox = {
    JSON, Math, Date, Number, String, Boolean, Array, Object, RegExp, Promise,
    parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent,
    console: { log: (...a) => run.log.push('[console] ' + a.map(String).join(' ')) },
  };
  const fn = new vm.Script(
    `(async function(items, $env, $now, $workflow, $vars, $json, $items, $node, $execution){\n${code}\n})`,
    { filename: 'node-code.js' }
  ).runInNewContext(sandbox, { timeout: 5000 });

  const now = new Date().toISOString();
  const result = await fn(
    items,
    process.env,
    now,
    { id: run.wf.id, name: run.wf.name },
    run.vars,
    items[0] === undefined ? null : items[0],
    items,
    run.outputs,
    { id: run.execId }
  );

  if (Array.isArray(result)) return JSON.parse(JSON.stringify(result));
  if (result && typeof result === 'object' && !(result instanceof Promise)) {
    // objek bercabang { true: [...], false: [...] } atau satu objek biasa
    const keys = Object.keys(result);
    const isBranch = keys.length > 0 && keys.every((k) => Array.isArray(result[k]));
    if (isBranch && (keys.includes('true') || keys.includes('false') || keys.includes('main'))) {
      const out = {};
      for (const k of keys) out[k] = JSON.parse(JSON.stringify(result[k]));
      return out;
    }
    return [JSON.parse(JSON.stringify(result))];
  }
  if (result === undefined || result === null) return [];
  throw new Error('node code harus me-return array, objek, atau { true: [], false: [] }');
};

NODE_TYPES.log.run = (run, node, items) => {
  const cfg = node.config || {};
  for (const item of items) {
    const scope = makeScope(run, item, items);
    run.log.push('[node log] ' + String(tpl(cfg.message || '{{ $json }}', scope, run)));
  }
  return items;
};

// --- flow ---
NODE_TYPES['if'].run = (run, node, items) => {
  const cfg = node.config || {};
  const keep = [];
  for (const item of items) {
    const scope = makeScope(run, item, items);
    const ok = Boolean(evalExpr(String(cfg.condition || 'true'), scope, (e) => run.log.push('[if] ' + e.message)));
    if (ok !== Boolean(cfg.invert)) keep.push(item);
  }
  return keep;
};

NODE_TYPES.ifElse.run = (run, node, items) => {
  const cfg = node.config || {};
  const condition = String(cfg.condition || 'true');
  const invert = Boolean(cfg.invert);
  const yes = [];
  const no = [];
  for (const item of items) {
    const scope = makeScope(run, item, items);
    let ok;
    if (Array.isArray(cfg.conditions) && cfg.conditions.length) {
      ok = evaluateConditions(cfg.conditions, cfg.combinator, scope, run);
    } else {
      ok = Boolean(evalExpr(condition, scope, (e) => run.log.push('[ifElse] ' + e.message)));
    }
    if (ok !== invert) yes.push(item); else no.push(item);
  }
  return { true: yes, false: no };
};

NODE_TYPES.switch.run = (run, node, items) => {
  const cfg = node.config || {};
  const rules = Array.isArray(cfg.rules) ? cfg.rules : [];
  const out = {};
  const fallback = String(cfg.fallback || 'lain');
  for (const rule of rules) if (rule.output) out[rule.output] = [];
  out[fallback] = [];
  for (const item of items) {
    const scope = makeScope(run, item, items);
    let matched = null;
    for (const rule of rules) {
      if (!rule.output) continue;
      const hit = rule.condition ? Boolean(evalExpr(String(rule.condition), scope)) : false;
      if (hit) { matched = rule.output; break; }
    }
    out[matched || fallback].push(item);
  }
  return out;
};

NODE_TYPES.delay.run = async (run, node, items) => {
  const cfg = node.config || {};
  const ms = Number(cfg.ms ?? (cfg.seconds !== undefined ? Number(cfg.seconds) * 1000 : 1000));
  await sleep(Math.min(Math.max(ms, 0), 10 * 60 * 1000));
  return items;
};

NODE_TYPES.wait.run = NODE_TYPES.delay.run;

NODE_TYPES.stop.run = () => ({ main: [] });

NODE_TYPES.respond.run = (run, node, items) => {
  const cfg = node.config || {};
  const scope = makeScope(run, items[0] === undefined ? {} : items[0], items);
  run.response = {
    status: Number(cfg.status || 200),
    body: tpl(cfg.body === undefined ? { ok: true } : cfg.body, scope, run),
  };
  return items;
};

NODE_TYPES.workflow.run = async (run, node, items) => {
  const cfg = node.config || {};
  const { executeWorkflow } = require('./engine');
  const subId = Number(cfg.workflow_id);
  const sub = run.getWorkflow ? run.getWorkflow(subId) : null;
  if (!sub) throw new Error('sub-workflow tidak ditemukan: ' + cfg.workflow_id);
  const res = await executeWorkflow(sub, items, 'sub', (run.depth || 0) + 1);
  if (res.status !== 'success') throw new Error('sub-workflow gagal: ' + (res.error || ''));
  run.log.push('sub-workflow #' + sub.id + ' -> ' + res.items.length + ' item');
  return res.items;
};

// --- action ---
NODE_TYPES.http.run = async (run, node, items) => {
  const cfg = node.config || {};
  const each = Boolean(cfg.each);
  const maxAttempts = Math.max(1, Number(cfg.retry || 0) + 1);
  const retryDelayMs = Number(cfg.retryDelayMs ?? 500);
  const label = node.name || 'http';

  const call = async (item) => {
    const scope = makeScope(run, item, items);
    let url = String(tpl(cfg.url, scope, run, ''));
    if (!url) throw new Error('config.url kosong');
    const query = tpl(cfg.query || {}, scope, run);
    if (query && typeof query === 'object' && Object.keys(query).length) {
      const u = new URL(url);
      for (const [k, v] of Object.entries(query)) if (v !== '' && v !== undefined) u.searchParams.set(k, String(v));
      url = u.toString();
    }

    const headers = tpl(cfg.headers || {}, scope, run);
    let body;
    if (cfg.body !== undefined && cfg.body !== null && cfg.body !== '') {
      const b = tpl(cfg.body, scope, run);
      body = typeof b === 'string' ? b : JSON.stringify(b);
      const hasCt = Object.keys(headers).some((h) => h.toLowerCase() === 'content-type');
      if (!hasCt) headers['Content-Type'] = 'application/json';
    }

    const asText = String(cfg.responseType || 'auto').toLowerCase() === 'text';
    let lastErr;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let res;
      try {
        res = await fetch(url, {
          method: String(cfg.method || 'GET').toUpperCase(),
          headers,
          body,
          signal: AbortSignal.timeout(Number(cfg.timeoutMs || 30000)),
        });
      } catch (e) {
        lastErr = e;
        if (attempt === maxAttempts) throw e;
        run.log.push(`${label}: ${e.message} — ulangi ${attempt}/${maxAttempts - 1}`);
        await sleep(retryDelayMs * Math.pow(2, attempt - 1));
        continue;
      }

      const text = await res.text();
      // 5xx / 429 dianggap sementara -> ulangi (bukan langsung menggagalkan workflow)
      const sementara = res.status >= 500 || res.status === 429;
      if (!res.ok && sementara && attempt < maxAttempts) {
        lastErr = new Error('HTTP ' + res.status + ': ' + String(text).slice(0, 200));
        run.log.push(`${label}: HTTP ${res.status} — ulangi ${attempt}/${maxAttempts - 1}`);
        await sleep(retryDelayMs * Math.pow(2, attempt - 1));
        continue;
      }

      let data;
      if (asText) data = text;
      else { try { data = JSON.parse(text); } catch { data = text; } }

      if (!res.ok) {
        const msg = 'HTTP ' + res.status + ': ' + String(text).slice(0, 300);
        if (cfg.allowNon2xx) {
          return cfg.fullResponse
            ? { status: res.status, headers: Object.fromEntries(res.headers), body: data, error: msg }
            : { error: msg, status: res.status, body: data };
        }
        throw new Error(msg);
      }
      return cfg.fullResponse
        ? { status: res.status, headers: Object.fromEntries(res.headers), body: data }
        : data;
    }
    throw lastErr || new Error('request gagal tanpa keterangan');
  };

  const expand = (data) => {
    let list = Array.isArray(data) ? data : [data];
    if (cfg.split) {
      const scope = makeScope(run, data, list);
      const picked = evalExpr(String(cfg.split), scope, (e) => run.log.push('[http.split] ' + e.message));
      list = Array.isArray(picked) ? picked : picked === undefined ? [] : [picked];
    }
    if (!list.length && cfg.keepEmpty) list = [{}];
    return list;
  };

  if (!each) return expand(await call(items[0] === undefined ? {} : items[0]));

  const out = [];
  for (const item of items) {
    out.push(...expand(await call(item)));
    if (cfg.delayMs) await sleep(cfg.delayMs);
  }
  return out;
};

NODE_TYPES.telegram.run = async (run, node, items) => {
  const cfg = node.config || {};
  const out = [];
  for (const item of items) {
    const scope = makeScope(run, item, items);
    const token = String(tpl(cfg.token || '{{ $env.TELEGRAM_TOKEN }}', scope, run, ''));
    const chat = String(tpl(cfg.chat_id || '{{ $env.TELEGRAM_CHAT_ID }}', scope, run, ''));
    const text = String(tpl(cfg.text || '', scope, run, ''));
    if (!token) throw new Error('token telegram kosong (set TELEGRAM_TOKEN di .env)');
    if (!chat) throw new Error('chat_id telegram kosong (set TELEGRAM_CHAT_ID di .env)');
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: cfg.parse_mode || undefined, disable_notification: Boolean(cfg.silent) }),
      signal: AbortSignal.timeout(Number(cfg.timeoutMs || 15000)),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error('telegram gagal: ' + (data.description || res.status));
    out.push({ ok: true, message_id: data.result && data.result.message_id });
    if (cfg.delayMs) await sleep(cfg.delayMs);
  }
  return out;
};

NODE_TYPES.file.run = (run, node, items) => {
  const cfg = node.config || {};
  const action = String(cfg.action || 'read').toLowerCase();
  const out = [];
  for (const item of items) {
    const scope = makeScope(run, item, items);
    const p = String(tpl(cfg.path || '', scope, run, ''));
    if (!p) throw new Error('config.path kosong');
    if (action === 'read') {
      out.push({ path: p, content: fs.readFileSync(p, 'utf8') });
    } else if (action === 'exists') {
      out.push({ path: p, exists: fs.existsSync(p) });
    } else {
      const content = String(tpl(cfg.content === undefined ? '' : cfg.content, scope, run, ''));
      fs.mkdirSync(path.dirname(p), { recursive: true });
      if (action === 'append') fs.appendFileSync(p, content);
      else fs.writeFileSync(p, content);
      out.push({ path: p, ok: true });
    }
    if (cfg.delayMs) sleep(cfg.delayMs);
  }
  return out;
};

NODE_TYPES.sheet.run = async (run, node, items) => {
  const cfg = node.config || {};
  const results = [];
  for (const item of items) {
    const scope = makeScope(run, item, items);
    const conf = tpl(cfg, scope, run);
    if (conf.rows === undefined && conf.values === undefined) {
      // izinkan baris diambil dari item: {{ $json }}
      const fromItem = item && (item.rows || item.values);
      if (fromItem) conf.rows = fromItem;
    }
    const res = await runSheet(conf);
    run.log.push(`sheet ${conf.action || 'read'} (${conf.driver || 'google'}): ${res.items.length} baris`);
    results.push(...res.items);
  }
  return results;
};

// Nilai pembanding: "{{ ... }}" dirender, "$..." dievaluasi sebagai ekspresi, sisanya literal.
function resolveOperand(value, scope) {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  if (t.startsWith('{{')) return render(t, scope);
  if (t.startsWith('$')) return evalExpr(t, scope);
  return value;
}

function evaluateConditions(conditions, combinator, scope, run) {
  const results = conditions.map((c) => {
    const left = c.left !== undefined ? resolveOperand(c.left, scope) : scope.$json;
    const right = c.right !== undefined ? resolveOperand(c.right, scope) : c.value;
    switch (String(c.operator || 'eq')) {
      case 'eq': return String(left) === String(right);
      case 'neq': return String(left) !== String(right);
      case 'gt': return Number(left) > Number(right);
      case 'gte': return Number(left) >= Number(right);
      case 'lt': return Number(left) < Number(right);
      case 'lte': return Number(left) <= Number(right);
      case 'contains': return String(left ?? '').includes(String(right ?? ''));
      case 'notContains': return !String(left ?? '').includes(String(right ?? ''));
      case 'empty': return left === '' || left === null || left === undefined || (Array.isArray(left) && !left.length);
      case 'notEmpty': return !(left === '' || left === null || left === undefined || (Array.isArray(left) && !left.length));
      case 'truthy': return Boolean(left);
      case 'falsy': return !Boolean(left);
      default:
        run.log.push('[ifElse] operator tidak dikenal: ' + c.operator);
        return false;
    }
  });
  return String(combinator || 'and').toLowerCase() === 'or' ? results.some(Boolean) : results.every(Boolean);
}

async function runNode(run, node, items) {
  const def = NODE_TYPES[node.type];
  if (!def) throw new Error('tipe node tidak dikenal: ' + node.type);
  if (!def.run) return items; // trigger = passthrough
  return def.run(run, node, items);
}

function normalizeOutputs(result) {
  if (Array.isArray(result)) return { main: result };
  if (result && typeof result === 'object') {
    const out = {};
    let any = false;
    for (const [k, v] of Object.entries(result)) {
      if (Array.isArray(v)) { out[k] = v; any = true; }
    }
    if (any) return out;
  }
  return { main: [] };
}

module.exports = { NODE_TYPES, runNode, normalizeOutputs, normalizeItems, asArray, sleep, evaluateConditions };
