'use strict';
// Template & ekspresi ala n8n: {{ $json.field }}, {{ $env.X }}, {{ $now }}, {{ $vars.n }}
// Semua evaluasi memakai vm dengan timeout 2 detik agar workflow tidak bisa menggantung proses.

const vm = require('node:vm');

const EVAL_TIMEOUT_MS = 2000;

function evalExpr(expr, scope, onError) {
  try {
    return vm.runInNewContext(expr, scope, { timeout: EVAL_TIMEOUT_MS });
  } catch (e) {
    if (typeof onError === 'function') onError(e);
    return undefined;
  }
}

function render(tpl, scope, onError) {
  if (typeof tpl !== 'string') return tpl;
  const whole = tpl.match(/^\s*\{\{([\s\S]+)\}\}\s*$/);
  if (whole) {
    const v = evalExpr(whole[1], scope, onError);
    return v === undefined ? '' : v;
  }
  return tpl.replace(/\{\{([\s\S]+?)\}\}/g, (_, e) => {
    const v = evalExpr(e, scope, onError);
    if (v === undefined || v === null) return '';
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

function deepRender(value, scope, onError) {
  if (typeof value === 'string') return render(value, scope, onError);
  if (Array.isArray(value)) return value.map((v) => deepRender(v, scope, onError));
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = deepRender(value[k], scope, onError);
    return out;
  }
  return value;
}

// Scope yang dipakai bersama oleh node template, node if/ifElse, dan node code.
function makeScope(run, item, items) {
  return {
    $json: item === undefined ? null : item,
    $items: items || [],
    $env: process.env,
    $now: new Date().toISOString(),
    $today: new Date().toISOString().slice(0, 10),
    $workflow: { id: run.wf.id, name: run.wf.name },
    $execution: { id: run.execId },
    $node: run.outputs || {},
    $vars: run.vars || {},
    $branch: run.branch || null,
  };
}

module.exports = { evalExpr, render, deepRender, makeScope };
