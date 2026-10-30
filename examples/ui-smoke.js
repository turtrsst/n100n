'use strict';
// Uji cepat UI tanpa browser sungguhan (opsional, butuh jsdom).
//   npm i --no-save jsdom && node examples/ui-smoke.js
// Memeriksa: kartu node, editor koneksi, pratinjau graf, status run, panel log.
const fs = require('node:fs');
const path = require('node:path');

let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch {
  console.log('lewati: jsdom belum terpasang (npm i --no-save jsdom)');
  process.exit(0);
}

const file = path.join(__dirname, '..', 'public', 'index.html');
const html = fs.readFileSync(file, 'utf8');
const wf = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'workflows', 'contoh-alur-polling.json'), 'utf8'));

const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost:5679/' });
const { window } = dom;
window.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
window.confirm = () => false;
window.HTMLElement.prototype.scrollIntoView = function () {};
window.eval(html.match(/<script>([\s\S]*)<\/script>/)[1]
  + '\n;window.__t = { get state(){ return state; }, renderEditor, renderGraph, applyRuns, renderLive, renderTriggerFields, tampilView, muatDasbor, gambarDasbor };');

const pokok = [];
const cek = (nama, syarat, info = '') => {
  pokok.push({ nama, ok: Boolean(syarat), info });
  console.log((syarat ? '  ok  ' : ' GAGAL') + '  ' + nama + (info ? '  (' + info + ')' : ''));
};

setTimeout(async () => {
  const doc = window.document;
  window.__t.state.wf = Object.assign({ id: 1 }, wf);
  window.__t.renderEditor();

  const cards = [...doc.querySelectorAll('.card')];
  cek('semua node tampil sebagai kartu', cards.length === wf.nodes.length, cards.length + ' kartu');

  const ifElse = cards.find((c) => c.querySelector('select[data-f=type]').value === 'ifElse');
  const rows = [...ifElse.querySelectorAll('.conn-row')].map((r) => r.querySelector('input.out').value + '→' + r.querySelector('select').value);
  cek('editor koneksi ifElse terbaca', rows.join(',') === 'true→n8,false→n9', rows.join(', '));

  const sel = ifElse.querySelector('.conn-row select');
  sel.value = 'n12';
  sel.dispatchEvent(new window.Event('change'));
  cek('ubah target cabang tersimpan', window.__t.state.wf.nodes.find((n) => n.id === 'n7').next.true === 'n12');

  ifElse.querySelector('[data-a=auto]').click();
  cek('tombol Otomatis menghapus next', window.__t.state.wf.nodes.find((n) => n.id === 'n7').next === undefined);
  ifElse.querySelector('[data-a=manual]').click();
  cek('tombol Atur manual membuat koneksi', !!window.__t.state.wf.nodes.find((n) => n.id === 'n7').next);

  window.__t.applyRuns([
    { id: 'n1', visit: 1, ms: 0 }, { id: 'n9', visit: 2, ms: 9 }, { id: 'n13', visit: 1, ms: 1, error: 'boom' },
  ]);
  const svg = doc.getElementById('graph').innerHTML;
  cek('graf punya kotak node', (svg.match(/class="gnode/g) || []).length === wf.nodes.length);
  cek('edge loop ditandai', /edge back/.test(svg) && svg.includes('ulang'));
  cek('status error/sukses terwarnai', /gnode err/.test(svg) && /gnode multi/.test(svg));
  cek('badge putaran tampil', svg.includes('×2'));

  window.__t.renderLive({ id: 7, status: 'running', log: 'n1: ok' });
  cek('panel log live tampil', !doc.getElementById('live').classList.contains('hidden'));

  doc.getElementById('wfTrigger').value = 'schedule';
  window.__t.renderTriggerFields();
  doc.getElementById('cbMode').value = 'weekly';
  doc.getElementById('cbMode').dispatchEvent(new window.Event('change'));
  const senin = [...doc.querySelectorAll('[data-day]')].find((c) => c.dataset.day === '1');
  cek('form trigger mingguan menandai Senin', senin && senin.checked);
  cek('form trigger punya input jam', !!doc.getElementById('cbAt'));

  cek('layar login aktif saat belum auth', !doc.getElementById('login').classList.contains('hidden'));

  // ---------- dasbor ----------
  const hari = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const stub = {
    '/api/stats': {
      ok: true,
      workflows: { total: 2, aktif: 1 },
      executions: { total: 12, sukses: 10, gagal: 2, hari_ini: 5, sukses_24j: 4, gagal_24j: 1, berjalan: 0, tingkat_sukses: 80, rata_ms: 1234 },
      perDay: [0, 1, 2, 3, 4, 5, 6].map((n) => ({ tanggal: hari(6 - n), total: n, sukses: n, gagal: 0 })),
      terbaru: [
        { id: 9, workflow_id: 1, status: 'success', trigger: 'api', started: new Date().toISOString(), finished: new Date().toISOString(), ms: 900, wf: 'Alur A' },
        { id: 8, workflow_id: 2, status: 'error', trigger: 'webhook', started: new Date().toISOString(), finished: new Date().toISOString(), ms: 12, wf: 'Hook', error: 'x' },
      ],
    },
    '/api/workflows': [
      { id: 1, name: 'Alur A', trigger: 'manual', active: 1, last_run: new Date().toISOString() },
      { id: 2, name: 'Hook', trigger: 'webhook', active: 0, last_run: null },
    ],
  };
  const fetchAsli = window.fetch;
  window.fetch = async (url) => ({ ok: true, status: 200, json: async () => stub[String(url)] || {} });

  window.__t.tampilView('dash');
  await new Promise((r) => setTimeout(r, 50)); // tampilView memuat dasbor secara async

  const kartu = [...doc.querySelectorAll('#dashStats .stat')];
  cek('dasbor: 4 kartu ringkasan', kartu.length === 4, kartu.map((k) => k.textContent.trim().split('\n')[0]).join(' | '));
  cek('dasbor: kartu memuat angka nyata', /80%/.test(doc.getElementById('dashStats').textContent) && /1[.,]2 s/.test(doc.getElementById('dashStats').textContent));
  cek('dasbor: grafik 7 hari tampil', doc.querySelectorAll('#dashChart .col').length === 7, doc.querySelectorAll('#dashChart .bar').length + ' bar');
  cek('dasbor: tabel workflow berisi 2 baris', doc.querySelectorAll('#dashWf tr').length === 2);
  cek('dasbor: status nonaktif ditandai', /nonaktif/.test(doc.getElementById('dashWf').textContent));
  cek('dasbor: eksekusi terakhir + status', doc.querySelectorAll('#dashExec tr').length === 2 && /pill error/.test(doc.getElementById('dashExec').innerHTML));
  cek('dasbor: view editor disembunyikan', doc.getElementById('viewEditor').classList.contains('hidden') && !doc.getElementById('viewDash').classList.contains('hidden'));

  window.__t.tampilView('editor');
  cek('tab editor: dasbor disembunyikan', doc.getElementById('viewDash').classList.contains('hidden') && !doc.getElementById('viewEditor').classList.contains('hidden'));
  cek('tab aktif mengikuti view', doc.getElementById('tabEditor').classList.contains('active') && !doc.getElementById('tabDash').classList.contains('active'));

  window.__t.tampilView('dash');
  window.fetch = fetchAsli;

  const gagal = pokok.filter((p) => !p.ok).length;
  console.log(`\n${pokok.length - gagal}/${pokok.length} pemeriksaan lolos`);
  process.exit(gagal ? 1 : 0);
}, 60);
