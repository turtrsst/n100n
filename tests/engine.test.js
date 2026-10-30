'use strict';
const { setupEnv } = require('./helpers');
const tmp = setupEnv();

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const { render, deepRender, evalExpr, makeScope } = require('../lib/template');
const { runNode, NODE_TYPES } = require('../lib/nodes');
const engine = require('../lib/engine');
const store = require('../lib/store');

engine.setStore(store);

const baseRun = (over = {}) => Object.assign({
  wf: { id: 1, name: 't', settings: {} }, execId: 1, depth: 0,
  log: [], runs: [], vars: {}, outputs: {}, response: null, getWorkflow: () => null,
}, over);

const runOne = async (node, items, run = baseRun()) => runNode(run, node, items);

test('template: interpolasi, objek utuh, env, dan field kosong', () => {
  process.env.UJI_ENV = 'envval';
  const scope = makeScope({ wf: { id: 1, name: 't' }, execId: 9, outputs: {}, vars: {} }, { a: 5, obj: { x: 1 } }, []);
  assert.strictEqual(render('halo {{ $json.a }}', scope), 'halo 5');
  assert.deepStrictEqual(render('{{ $json.obj }}', scope), { x: 1 });
  assert.strictEqual(render('{{ $env.UJI_ENV }}', scope), 'envval');
  assert.strictEqual(render('{{ $json.hilang }}', scope), '');
  assert.deepStrictEqual(deepRender({ x: '{{ $json.a }}', y: ['{{ $json.a }}'] }, scope), { x: 5, y: [5] });
  assert.strictEqual(evalExpr('1 +', scope), undefined, 'ekspresi salah tidak boleh melempar');
});

test('set node: merge field hasil template', async () => {
  const out = await runOne({ type: 'set', config: { fields: { b: '{{ $json.a + 1 }}', c: 'x' } } }, [{ a: 1 }]);
  assert.deepStrictEqual(out, [{ a: 1, b: 2, c: 'x' }]);
});

test('if node: filter item (perilaku lama tetap jalan)', async () => {
  const out = await runOne({ type: 'if', config: { condition: '$json.ok === true' } }, [{ ok: true }, { ok: false }]);
  assert.strictEqual(out.length, 1);
});

test('ifElse: memisahkan item ke cabang true dan false', async () => {
  const out = await runOne({ type: 'ifElse', config: { condition: '$json.n > 2' } }, [{ n: 3 }, { n: 1 }, { n: 5 }]);
  assert.deepStrictEqual(out.true.map((i) => i.n), [3, 5]);
  assert.deepStrictEqual(out.false.map((i) => i.n), [1]);
});

test('ifElse: conditions bersusun (operator) dan invert', async () => {
  const out = await runOne({
    type: 'ifElse',
    config: {
      conditions: [{ left: '$json.status', operator: 'eq', right: 'selesai' }, { left: '$json.ide', operator: 'notEmpty' }],
      combinator: 'and',
    },
  }, [{ status: 'selesai', ide: 'x' }, { status: 'selesai', ide: '' }, { status: 'diproses', ide: 'y' }]);
  assert.strictEqual(out.true.length, 1);
  assert.strictEqual(out.false.length, 2);
});

test('switch: routing ke beberapa output + fallback', async () => {
  const out = await runOne({
    type: 'switch',
    config: { rules: [{ output: 'ide', condition: '$json.tipe === "ide"' }], fallback: 'lain' },
  }, [{ tipe: 'ide' }, { tipe: 'lain' }]);
  assert.strictEqual(out.ide.length, 1);
  assert.strictEqual(out.lain.length, 1);
});

test('code node: items, $vars, $node dan objek bercabang', async () => {
  const run = baseRun({ outputs: { sumber: [{ v: 7 }] }, vars: { n: 2 } });
  const out = await runOne({ type: 'code', config: { code: 'return items.map(i => ({ v: i.a * 3 }));' } }, [{ a: 2 }], run);
  assert.deepStrictEqual(out, [{ v: 6 }]);

  const out2 = await runOne({ type: 'code', config: { code: 'return [{ d: $node.sumber[0].v + $vars.n }];' } }, [{}], run);
  assert.deepStrictEqual(out2, [{ d: 9 }]);

  const out3 = await runOne({ type: 'code', config: { code: 'return { true: [{ x: 1 }], false: [] };' } }, [{}]);
  assert.strictEqual(out3.true.length, 1);
  assert.strictEqual(out3.false.length, 0);
});

test('graf: cabang ifElse menyatu kembali dan item di-merge', async () => {
  const wf = {
    id: 101, name: 'merge', nodes: [
      { id: 'b', type: 'ifElse', config: { condition: "$json.k === 'a'" }, next: { true: 't', false: 'f' } },
      { id: 't', type: 'set', config: { fields: { jalur: 'true' } }, next: 'gabung' },
      { id: 'f', type: 'set', config: { fields: { jalur: 'false' } }, next: 'gabung' },
      { id: 'gabung', type: 'noop', config: {}, next: null },
    ],
  };
  const res = await engine.executeWorkflow(wf, [{ k: 'a' }, { k: 'b' }], 'test');
  assert.strictEqual(res.status, 'success');
  assert.strictEqual(res.items.length, 2);
  assert.deepStrictEqual(res.items.map((i) => i.jalur).sort(), ['false', 'true']);
});

test('graf: loop berjalan sampai kondisi berhenti', async () => {
  const wf = {
    id: 102, name: 'loop', nodes: [
      { id: 'a', type: 'set', config: { fields: { i: 0 } }, next: 'b' },
      { id: 'b', type: 'code', config: { code: 'return items.map(i => ({ ...i, i: i.i + 1 }));' }, next: 'c' },
      { id: 'c', type: 'ifElse', config: { condition: '$json.i < 3' }, next: { true: 'b', false: 'd' } },
      { id: 'd', type: 'noop', config: {}, next: null },
    ],
  };
  const res = await engine.executeWorkflow(wf, [{}], 'test');
  assert.strictEqual(res.status, 'success');
  assert.strictEqual(res.items[0].i, 3);
  const b = res.runs.filter((r) => r.id === 'b');
  assert.strictEqual(b.length, 3, 'node b dijalankan 3 kali');
});

test('graf: loop tanpa henti ditolak lewat max_visits', async () => {
  const wf = {
    id: 103, name: 'infinit', settings: { max_visits: 5 }, nodes: [
      { id: 'a', type: 'noop', config: {}, next: 'b' },
      { id: 'b', type: 'noop', config: {}, next: 'a' },
    ],
  };
  const res = await engine.executeWorkflow(wf, [{}], 'test');
  assert.strictEqual(res.status, 'error');
  assert.match(res.error, /max_visits|tanpa henti/i);
});

test('graf: node tanpa next memakai urutan array (kompatibel versi lama)', async () => {
  const wf = { id: 104, name: 'linear', nodes: [
    { type: 'set', name: 'satu', config: { fields: { a: 1 } } },
    { type: 'set', name: 'dua', config: { fields: { b: 2 } } },
  ] };
  const res = await engine.executeWorkflow(wf, [{}], 'test');
  assert.deepStrictEqual(res.items[0], { a: 1, b: 2 });
});

test('graf: onError continue melanjutkan alur dengan field error', async () => {
  const wf = { id: 105, name: 'err', nodes: [
    { id: 'a', type: 'http', config: { url: 'http://127.0.0.1:1/x' }, onError: 'continue', next: 'b' },
    { id: 'b', type: 'set', config: { fields: { lanjut: true } }, next: null },
  ] };
  const res = await engine.executeWorkflow(wf, [{}], 'test');
  assert.strictEqual(res.status, 'success');
  assert.strictEqual(res.items[0].lanjut, true);
  assert.match(res.items[0].error, /fetch|ECONN/i);
});

test('http: retry otomatis saat server membalas gagal lalu sukses', async (t) => {
  let hits = 0;
  const srv = http.createServer((req, res) => {
    hits++;
    if (hits < 3) { res.writeHead(503, { 'Content-Type': 'application/json' }); return res.end('{"ok":false}'); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, items: [{ a: 1 }, { a: 2 }] }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => { srv.closeAllConnections(); srv.close(); });
  const url = 'http://127.0.0.1:' + srv.address().port + '/data';

  // retry habis -> node melempar error (alur berhenti, bukan item error)
  hits = 0;
  await assert.rejects(
    () => runOne({ type: 'http', name: 'h', config: { url, retry: 1, retryDelayMs: 10 } }, [{}], baseRun()),
    /HTTP 503/
  );
  assert.strictEqual(hits, 2);

  hits = 0;
  const ok = await runOne({ type: 'http', name: 'h', config: { url, retry: 3, retryDelayMs: 10, split: '$json.items' } }, [{}], baseRun());
  assert.deepStrictEqual(ok, [{ a: 1 }, { a: 2 }]);
  assert.strictEqual(hits, 3);

  const kosong = await runOne({ type: 'http', name: 'h', config: { url, split: '$json.hilang', keepEmpty: true } }, [{}], baseRun());
  assert.deepStrictEqual(kosong, [{}], 'keepEmpty menjaga alur tetap dapat 1 item');
});

test('http: allowNon2xx mengembalikan error sebagai data', async (t) => {
  const srv = http.createServer((req, res) => {
    req.resume();
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end('{"pesan":"rusak"}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => { srv.closeAllConnections(); srv.close(); });
  const out = await runOne({ type: 'http', config: { url: 'http://127.0.0.1:' + srv.address().port, allowNon2xx: true } }, [{}]);
  assert.strictEqual(out[0].status, 500);
  assert.deepStrictEqual(out[0].body, { pesan: 'rusak' });
});

test('sheet csv: baca dengan header, append dengan kolom, lalu baca ulang', async () => {
  const file = path.join(tmp, 'tabel.csv');
  fs.writeFileSync(file, 'nama,nilai\nA,1\nB,2\n');

  const run = baseRun();
  const baca = await runOne({ type: 'sheet', config: { driver: 'csv', action: 'read', path: file } }, [{}], run);
  assert.deepStrictEqual(baca.map((r) => r.nama), ['A', 'B']);

  const run2 = baseRun();
  const tulis = await runOne({
    type: 'sheet',
    config: { driver: 'csv', action: 'append', path: path.join(tmp, 'baru.csv'), columns: ['x', 'y'], rows: [{ x: 7, y: 8 }] },
  }, [{}], run2);
  assert.strictEqual(tulis[0].ditambahkan, 1);
  assert.strictEqual(fs.readFileSync(path.join(tmp, 'baru.csv'), 'utf8'), 'x,y\n7,8\n');
});

test('validateWorkflow: menandai target next yang tidak ada', () => {
  const ok = engine.validateWorkflow({ nodes: [{ id: 'a', type: 'noop', next: null }] });
  assert.strictEqual(ok.ok, true);
  const bad = engine.validateWorkflow({ nodes: [{ id: 'a', type: 'noop', next: 'zzz' }] });
  assert.strictEqual(bad.ok, false);
  assert.match(bad.errors.join(' '), /tidak ada/);
  const typeBad = engine.validateWorkflow({ nodes: [{ id: 'a', type: 'ngawur' }] });
  assert.strictEqual(typeBad.ok, false);
});

test('error workflow dipanggil saat workflow utama gagal', async () => {
  const errorWf = store.createWorkflow({ name: 'penampung error', nodes: [{ id: 'e', type: 'noop', config: {}, next: null }] });
  const wf = { id: 106, name: 'gagal', error_workflow_id: errorWf.id, nodes: [{ id: 'a', type: 'tidak-ada', config: {} }] };
  const res = await engine.executeWorkflow(wf, [{}], 'test');
  assert.strictEqual(res.status, 'error');
  const execs = store.listExecutions({ workflowId: errorWf.id });
  assert.strictEqual(execs.length, 1);
  assert.strictEqual(execs[0].trigger, 'error');
});

test('delay/wait: ms, seconds, dan default 1 detik', async () => {
  const r = baseRun();
  const t0 = Date.now();
  await runNode(r, { id: 'd', type: 'delay', name: 'd', config: { seconds: 0.05 } }, [{}]);
  const lama = Date.now() - t0;
  assert.ok(lama >= 40 && lama < 400, 'seconds 0.05 -> ~50ms, dapat ' + lama);

  const t1 = Date.now();
  await runNode(r, { id: 'd2', type: 'delay', name: 'd2', config: {} }, [{}]);
  assert.ok(Date.now() - t1 >= 900, 'tanpa config -> default 1000ms');
});

test('registry node lengkap', () => {
  for (const t of ['manual', 'webhook', 'schedule', 'noop', 'set', 'code', 'log', 'if', 'ifElse', 'switch',
    'delay', 'wait', 'stop', 'respond', 'workflow', 'http', 'telegram', 'file', 'sheet']) {
    assert.ok(NODE_TYPES[t], 'node ' + t + ' harus terdaftar');
  }
});
