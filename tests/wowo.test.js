'use strict';
// Uji end-to-end Workflow WOWO melawan mock KRA: loop kirim tugas, loop cek hasil, simpan ide.
const { setupEnv, startServer } = require('./helpers');
const tmp = setupEnv();

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

process.env.MOCK_TUGAS_FAIL = '2';  // dua POST pertama gagal (uji retry + loop tunggu)
process.env.MOCK_TUGAS_MS = '150';  // Wowo "selesai" setelah 150ms

const { server: kra } = require('../examples/mock-kra');
const { server, store } = require('../server');

let base = '';
const TOKEN = 'tok-test';

function muatWowo() {
  const wf = JSON.parse(fs.readFileSync(path.join(__dirname, '../workflows/wowo.json'), 'utf8'));
  for (const node of wf.nodes) {
    if (node.type === 'wait') node.config.ms = 100; // percepat untuk test
    if (node.id === 'n8') node.config.condition = '!$json.task_id && $vars.coba < 3';
  }
  return wf;
}

test.before(async () => {
  base = await startServer(server);
  const kraBase = await startServer(kra);
  process.env.KRA_BASE_URL = kraBase;
  process.env.KRA_API_KEY = 'dev-kra-key';
  fs.writeFileSync(process.env.WOWO_TOPIC_CSV, 'topik,pilar,dibuat\nEdukasi #1,Edukasi,2026-10-01\nEdukasi #2,Edukasi,2026-10-08\n');
});

test.after(() => {
  server.closeAllConnections(); server.close();
  kra.closeAllConnections(); kra.close();
});

test('Workflow WOWO: retry kirim tugas, poll hasil, simpan ide', async () => {
  const res = await fetch(base + '/api/workflows/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': TOKEN },
    body: JSON.stringify(muatWowo()),
  });
  const imp = await res.json();
  assert.strictEqual(res.status, 201);
  const wfId = imp.created[0].id;

  // validasi alur sebelum dijalankan
  const val = await fetch(`${base}/api/workflows/${wfId}/validate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': TOKEN },
  });
  assert.strictEqual(val.status, 200, JSON.stringify(await val.json()));

  const runRes = await fetch(`${base}/api/workflows/${wfId}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': TOKEN },
    body: JSON.stringify({ items: [{ schedule: new Date().toISOString() }] }),
  });
  const run = await runRes.json();
  assert.strictEqual(run.status, 'success', 'workflow harus sukses: ' + (run.error || ''));

  // 1) retry di dalam node http (2 attempt per run) + loop "Tugas Terkirim?" sekali
  const kirim = run.log.filter((l) => l.startsWith('Beri Tugas ke Wowo: main='));
  assert.strictEqual(kirim.length, 2, 'Beri Tugas dijalankan 2x: run-1 gagal (2 attempt), run-2 sukses');
  assert.ok(
    run.log.some((l) => /Beri Tugas ke Wowo: HTTP 503 — ulangi 1\/1/.test(l)),
    'retry internal node http harus terlihat di log'
  );

  // 2) loop "Cek Daftar Tugas" berputar sampai Wowo selesai
  const cek = run.log.filter((l) => l.startsWith('Cek Daftar Tugas: main='));
  assert.ok(cek.length >= 2, 'harus polling lebih dari sekali, dapat ' + cek.length);

  // 3) ide tersimpan ke sheet (CSV) dengan kolom yang benar
  const csv = fs.readFileSync(process.env.WOWO_IDE_CSV, 'utf8').trim().split('\n');
  assert.strictEqual(csv[0], 'dibuat,task_id,pilar,judul,ide');
  assert.strictEqual(csv.length, 2, 'tepat satu ide disimpan');
  const baris = csv[1];
  assert.match(baris, /,T\d+,Studi Kasus,Studi Kasus #1,/);
  assert.match(baris, /mulai dari masalah/);

  // 4) detail eksekusi tersimpan untuk audit
  const detail = await (await fetch(`${base}/api/executions/${run.execution_id}`, { headers: { 'x-api-key': TOKEN } })).json();
  assert.strictEqual(detail.status, 'success');
  assert.ok(Array.isArray(detail.runs) && detail.runs.length > 5);
  const node6 = detail.runs.filter((r) => r.id === 'n6');
  assert.strictEqual(node6.length, 2, 'n6 dua kali: gagal lalu sukses');
  assert.strictEqual(node6[1].out.main, 1);
  const node13 = detail.runs.filter((r) => r.id === 'n13');
  assert.ok(node13.length >= 1, 'node tunggu 1 menit dijalankan saat menunggu');
});

test('Workflow WOWO: gagal rapi kalau KRA tidak bisa dihubungi', async () => {
  process.env.KRA_BASE_URL = 'http://127.0.0.1:1';
  const wf = muatWowo();
  wf.name = 'WOWO tanpa KRA';
  for (const node of wf.nodes) if (node.id === 'n3') node.config.retry = 0;

  const imp = await (await fetch(base + '/api/workflows/import', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': TOKEN }, body: JSON.stringify(wf),
  })).json();
  const wfId = imp.created[0].id;

  const run = await (await fetch(`${base}/api/workflows/${wfId}/run`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': TOKEN },
    body: JSON.stringify({ items: [{}] }),
  })).json();

  assert.strictEqual(run.status, 'error');
  assert.match(run.error, /fetch|ECONN|connect/i);
  const detail = store.getExecution(run.execution_id);
  assert.strictEqual(detail.status, 'error');
  assert.ok(detail.runs.some((r) => r.error), 'node yang gagal tercatat di runs');
  process.env.KRA_BASE_URL = 'http://127.0.0.1:' + kra.address().port;
});
