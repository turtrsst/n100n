'use strict';
const path = require('node:path');
const os = require('node:os');
process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'n100n-test-' + Date.now());
process.env.APP_PASSWORD = 'test';

const test = require('node:test');
const assert = require('node:assert');
const { render, runNode, executeWorkflow } = require('./server.js');

const scope = (item) => ({
  $json: item, $items: [item], $env: { X: 'envval' },
  $now: '2026-01-01T00:00:00.000Z', $workflow: { id: 1, name: 't' },
});

test('render: interpolasi string dan objek utuh', () => {
  assert.strictEqual(render('halo {{ $json.a }}', scope({ a: 5 })), 'halo 5');
  assert.deepStrictEqual(render('{{ $json.obj }}', scope({ obj: { x: 1 } })), { x: 1 });
  assert.strictEqual(render('{{ $env.X }}', scope({})), 'envval');
  assert.strictEqual(render('{{ $json.missing }}', scope({})), '');
});

test('set node: merge field hasil template', async () => {
  const ctx = { wf: { id: 1, name: 't' }, items: [{ a: 1 }], execId: 1, log: [], depth: 0 };
  const out = await runNode(ctx, { type: 'set', config: { fields: { b: '{{ $json.a + 1 }}', c: 'x' } } });
  assert.deepStrictEqual(out, [{ a: 1, b: 2, c: 'x' }]);
});

test('if node: filter item', async () => {
  const ctx = { wf: { id: 1, name: 't' }, items: [{ ok: true }, { ok: false }], execId: 1, log: [], depth: 0 };
  const out = await runNode(ctx, { type: 'if', config: { condition: '$json.ok === true' } });
  assert.strictEqual(out.length, 1);
});

test('workflow: sukses mencatat eksekusi, node gagal -> status error', async () => {
  const wf = { id: 900, name: 't', nodes: [{ type: 'set', name: 's', config: { fields: { n: '{{ 1 }}' } } }] };
  const ok = await executeWorkflow(wf, [{}], 'test');
  assert.strictEqual(ok.status, 'success');
  assert.strictEqual(ok.items[0].n, 1);

  const bad = { id: 901, name: 't', nodes: [{ type: 'tidak-ada', name: 'x', config: {} }] };
  const res = await executeWorkflow(bad, [{}], 'test');
  assert.strictEqual(res.status, 'error');
  assert.match(res.error, /tidak dikenal/);
});

test('code node: sandbox menerima items dan return array', async () => {
  const ctx = { wf: { id: 1, name: 't' }, items: [{ a: 2 }], execId: 1, log: [], depth: 0 };
  const out = await runNode(ctx, { type: 'code', config: { code: 'return items.map(i => ({ v: i.a * 3 }));' } });
  assert.deepStrictEqual(out, [{ v: 6 }]);
});
