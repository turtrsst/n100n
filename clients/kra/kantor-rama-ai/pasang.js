#!/usr/bin/env node
'use strict';
/**
 * Pemasang integrasi n100n ↔ kantor-rama-ai (KRA).
 *
 *   node pasang.js "C:\xampp\htdocs\kantor-rama-ai"
 *   node pasang.js /path/ke/kra --check     # hanya periksa, tidak menulis
 *   node pasang.js /path/ke/kra --patch     # tulis juga patches/*.patch hasil edit
 *
 * Kenapa bukan `git apply` saja? Patch konteks mudah patah kalau api/index.php
 * berubah (mis. branch lain menambah require/action). Skrip ini mencari titik
 * sisipnya sendiri, jadi jalan di main maupun branch fitur, dan aman dijalankan
 * berulang (idempoten).
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PKG = __dirname;
const AKSI_BARU = [
  'flow-kategori', 'flow-tugas', 'flow-selesai', 'flow-status',
  'n100n-status', 'n100n-workflows', 'n100n-run', 'n100n-execution',
];
const BERKAS = [
  ['api/lib/KraN100nClient.php', 'api/lib/KraN100nClient.php'],
  ['api/lib/KraFlowBridge.php', 'api/lib/KraFlowBridge.php'],
  ['tools/flow-bridge-test.php', 'tools/flow-bridge-test.php'],
  ['docs/n100n-integration.md', 'docs/n100n-integration.md'],
];

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('-'));
const modeCheck = args.includes('--check');
const modePatch = args.includes('--patch');

if (!target) {
  console.log('pakai: node pasang.js <folder-proyek-KRA> [--check] [--patch]');
  process.exit(2);
}

const KRA = path.resolve(target);
const indexPath = path.join(KRA, 'api', 'index.php');
const hasil = [];
const ok = (m) => { hasil.push(['ok', m]); console.log('  ok    ' + m); };
const ubah = (m) => { hasil.push(['ubah', m]); console.log('  ubah  ' + m); };
const lewat = (m) => { hasil.push(['lewat', m]); console.log('  lewat ' + m); };
const gagal = (m) => { hasil.push(['GAGAL', m]); console.log('  GAGAL ' + m); };

function hash(s) { return crypto.createHash('sha1').update(s).digest('hex').slice(0, 12); }

console.log('n100n → KRA  ·  target: ' + KRA + (modeCheck ? '  (mode periksa)' : ''));
console.log('');

// ---------- 0. validasi target ----------
if (!fs.existsSync(indexPath)) {
  gagal('api/index.php tidak ditemukan — apakah folder ini benar proyek KRA?');
  process.exit(1);
}
const indexAsli = fs.readFileSync(indexPath, 'utf8');
if (!/function\s+respond\s*\(/.test(indexAsli)) {
  gagal('api/index.php tidak punya function respond() — versi KRA ini belum didukung.');
  process.exit(1);
}
ok('api/index.php dikenali (' + indexAsli.split('\n').length + ' baris)');

// ---------- 1. copy berkas ----------
for (const [src, dst] of BERKAS) {
  const from = path.join(PKG, src);
  const to = path.join(KRA, dst);
  if (!fs.existsSync(from)) { gagal('berkas paket hilang: ' + src); continue; }
  const isi = fs.readFileSync(from, 'utf8');
  const lama = fs.existsSync(to) ? fs.readFileSync(to, 'utf8') : null;
  if (lama === isi) { lewat(dst + ' (sudah sama)'); continue; }
  if (modeCheck) { ubah(dst + (lama ? ' (akan ditimpa)' : ' (akan dibuat)')); continue; }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (lama !== null) fs.writeFileSync(to + '.bak-n100n', lama);
  fs.writeFileSync(to, isi);
  ubah(dst + (lama ? ' (ditimpa, backup .bak-n100n)' : ' (dibuat)'));
}

// ---------- 2. require_once ----------
let index = indexAsli;
const butuhRequire = ["KraN100nClient.php", "KraFlowBridge.php"];
const kurang = butuhRequire.filter((f) => !index.includes("require_once __DIR__ . '/lib/" + f + "'"));

if (!kurang.length) {
  lewat('require_once KraN100nClient + KraFlowBridge sudah ada');
} else {
  const re = /^require_once __DIR__ \. '\/lib\/[A-Za-z0-9_]+\.php';\s*$/gm;
  const cocok = [...index.matchAll(re)];
  if (!cocok.length) {
    gagal('tidak menemukan baris require_once lib/*.php untuk titik sisip');
  } else {
    const terakhir = cocok[cocok.length - 1];
    const posisi = terakhir.index + terakhir[0].length;
    const sisip = '\n' + kurang.map((f) => `require_once __DIR__ . '/lib/${f}';`).join('\n');
    index = index.slice(0, posisi) + sisip + index.slice(posisi);
    ubah('require_once ditambahkan setelah ' + path.basename(terakhir[0].match(/'([^']+)'/)[1]));
  }
}

// ---------- 3. blok action ----------
const SNIP = path.join(PKG, 'snippets', 'aksi-n100n.php');
if (!fs.existsSync(SNIP)) {
  gagal('snippets/aksi-n100n.php tidak ada di paket');
} else if (index.includes("if ($action === 'flow-tugas')")) {
  lewat('blok action flow-* sudah terpasang');
} else {
  const penanda = index.match(/^[ \t]*\$available\s*=/m);
  if (!penanda) {
    gagal("tidak menemukan variabel $available sebagai titik sisip blok action");
  } else {
    const blok = fs.readFileSync(SNIP, 'utf8').replace(/\s*$/, '\n') + '\n';
    index = index.slice(0, penanda.index) + blok + index.slice(penanda.index);
    ubah('8 action baru disisipkan sebelum $available');
  }
}

// ---------- 4. daftar action di pesan 404 ----------
if (AKSI_BARU.every((a) => index.includes(a))) {
  const stmt = index.match(/\$available\s*=\s*([\s\S]*?);\n/);
  if (stmt) {
    const literal = stmt[1].match(/'(?:[^'\\]|\\.)*'/g) || [];
    const isi = literal.map((l) => l.slice(1, -1)).join('').replace(/\.\s*$/, '');
    const baru = AKSI_BARU.filter((a) => !new RegExp('(^|,\\s*)' + a + '(\\s*,|$)').test(isi));
    if (baru.length) {
      const gabung = isi.replace(/\s*$/, '') + (isi.trim().endsWith(',') ? ' ' : ', ') + baru.join(', ') + '.';
      // pecah agar tidak jadi satu baris sangat panjang
      const potong = [];
      let sisa = gabung;
      while (sisa.length > 92) {
        let i = sisa.lastIndexOf(', ', 92);
        if (i < 40) i = 92;
        potong.push(sisa.slice(0, i + 1));
        sisa = sisa.slice(i + 1).replace(/^\s+/, '');
      }
      potong.push(sisa);
      const baru_stmt = '$available = ' + potong
        .map((p, i) => (i === 0 ? `'${p.replace(/'/g, "\\'")}'` : `        . '${p.replace(/'/g, "\\'")}'`))
        .join('\n') + ';\n';
      index = index.slice(0, stmt.index) + baru_stmt + index.slice(stmt.index + stmt[0].length);
      ubah('daftar action di pesan 404 ditambah: ' + baru.join(', '));
    } else {
      lewat('daftar action di pesan 404 sudah memuat semuanya');
    }
  }
}

// ---------- 5. tulis + verifikasi hasil ----------
if (index !== indexAsli) {
  if (modeCheck) {
    console.log('\n(mode periksa: api/index.php akan berubah ' + indexAsli.split('\n').length + ' → ' + index.split('\n').length + ' baris)');
  } else {
    if (!fs.existsSync(indexPath + '.bak-n100n')) fs.writeFileSync(indexPath + '.bak-n100n', indexAsli);
    fs.writeFileSync(indexPath, index);
    ubah('api/index.php ditulis (backup: api/index.php.bak-n100n)');
  }
} else {
  lewat('api/index.php tidak perlu diubah');
}

const final = modeCheck ? index : (fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf8') : index);
const cek = [
  ["require_once KraN100nClient", final.includes("KraN100nClient.php")],
  ["require_once KraFlowBridge", final.includes("KraFlowBridge.php")],
  ["action flow-tugas", final.includes("if ($action === 'flow-tugas')")],
  ["action flow-selesai", final.includes("if ($action === 'flow-selesai')")],
  ["action n100n-run", final.includes("if ($action === 'n100n-run')")],
  ["$available diperbarui", /n100n-execution/.test((final.match(/\$available\s*=\s*([\s\S]*?);\n/) || ['', ''])[1])],
  ['blok action berada sebelum $available', final.indexOf("if ($action === 'flow-tugas')") < final.indexOf('$available =')],
  ['kurung kurawal seimbang (kasar)', (final.split('{').length - 1) === (final.split('}').length - 1)],
];
for (const [nama, lulus] of cek) (lulus ? ok : gagal)('verifikasi: ' + nama);

if (modePatch && !modeCheck && index !== indexAsli) {
  const dir = path.join(PKG, 'patches');
  fs.mkdirSync(dir, { recursive: true });
  const nama = path.join(dir, 'index-php-' + hash(index) + '.patch');
  const diff = ['--- a/api/index.php', '+++ b/api/index.php', '@@ baris hasil pemasangan @@', index].join('\n');
  fs.writeFileSync(nama, diff);
  ubah('potongan hasil edit ditulis: ' + path.relative(PKG, nama));
}

const jumlahGagal = hasil.filter((h) => h[0] === 'GAGAL').length;
console.log('');
console.log(jumlahGagal ? `${jumlahGagal} masalah — periksa pesan GAGAL di atas.` : 'Selesai tanpa masalah.');
if (!jumlahGagal && !modeCheck) {
  console.log('');
  console.log('Langkah berikutnya:');
  console.log('  1. isi env KRA:  KRA_N100N_URL, KRA_N100N_TOKEN, KRA_FLOW_API_KEY, KRA_FLOW_MODE');
  console.log('  2. uji:          php tools/flow-bridge-test.php');
  console.log('  3. uji endpoint: curl -H "x-api-key: KUNCI" "http://127.0.0.1:8080/api/index.php?action=flow-status"');
  console.log('  4. lihat git diff, lalu commit.');
}
process.exit(jumlahGagal ? 1 : 0);
