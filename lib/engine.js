'use strict';
// Engine eksekusi: graf node (mendukung bercabang true/false, switch, dan loop) dengan
// fallback kompatibel: kalau node tidak punya `next`, node berikutnya di array yang dijalankan.

const { runNode, normalizeOutputs, normalizeItems, NODE_TYPES } = require('./nodes');

const MAX_PARALLEL = Math.max(1, Number(process.env.APP_MAX_PARALLEL || 2));
const DEFAULT_MAX_VISITS = 100;
const DEFAULT_MAX_STEPS = 1000;

// ---------- normalisasi ----------
function normalizeNodes(nodes) {
  return (Array.isArray(nodes) ? nodes : []).map((node, i) => {
    const id = node && node.id !== undefined && node.id !== null && node.id !== ''
      ? String(node.id)
      : 'n' + (i + 1);
    return Object.assign({}, node, { id, type: node.type || 'noop', name: node.name || id });
  });
}

function resolveRef(ref, nodes, byId) {
  if (ref === undefined || ref === null || ref === '' || ref === false) return null;
  const raw = String(ref).trim();
  if (byId.has(raw)) return raw;
  if (/^#\d+$/.test(raw)) {
    const idx = Number(raw.slice(1)) - 1;
    return nodes[idx] ? nodes[idx].id : null;
  }
  if (/^\d+$/.test(raw)) {
    const idx = Number(raw) - 1;
    return nodes[idx] ? nodes[idx].id : null;
  }
  return null;
}

function concatOutputs(outputs) {
  const out = [];
  for (const v of Object.values(outputs)) if (Array.isArray(v)) out.push(...v);
  return out;
}

// Tentukan node tujuan dari output sebuah node.
function resolveTargets(node, outputs, nodes, byId) {
  const next = node.next;
  const mainItems = outputs.main !== undefined ? outputs.main : concatOutputs(outputs);

  if (next === undefined) {
    // mode linear kompatibel
    const idx = nodes.findIndex((n) => n.id === node.id);
    const target = nodes[idx + 1];
    return target ? [{ to: target.id, items: mainItems, output: 'main' }] : [];
  }
  if (next === null || next === false || next === 'end' || next === 'stop') return [];
  if (typeof next === 'string') {
    const to = resolveRef(next, nodes, byId);
    if (!to) throw new Error(`node "${node.name}": target "${next}" tidak ditemukan`);
    return mainItems.length ? [{ to, items: mainItems, output: 'main' }] : [];
  }
  if (typeof next !== 'object') throw new Error(`node "${node.name}": format next tidak dikenal`);

  const targets = [];
  for (const [outputName, ref] of Object.entries(next)) {
    if (ref === null || ref === false || ref === '') continue;
    const items = outputName === 'main'
      ? mainItems
      : (outputs[outputName] || []);
    if (!items.length) continue;
    const to = resolveRef(ref, nodes, byId);
    if (!to) throw new Error(`node "${node.name}": target "${ref}" (output ${outputName}) tidak ditemukan`);
    targets.push({ to, items, output: outputName });
  }
  return targets;
}

// ---------- concurrency ----------
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

// ---------- eksekusi ----------
let storeRef = null;
function setStore(store) { storeRef = store; }
function getStore() {
  if (!storeRef) storeRef = require('./store');
  return storeRef;
}

async function runGraph(run, nodes, inputItems) {
  if (!nodes.length) return inputItems;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const settings = run.wf.settings || {};
  const maxSteps = Math.max(1, Number(settings.max_steps || DEFAULT_MAX_STEPS));
  const defaultMaxVisits = Math.max(1, Number(settings.max_visits || DEFAULT_MAX_VISITS));

  const queue = [];
  const queued = new Map(); // id -> entry (agar dua cabang ke node sama otomatis merge)
  const visits = new Map();
  const finals = [];
  let steps = 0;

  const enqueue = (to, items) => {
    if (!items || !items.length) return;
    if (queued.has(to)) {
      queued.get(to).items.push(...items);
      return;
    }
    const entry = { id: to, items: items.slice() };
    queued.set(to, entry);
    queue.push(entry);
  };

  const start = nodes.find((n) => n.id === String(settings.start || '')) || nodes[0];
  enqueue(start.id, inputItems);

  while (queue.length) {
    const entry = queue.shift();
    queued.delete(entry.id);
    const node = byId.get(entry.id);
    if (!node) throw new Error('node tidak ditemukan: ' + entry.id);
    if (++steps > maxSteps) throw new Error(`batas langkah (${maxSteps}) terlampaui — workflow berpotensi loop tanpa henti`);

    const visit = (visits.get(node.id) || 0) + 1;
    visits.set(node.id, visit);
    const nodeMaxVisits = Math.max(1, Number(node.max_visits || defaultMaxVisits));
    if (visit > nodeMaxVisits) {
      if (node.on_limit === 'continue' || node.on_limit === 'stop') {
        run.log.push(`[limit] ${node.name}: dilewati setelah ${nodeMaxVisits} kali (on_limit=${node.on_limit})`);
        continue;
      }
      throw new Error(`node "${node.name}" dijalankan ${visit} kali melebihi max_visits=${nodeMaxVisits} (loop tak berhenti?)`);
    }

    const t0 = Date.now();
    // config.once = jalankan sekali saja walau ada banyak item (mis. baca sheet)
    const nodeItems = node.config && node.config.once ? entry.items.slice(0, 1) : entry.items;
    let outputs;
    try {
      const raw = await runNode(run, node, nodeItems);
      outputs = normalizeOutputs(raw);
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      run.log.push(`ERROR di node ${node.name}: ${msg}`);
      if (node.onError === 'continue' || node.config && node.config.continueOnFail) {
        outputs = { main: nodeItems.map((it) => Object.assign({}, it, { error: msg, failedNode: node.name })) };
        run.runs.push({
          id: node.id, name: node.name, type: node.type, in: nodeItems.length,
          out: { main: outputs.main.length }, ms: Date.now() - t0, visit, error: msg, continued: true,
        });
      } else {
        run.runs.push({
          id: node.id, name: node.name, type: node.type, in: nodeItems.length,
          out: {}, ms: Date.now() - t0, visit, error: msg,
        });
        throw e;
      }
    }

    if (outputs !== undefined) {
      if (process.env.APP_DEBUG === '1') {
        console.log(`[debug] ${node.id} ${node.name} out=${JSON.stringify(outputs).slice(0, 600)}`);
      }
      const summary = {};
      for (const [k, v] of Object.entries(outputs)) summary[k] = v.length;
      run.outputs[node.name] = outputs.main !== undefined ? outputs.main : concatOutputs(outputs);
      run.outputs[node.id] = run.outputs[node.name];
      if (!run.runs.length || run.runs[run.runs.length - 1].id !== node.id || run.runs[run.runs.length - 1].visit !== visit) {
        run.runs.push({
          id: node.id, name: node.name, type: node.type,
          in: nodeItems.length, out: summary, ms: Date.now() - t0, visit,
        });
      }
      run.log.push(`${node.name}: ${Object.entries(summary).map(([k, v]) => k + '=' + v).join(' ') || 'kosong'} (${Date.now() - t0}ms)`);
    }

    const targets = resolveTargets(node, outputs, nodes, byId);
    if (!targets.length) {
      const finalItems = outputs.main !== undefined ? outputs.main : concatOutputs(outputs);
      finals.push(...finalItems);
    }
    for (const t of targets) enqueue(t.to, t.items);
  }

  return finals;
}

async function executeWorkflow(wf, items, trigger, depth = 0, hook = null) {
  if (depth > 5) throw new Error('sub-workflow terlalu dalam (rekursi?)');
  const store = getStore();
  const input = normalizeItems(items);
  const nodes = normalizeNodes(wf.nodes);
  const execId = store.createExecution(wf.id, trigger || 'manual', input);
  if (hook && typeof hook.onStart === 'function') hook.onStart(execId);

  const run = {
    wf, execId, depth, log: [], runs: [], vars: {}, outputs: {}, response: null, branch: null,
    getWorkflow: (id) => store.getWorkflow(id),
  };

  try {
    const finals = await runGraph(run, nodes, input);
    store.finishExecution(execId, {
      status: 'success', output: finals, log: run.log.join('\n'), runs: run.runs,
    });
    return { status: 'success', execution_id: execId, items: finals, response: run.response, log: run.log, runs: run.runs };
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    run.log.push('ERROR: ' + msg);
    store.finishExecution(execId, {
      status: 'error', output: [], error: msg, log: run.log.join('\n'), runs: run.runs,
    });
    if (wf.error_workflow_id && depth === 0) {
      try {
        const ew = store.getWorkflow(wf.error_workflow_id);
        if (ew) {
          await executeWorkflow(ew, [{ workflow_id: wf.id, workflow: wf.name, execution_id: execId, error: msg }], 'error', depth + 1);
        }
      } catch (e2) {
        run.log.push('error-workflow gagal: ' + e2.message);
      }
    }
    return { status: 'error', execution_id: execId, error: msg, items: [], log: run.log, runs: run.runs };
  }
}

const runWorkflow = (wf, items, trigger, depth = 0, hook = null) => limit(() => executeWorkflow(wf, items, trigger, depth, hook));

// ---------- validasi ----------
function validateWorkflow(wf) {
  const nodes = normalizeNodes(wf.nodes);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const errors = [];
  const warnings = [];
  if (!nodes.length) errors.push('workflow tidak punya node');
  nodes.forEach((node) => {
    if (!NODE_TYPES[node.type]) errors.push(`node "${node.name}": tipe tidak dikenal "${node.type}"`);
    if (node.next !== undefined && node.next !== null && node.next !== 'end' && node.next !== 'stop') {
      const refs = typeof node.next === 'string' ? [['main', node.next]] : Object.entries(node.next);
      for (const [output, ref] of refs) {
        if (!ref) continue;
        if (!resolveRef(ref, nodes, byId)) errors.push(`node "${node.name}": target "${ref}" (${output}) tidak ada`);
      }
    }
    if (node.type === 'ifElse' && !node.next) warnings.push(`node "${node.name}": ifElse tanpa next, cabang true/false akan memakai urutan array`);
  });
  return { ok: errors.length === 0, errors, warnings, nodes: nodes.length };
}

module.exports = {
  executeWorkflow, runWorkflow, runGraph, normalizeNodes, resolveTargets, resolveRef,
  validateWorkflow, setStore, getStore, limit, NODE_TYPES,
};
