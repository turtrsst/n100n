'use strict';
// Uji end-to-end contoh alur (kirim tugas -> loop tunggu -> poll hasil -> simpan)
// melawan mock KRA. Ini contoh pola, bukan alur produksi tertentu.
const { setupEnv, startServer } = require('./helpers');
setupEnv();

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

process.env.MOCK_TUGAS_FAIL = '2';  // dua POST pertama gagal (uji retry + loop tunggu)
process.env.MOCK_TUGAS_MS = '150';  // agen "selesai" setelah 150ms

const { server: kra } = require('../examples/mock-kra');
const { server, store } = require('../server');

let base = '';
const TOKEN = 'tok-test';

function muatContoh() {
  const wf = JSON.parse(fs.readFileSync(path.join(__dirname, '../workflows/contoh-alur-polling.json'), 'utf8'));
  for (const node of wf.nodes) if (node.type === 'wait') node.config.ms = 100; // percepat untuk test
  return wf;
}

test.before(async () => {
  base = await startServer(server);
  const kraBase = await startServer(kra);
  process.env.KRA_BASE_URL = kraBase;
  process.env.KRA_API_KEY = 'dev-kra-key';
  fs.writeFileSync(process.env.CONTOH_SUMBER_CSV, 'catatan,dibuat\nCatatan #1,2026-10-01\nCatatan #2,2026-10-08\n');
});

test.after(() => {
  server.closeAllConnections(); server.close();
  kra.closeAllConnections(); kra.close();
});

test('contoh alur: retry kirim tugas, poll hasil, simpan ke sheet', async () => {
  const res = await fetch(base + '/api/workflows/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': TOKEN },
    body: JSON.stringify(muatContoh()),
  });
  const imp = await res.json();
  assert.strictEqual(res.status, 201);
  const wfId = imp.created[0].id;

  const val = await fetch(`${base}/api/workflows/${wfId}/validate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': TOKEN },
  });
  assert.strictEqual(val.status, 200, JSON.stringify(await val.json()));

  const run = await (await fetch(`${base}/api/workflows/${wfId}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': TOKEN },
    body: JSON.stringify({ items: [{}] }),
  })).json();
  assert.strictEqual(run.status, 'success', 'alur harus sukses: ' + (run.error || ''));

  // 1) retry internal node http + sekali loop "Terkirim?"
  const kirim = run.log.filter((l) => l.startsWith('Kirim Tugas: main='));
  assert.strictEqual(kirim.length, 2, 'Kirim Tugas 2x: run-1 gagal (2 attempt), run-2 sukses');
  assert.ok(run.log.some((l) => /Kirim Tugas: HTTP 503 — ulangi 1\/1/.test(l)), 'retry harus terlihat di log');

  // 2) loop "Cek Hasil" berputar sampai ada hasil
  const cek = run.log.filter((l) => l.startsWith('Cek Hasil: main='));
  assert.ok(cek.length >= 2, 'harus polling lebih dari sekali, dapat ' + cek.length);

  // 3) hasil tersimpan dengan kolom yang benar
  const csv = fs.readFileSync(process.env.CONTOH_HASIL_CSV, 'utf8').trim().split('\n');
  assert.strictEqual(csv[0], 'dibuat,task_id,agen,judul,hasil');
  assert.strictEqual(csv.length, 2, 'tepat satu hasil disimpan');
  assert.match(csv[1], /,T\d+,agen-1,Tugas #3,/);
  assert.match(csv[1], /ringkasan singkat/);

  // 4) detail eksekusi untuk audit
  const detail = await (await fetch(`${base}/api/executions/${run.execution_id}`, { headers: { 'x-api-key': TOKEN } })).json();
  assert.strictEqual(detail.status, 'success');
  assert.ok(Array.isArray(detail.runs) && detail.runs.length > 5);
  const node5 = detail.runs.filter((r) => r.id === 'n5');
  assert.strictEqual(node5.length, 2, 'n5 dua kali: gagal lalu sukses');
  assert.strictEqual(node5[1].out.main, 1);
  const node12 = detail.runs.filter((r) => r.id === 'n12');
  assert.ok(node12.length >= 1, 'node tunggu 1 menit dijalankan saat menunggu');
});

test('contoh alur: gagal rapi kalau API tujuan tidak bisa dihubungi', async () => {
  process.env.KRA_BASE_URL = 'http://127.0.0.1:1';
  const wf = muatContoh();
  wf.name = 'Contoh tanpa API';
  for (const node of wf.nodes) if (node.id === 'n5') node.config.retry = 0;

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

test('contoh webhook: balas respond dengan data masuk', async () => {
  const wf = JSON.parse(fs.readFileSync(path.join(__dirname, '../workflows/contoh-webhook.json'), 'utf8'));
  wf.active = true;
  const imp = await (await fetch(base + '/api/workflows/import', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': TOKEN }, body: JSON.stringify(wf),
  })).json();
  assert.strictEqual(imp.created.length, 1);

  const res = await fetch(base + '/webhook/contoh?wait=1', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nama: 'Rama', divisi: 'ops' }),
  });
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.ok, true);
  assert.strictEqual(data.jumlah_field, 2);
  assert.deepStrictEqual(data.data, { nama: 'Rama', divisi: 'ops' });
});
