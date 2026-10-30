'use strict';
// smoke: jalankan contoh alur end-to-end melawan mock KRA (wait dipersingkat)
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'n100n-smoke-'));
process.env.APP_DATA_DIR = path.join(tmp, 'data');
process.env.APP_PASSWORD = 'rahasia123';
process.env.APP_API_TOKEN = 'tok-test';
process.env.APP_SEED = '0';
process.env.MOCK_TUGAS_FAIL = '2';
process.env.MOCK_TUGAS_MS = '300';

const sumberCsv = path.join(tmp, 'sumber.csv');
fs.writeFileSync(sumberCsv, 'catatan,dibuat\nCatatan #1,2026-10-01\nCatatan #2,2026-10-08\n');
process.env.CONTOH_SHEET_DRIVER = 'csv';
process.env.CONTOH_SUMBER_CSV = sumberCsv;
process.env.CONTOH_HASIL_CSV = path.join(tmp, 'hasil.csv');

const { server: kra } = require('../examples/mock-kra.js');
const n100n = require('../server.js');

(async () => {
  await new Promise((r) => kra.listen(0, '127.0.0.1', r));
  const kraPort = kra.address().port;
  process.env.KRA_BASE_URL = 'http://127.0.0.1:' + kraPort;
  process.env.KRA_API_KEY = 'dev-kra-key';

  await new Promise((r) => n100n.server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + n100n.server.address().port;
  const headers = { 'x-api-key': 'tok-test', 'Content-Type': 'application/json' };

  const tpl = JSON.parse(fs.readFileSync(path.join(__dirname, '../workflows/contoh-alur-polling.json'), 'utf8'));
  for (const node of tpl.nodes) {
    if (node.type === 'wait') node.config.ms = 150;
  }
  const wf = await (await fetch(base + '/api/workflows', { method: 'POST', headers, body: JSON.stringify(tpl) })).json();
  console.log('workflow dibuat:', wf.id, wf.name);

  const t0 = Date.now();
  const res = await (await fetch(`${base}/api/workflows/${wf.id}/run`, { method: 'POST', headers, body: JSON.stringify({ items: [{ schedule: new Date().toISOString() }] }) })).json();
  console.log('status:', res.status, 'durasi:', Date.now() - t0, 'ms', res.error ? 'error: ' + res.error : '');
  console.log('--- log node ---');
  (res.log || []).forEach((l) => console.log(' ', l));
  console.log('--- output ---');
  console.log(JSON.stringify(res.items, null, 2));
  console.log('--- hasil.csv ---');
  try { console.log(fs.readFileSync(process.env.CONTOH_HASIL_CSV, 'utf8')); } catch (e) { console.log('(kosong)', e.code); }

  n100n.server.close();
  kra.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
