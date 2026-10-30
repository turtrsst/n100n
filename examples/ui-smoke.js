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
const wf = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'workflows', 'wowo.json'), 'utf8'));

const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost:5679/' });
const { window } = dom;
window.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
window.confirm = () => false;
window.HTMLElement.prototype.scrollIntoView = function () {};
window.eval(html.match(/<script>([\s\S]*)<\/script>/)[1]
  + '\n;window.__t = { get state(){ return state; }, renderEditor, renderGraph, applyRuns, renderLive, renderTriggerFields };');

const pokok = [];
const cek = (nama, syarat, info = '') => {
  pokok.push({ nama, ok: Boolean(syarat), info });
  console.log((syarat ? '  ok  ' : ' GAGAL') + '  ' + nama + (info ? '  (' + info + ')' : ''));
};

setTimeout(() => {
  const doc = window.document;
  window.__t.state.wf = Object.assign({ id: 1 }, wf);
  window.__t.renderEditor();

  const cards = [...doc.querySelectorAll('.card')];
  cek('semua node tampil sebagai kartu', cards.length === wf.nodes.length, cards.length + ' kartu');

  const ifElse = cards.find((c) => c.querySelector('select[data-f=type]').value === 'ifElse');
  const rows = [...ifElse.querySelectorAll('.conn-row')].map((r) => r.querySelector('input.out').value + '→' + r.querySelector('select').value);
  cek('editor koneksi ifElse terbaca', rows.join(',') === 'true→n9,false→n10', rows.join(', '));

  const sel = ifElse.querySelector('.conn-row select');
  sel.value = 'n14';
  sel.dispatchEvent(new window.Event('change'));
  cek('ubah target cabang tersimpan', window.__t.state.wf.nodes.find((n) => n.id === 'n8').next.true === 'n14');

  ifElse.querySelector('[data-a=auto]').click();
  cek('tombol Otomatis menghapus next', window.__t.state.wf.nodes.find((n) => n.id === 'n8').next === undefined);
  ifElse.querySelector('[data-a=manual]').click();
  cek('tombol Atur manual membuat koneksi', !!window.__t.state.wf.nodes.find((n) => n.id === 'n8').next);

  window.__t.applyRuns([
    { id: 'n1', visit: 1, ms: 0 }, { id: 'n10', visit: 2, ms: 9 }, { id: 'n14', visit: 1, ms: 1, error: 'boom' },
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
  const senin = [...doc.querySelectorAll('[data-day]')].find((c) => c.dataset.day === '1');
  cek('form trigger mingguan menandai Senin', senin && senin.checked);

  cek('layar login aktif saat belum auth', !doc.getElementById('login').classList.contains('hidden'));

  const gagal = pokok.filter((p) => !p.ok).length;
  console.log(`\n${pokok.length - gagal}/${pokok.length} pemeriksaan lolos`);
  process.exit(gagal ? 1 : 0);
}, 60);
