'use strict';
const { setupEnv, startServer, call } = require('./helpers');
setupEnv();

const test = require('node:test');
const assert = require('node:assert');
const { server, store, scheduleDue, VERSION } = require('../server');

let base = '';
const TOKEN = 'tok-test';

test.before(async () => { base = await startServer(server); });
test.after(() => { server.closeAllConnections(); server.close(); });

test('health publik tanpa auth', async () => {
  const r = await call(base, 'GET', '/api/health');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.ok, true);
  assert.strictEqual(r.data.version, VERSION);
});

test('endpoint /api/* menolak tanpa kredensial', async () => {
  const r = await call(base, 'GET', '/api/workflows');
  assert.strictEqual(r.status, 401);
});

test('login: password salah ditolak, password benar memberi cookie sesi', async () => {
  const salah = await call(base, 'POST', '/api/login', { body: { password: 'salah' } });
  assert.strictEqual(salah.status, 401);

  const res = await fetch(base + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'rahasia123' }),
  });
  assert.strictEqual(res.status, 200);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const sesi = await fetch(base + '/api/session', { headers: { cookie } });
  assert.strictEqual(sesi.status, 200);
});

test('CRUD workflow lewat API key', async () => {
  const made = await call(base, 'POST', '/api/workflows', {
    token: TOKEN,
    body: { name: 'uji crud', nodes: [{ id: 'a', type: 'noop', config: {}, next: null }] },
  });
  assert.strictEqual(made.status, 201);
  assert.strictEqual(made.data.name, 'uji crud');

  const got = await call(base, 'GET', '/api/workflows/' + made.data.id, { token: TOKEN });
  assert.strictEqual(got.status, 200);
  assert.strictEqual(got.data.nodes[0].id, 'a');

  const upd = await call(base, 'PUT', '/api/workflows/' + made.data.id, {
    token: TOKEN, body: { name: 'uji crud 2', active: true },
  });
  assert.strictEqual(upd.data.name, 'uji crud 2');
  assert.strictEqual(upd.data.active, 1);

  const del = await call(base, 'DELETE', '/api/workflows/' + made.data.id, { token: TOKEN });
  assert.strictEqual(del.status, 200);
  const gone = await call(base, 'GET', '/api/workflows/' + made.data.id, { token: TOKEN });
  assert.strictEqual(gone.status, 404);
});

test('run sinkron mencatat eksekusi + detail per node', async () => {
  const wf = store.createWorkflow({
    name: 'run sync',
    nodes: [
      { id: 'a', type: 'set', config: { fields: { dua: '{{ $json.satu * 2 }}' } }, next: 'b' },
      { id: 'b', type: 'noop', config: {}, next: null },
    ],
  });
  const run = await call(base, 'POST', `/api/workflows/${wf.id}/run`, { token: TOKEN, body: { items: [{ satu: 21 }] } });
  assert.strictEqual(run.status, 200);
  assert.strictEqual(run.data.status, 'success');
  assert.strictEqual(run.data.items[0].dua, 42);

  const list = await call(base, 'GET', '/api/executions?workflow_id=' + wf.id, { token: TOKEN });
  assert.strictEqual(list.data.length, 1);
  assert.strictEqual(list.data[0].status, 'success');

  const detail = await call(base, 'GET', '/api/executions/' + run.data.execution_id, { token: TOKEN });
  assert.strictEqual(detail.data.runs.length, 2);
  assert.deepStrictEqual(detail.data.runs.map((r) => r.id), ['a', 'b']);
  assert.deepStrictEqual(detail.data.runs.map((r) => r.name), ['a', 'b'], 'nama default = id node');
  assert.match(detail.data.log, /noop|a:|b:/);
});

test('run async mengembalikan 202 dan bisa di-poll sampai selesai', async () => {
  const wf = store.createWorkflow({
    name: 'run async',
    nodes: [
      { id: 'a', type: 'delay', config: { ms: 300 }, next: 'b' },
      { id: 'b', type: 'set', config: { fields: { selesai: true } }, next: null },
    ],
  });
  const run = await call(base, 'POST', `/api/workflows/${wf.id}/run?async=1`, { token: TOKEN, body: { items: [{}] } });
  assert.strictEqual(run.status, 202);
  assert.ok(run.data.execution_id);

  const done = await call(base, 'GET', `/api/executions/${run.data.execution_id}?wait=1`, { token: TOKEN });
  assert.strictEqual(done.status, 200);
  assert.strictEqual(done.data.status, 'success');
  assert.strictEqual(done.data.output[0].selesai, true);
});

test('workflow error mengembalikan 500 + pesan', async () => {
  const wf = store.createWorkflow({ name: 'rusak', nodes: [{ id: 'a', type: 'code', config: { code: 'return JSON.parse("{");' }, next: null }] });
  const run = await call(base, 'POST', `/api/workflows/${wf.id}/run`, { token: TOKEN, body: { items: [{}] } });
  assert.strictEqual(run.status, 500);
  assert.strictEqual(run.data.status, 'error');
  assert.ok(run.data.error);
});

test('webhook: token, method, aktif/nonaktif, dan respond', async () => {
  const wf = store.createWorkflow({
    name: 'hook',
    active: 1,
    trigger: 'webhook',
    trigger_cfg: { path: 'kra-hook', method: 'POST', token: 'rahasia-hook' },
    nodes: [
      { id: 'a', type: 'respond', config: { status: 201, body: { ok: true, nama: '{{ $json.body.nama }}' } }, next: null },
    ],
  });

  const ok = await call(base, 'POST', '/webhook/kra-hook?wait=1', {
    body: { nama: 'Rama' }, token: undefined,
  });
  assert.strictEqual(ok.status, 401, 'tanpa x-webhook-token harus 401');

  const res = await fetch(base + '/webhook/kra-hook?wait=1&token=rahasia-hook', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nama: 'Rama' }),
  });
  assert.strictEqual(res.status, 201);
  assert.deepStrictEqual(await res.json(), { ok: true, nama: 'Rama' });

  const salahMethod = await fetch(base + '/webhook/kra-hook?token=rahasia-hook', { method: 'GET' });
  assert.strictEqual(salahMethod.status, 405);

  store.updateWorkflow(wf.id, { active: false });
  const nonaktif = await fetch(base + '/webhook/kra-hook?token=rahasia-hook', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.strictEqual(nonaktif.status, 404);
});

test('webhook tanpa wait: 202 + execution_id yang bisa dipantau', async () => {
  const wf = store.createWorkflow({
    name: 'hook-async',
    active: 1,
    trigger: 'webhook',
    trigger_cfg: { path: 'hook-async', method: 'POST', wait: false },
    nodes: [
      { id: 'a', type: 'wait', config: { ms: 120 }, next: 'b' },
      { id: 'b', type: 'code', config: { code: 'return [{ selesai: true }];' }, next: null },
    ],
  });

  const res = await fetch(base + '/webhook/hook-async', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ x: 1 }),
  });
  const data = await res.json();
  assert.strictEqual(res.status, 202);
  assert.ok(data.execution_id > 0, 'execution_id harus ada agar KRA bisa poll');
  assert.strictEqual(data.poll, '/api/executions/' + data.execution_id + '?wait=1');

  const pantau = await call(base, 'GET', `/api/executions/${data.execution_id}?wait=1&timeoutMs=5000`, { token: TOKEN });
  assert.strictEqual(pantau.status, 200);
  assert.strictEqual(pantau.data.status, 'success');
  assert.strictEqual(pantau.data.output[0].selesai, true);
  store.updateWorkflow(wf.id, { active: false });
});

test('sheet csv tulis: header ditulis dari columns', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const file = path.join(os.tmpdir(), 'n100n-sheet-' + Date.now() + '.csv');

  const wf = store.createWorkflow({
    name: 'sheet-write',
    nodes: [
      {
        id: 'a', type: 'sheet', next: null,
        config: { driver: 'csv', action: 'write', path: file, columns: ['n', 'k'], rows: [{ n: 1, k: 'a' }] },
      },
    ],
  });
  const run = await call(base, 'POST', `/api/workflows/${wf.id}/run`, { token: TOKEN, body: { items: [{}] } });
  assert.strictEqual(run.data.status, 'success', JSON.stringify(run.data.error || ''));
  assert.deepStrictEqual(fs.readFileSync(file, 'utf8').trim().split('\n'), ['n,k', '1,a']);
  fs.unlinkSync(file);
});

test('GET /api/stats: ringkasan dasbor', async () => {
  const wf = store.createWorkflow({
    name: 'stat-uji', active: 1,
    nodes: [{ id: 'a', type: 'code', config: { code: 'return items;' }, next: null }],
  });
  await call(base, 'POST', `/api/workflows/${wf.id}/run`, { token: TOKEN, body: { items: [{ a: 1 }] } });

  const r = await call(base, 'GET', '/api/stats?days=7', { token: TOKEN });
  assert.strictEqual(r.status, 200);
  const s = r.data;
  assert.strictEqual(s.ok, true);
  assert.ok(s.workflows.total >= 1 && s.workflows.aktif >= 1, 'hitung workflow');
  assert.ok(s.executions.total >= 1 && s.executions.hari_ini >= 1, 'hitung eksekusi 24 jam');
  assert.strictEqual(s.perDay.length, 7, 'grafik 7 hari');
  const hariIni = s.perDay[s.perDay.length - 1];
  assert.ok(hariIni.total >= 1, 'hari terakhir memuat eksekusi');
  assert.ok(s.executions.tingkat_sukses >= 0 && s.executions.tingkat_sukses <= 100);
  assert.ok(Array.isArray(s.terbaru) && s.terbaru.length >= 1 && s.terbaru[0].wf === 'stat-uji', 'nama workflow di eksekusi terbaru');
  store.deleteWorkflow(wf.id);
});

test('import dan export definisi workflow', async () => {
  const definisi = {
    name: 'impor contoh mini',
    trigger: 'manual',
    nodes: [{ id: 'a', type: 'noop', config: {}, next: null }],
  };
  const imp = await call(base, 'POST', '/api/workflows/import', { token: TOKEN, body: definisi });
  assert.strictEqual(imp.status, 201);
  assert.strictEqual(imp.data.created.length, 1);

  const exp = await call(base, 'GET', `/api/workflows/${imp.data.created[0].id}/export`, { token: TOKEN });
  assert.strictEqual(exp.status, 200);
  assert.strictEqual(exp.data.name, 'impor contoh mini');
  assert.ok(Array.isArray(exp.data.nodes));
  assert.strictEqual(exp.data.last_run, undefined, 'metadata runtime tidak ikut diexport');
});

test('validate menolak next yang menunjuk node hilang', async () => {
  const wf = store.createWorkflow({ name: 'validasi', nodes: [{ id: 'a', type: 'noop', next: 'hantu' }] });
  const r = await call(base, 'POST', `/api/workflows/${wf.id}/validate`, { token: TOKEN });
  assert.strictEqual(r.status, 422);
  assert.match(r.data.errors.join(' '), /hantu/);
});

test('toggle mengaktifkan/menonaktifkan workflow', async () => {
  const wf = store.createWorkflow({ name: 'toggle', nodes: [{ id: 'a', type: 'noop', next: null }] });
  const on = await call(base, 'POST', `/api/workflows/${wf.id}/toggle`, { token: TOKEN, body: { active: true } });
  assert.strictEqual(on.data.active, 1);
  const off = await call(base, 'POST', `/api/workflows/${wf.id}/toggle`, { token: TOKEN });
  assert.strictEqual(off.data.active, 0);
});

test('UI disajikan di /', async () => {
  const res = await fetch(base + '/');
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  assert.match(html, /n100n/);
  assert.match(html, /renderGraph/);
});

test('scheduler: interval, harian, dan mingguan (Senin 07:00 WIB)', () => {
  const sekarang = new Date();
  const interval = { trigger_cfg: { mode: 'interval', every_minutes: 5 }, last_run: new Date(Date.now() - 10 * 60000).toISOString() };
  assert.strictEqual(scheduleDue(interval, sekarang), true);
  const belum = { trigger_cfg: { mode: 'interval', every_minutes: 30 }, last_run: new Date(Date.now() - 60000).toISOString() };
  assert.strictEqual(scheduleDue(belum, sekarang), false);

  // Senin 2026-11-02 07:00 WIB == 2026-11-02T00:00:00Z
  const seninPagi = new Date('2026-11-02T00:00:30Z');
  const mingguan = { trigger_cfg: { mode: 'weekly', days: [1], at: '07:00', timezone: 'Asia/Jakarta' }, last_run: null };
  assert.strictEqual(scheduleDue(mingguan, seninPagi), true, 'Senin 07:00 WIB harus jalan');

  const seninSiang = new Date('2026-11-02T05:00:00Z'); // 12:00 WIB
  assert.strictEqual(scheduleDue(mingguan, seninSiang), false);

  const selasaPagi = new Date('2026-11-03T00:00:30Z');
  assert.strictEqual(scheduleDue(mingguan, selasaPagi), false, 'hari lain tidak boleh jalan');

  const barusan = { trigger_cfg: { mode: 'weekly', days: [1], at: '07:00', timezone: 'Asia/Jakarta' }, last_run: '2026-11-02T00:00:10.000Z' };
  assert.strictEqual(scheduleDue(barusan, seninPagi), false, 'tidak dobel dalam satu menit');
});

test('login dibatasi setelah 5 percobaan gagal (anti brute force)', async () => {
  for (let i = 0; i < 6; i++) {
    await call(base, 'POST', '/api/login', { body: { password: 'ngawur' + i } });
  }
  const r = await call(base, 'POST', '/api/login', { body: { password: 'rahasia123' } });
  assert.strictEqual(r.status, 429);
  assert.match(r.data.error, /terlalu banyak/i);
});
