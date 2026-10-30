'use strict';
// Uji pemasang integrasi KRA (clients/kra/kantor-rama-ai/pasang.js) memakai
// api/index.php tiruan — bentuknya mengikuti KRA asli (respond(), require lib/*,
// $available di dalam try) tetapi tanpa menjalankan PHP.
const { setupEnv } = require('./helpers');
setupEnv();

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PAKET = path.join(__dirname, '..', 'clients', 'kra', 'kantor-rama-ai');
const SKRIP = path.join(PAKET, 'pasang.js');

const CONTOH_INDEX = `<?php
declare(strict_types=1);

require_once __DIR__ . '/lib/KraAuth.php';
require_once __DIR__ . '/lib/KraWorkflowEngine.php';
require_once __DIR__ . '/ProviderConfig.php';

function respond(array $data, int $status = 200): never
{
    http_response_code($status);
    echo json_encode($data);
    exit;
}

$action = (string) ($_GET['action'] ?? 'status');

try {
    if ($action === 'status') {
        respond(['ok' => true]);
    }

    $available = 'status, agents, save-agent, '
        . 'skills, providers, audit, templates.';
    respond(['ok' => false, 'error' => 'Unknown action: ' . $action . '. Available: ' . $available], 404);
} catch (Throwable $e) {
    respond(['ok' => false, 'error' => $e->getMessage()], 500);
}
`;

function buatKra() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kra-pasang-'));
  fs.mkdirSync(path.join(dir, 'api', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'api', 'index.php'), CONTOH_INDEX);
  return dir;
}

const jalankan = (dir, ...arg) => execFileSync(process.execPath, [SKRIP, dir, ...arg], { encoding: 'utf8' });

test('pasang.js: menyalin berkas dan menyisipkan integrasi', () => {
  const kra = buatKra();
  const out = jalankan(kra);
  assert.match(out, /8 action baru disisipkan/);

  for (const f of ['api/lib/KraN100nClient.php', 'api/lib/KraFlowBridge.php', 'tools/flow-bridge-test.php', 'docs/n100n-integration.md']) {
    assert.ok(fs.existsSync(path.join(kra, f)), f + ' harus tersalin');
  }

  const index = fs.readFileSync(path.join(kra, 'api', 'index.php'), 'utf8');
  assert.ok(index.includes("require_once __DIR__ . '/lib/KraN100nClient.php';"));
  assert.ok(index.includes("require_once __DIR__ . '/lib/KraFlowBridge.php';"));
  assert.ok(index.includes("if ($action === 'flow-tugas')"));
  assert.ok(index.includes("if ($action === 'n100n-run')"));

  // require berada setelah require lib/* terakhir, action sebelum $available
  const iRequire = index.indexOf("KraFlowBridge.php");
  assert.ok(index.indexOf("KraWorkflowEngine.php") < iRequire && iRequire < index.indexOf("ProviderConfig.php"));
  assert.ok(index.indexOf("if ($action === 'flow-tugas')") < index.indexOf('$available ='));

  const stmt = index.match(/\$available\s*=\s*([\s\S]*?);\n/)[1];
  for (const a of ['flow-tugas', 'n100n-execution']) assert.ok(stmt.includes(a), a + ' ada di $available');
  assert.ok(stmt.trim().endsWith(".'"), 'daftar action tetap diakhiri titik');

  // backup dibuat, dan pencocokan kurung kurawal tetap wajar
  assert.ok(fs.existsSync(path.join(kra, 'api', 'index.php.bak-n100n')));
  assert.strictEqual((index.match(/{/g) || []).length, (index.match(/}/g) || []).length);

  fs.rmSync(kra, { recursive: true, force: true });
});

test('pasang.js: idempoten (dijalankan dua kali tidak mengubah apa pun)', () => {
  const kra = buatKra();
  jalankan(kra);
  const pertama = fs.readFileSync(path.join(kra, 'api', 'index.php'), 'utf8');

  const out = jalankan(kra);
  const kedua = fs.readFileSync(path.join(kra, 'api', 'index.php'), 'utf8');
  assert.strictEqual(kedua, pertama, 'isi file harus sama persis');
  assert.match(out, /sudah terpasang/);
  assert.match(out, /tidak perlu diubah/);
  assert.strictEqual((kedua.match(/if \(\$action === 'flow-tugas'\)/g) || []).length, 1, 'tidak boleh dobel');

  fs.rmSync(kra, { recursive: true, force: true });
});

test('pasang.js: --check tidak menulis apa pun', () => {
  const kra = buatKra();
  const out = jalankan(kra, '--check');
  assert.match(out, /mode periksa/);
  assert.strictEqual(fs.readFileSync(path.join(kra, 'api', 'index.php'), 'utf8'), CONTOH_INDEX);
  assert.ok(!fs.existsSync(path.join(kra, 'api', 'lib', 'KraFlowBridge.php')));
  fs.rmSync(kra, { recursive: true, force: true });
});

test('pasang.js: menolak folder yang bukan proyek KRA', () => {
  const kosong = fs.mkdtempSync(path.join(os.tmpdir(), 'bukan-kra-'));
  let gagal = false;
  try { jalankan(kosong); } catch (e) { gagal = true; assert.match(String(e.stdout || e.message), /tidak ditemukan/); }
  assert.strictEqual(gagal, true, 'harus keluar dengan kode 1');
  fs.rmSync(kosong, { recursive: true, force: true });
});
