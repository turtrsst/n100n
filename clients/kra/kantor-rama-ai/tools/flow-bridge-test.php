<?php
declare(strict_types=1);

/**
 * Uji cepat KraFlowBridge tanpa web server / MySQL.
 * Jalankan dari folder proyek KRA:  php tools/flow-bridge-test.php
 * Keluar dengan kode 1 bila ada pemeriksaan yang gagal (siap dipakai di CI).
 */

require_once __DIR__ . '/../api/lib/KraFlowBridge.php';

$GLOBALS['lulus'] = 0;
$GLOBALS['gagal'] = 0;

function cek(string $nama, bool $ok, string $info = ''): void
{
    if ($ok) {
        $GLOBALS['lulus']++;
        echo "  ok    {$nama}" . ($info !== '' ? "  ({$info})" : '') . PHP_EOL;
        return;
    }
    $GLOBALS['gagal']++;
    echo " GAGAL  {$nama}" . ($info !== '' ? "  ({$info})" : '') . PHP_EOL;
}

$storage = dirname(__DIR__) . DIRECTORY_SEPARATOR . '.temp' . DIRECTORY_SEPARATOR . 'flow.json';
$backup = $storage . '.test-backup';
if (is_file($storage)) {
    @rename($storage, $backup);
}

echo "KraFlowBridge — uji dasar" . PHP_EOL;

// 1. kategori
$kategori = KraFlowBridge::kategori();
cek('daftar kategori tersedia', count($kategori) >= 3, count($kategori) . ' kategori');
cek('kategori punya nama', isset($kategori[0]['nama']) && $kategori[0]['nama'] !== '', (string) ($kategori[0]['nama'] ?? ''));

// 2. validasi input
$kosong = KraFlowBridge::terimaTugas(['prompt' => '']);
cek('tolak tugas tanpa prompt', ($kosong['ok'] ?? true) === false);

// 3. mode template (default)
putenv('KRA_FLOW_MODE=template');
$tugas = KraFlowBridge::terimaTugas([
    'agen' => 'agen-1',
    'kategori' => 'Riset',
    'judul' => 'Contoh #9',
    'prompt' => 'Ringkas 3 poin dari bahan ini',
    'gaya' => 'santai',
    'meta' => ['asal' => 'uji'],
]);
cek('tugas diterima', ($tugas['ok'] ?? false) === true, (string) ($tugas['task_id'] ?? ''));
cek('task_id berawalan T', str_starts_with((string) ($tugas['task_id'] ?? ''), 'T'));
cek('mode template langsung selesai', ($tugas['status'] ?? '') === 'selesai');

$id = (string) ($tugas['task_id'] ?? '');
$tersimpan = KraFlowBridge::tugas($id);
cek('tugas tersimpan', $tersimpan !== null);
cek('hasil terisi', $tersimpan !== null && trim((string) ($tersimpan['hasil'] ?? '')) !== '');
cek('kategori tersimpan', ($tersimpan['kategori'] ?? '') === 'Riset');
cek('meta diteruskan apa adanya', ($tersimpan['meta']['asal'] ?? '') === 'uji');

// 4. daftar + filter
$semua = KraFlowBridge::daftarTugas();
$selesai = KraFlowBridge::daftarTugas('selesai');
$perAgen = KraFlowBridge::daftarTugas(null, 50, 'agen-1');
cek('daftar tugas berisi', count($semua) >= 1, count($semua) . ' tugas');
cek('filter status selesai', count($selesai) >= 1 && count($selesai) <= count($semua));
cek('filter agen', count($perAgen) >= 1);

// 5. mode manual
putenv('KRA_FLOW_MODE=manual');
$manual = KraFlowBridge::terimaTugas(['prompt' => 'Kerjakan manual', 'kategori' => 'Tulis']);
$idManual = (string) ($manual['task_id'] ?? '');
cek('mode manual tetap diproses', ($manual['status'] ?? '') === 'diproses');

$tolak = KraFlowBridge::selesaikan($idManual, '');
cek('tolak hasil kosong', ($tolak['ok'] ?? true) === false);

$selesaiManual = KraFlowBridge::selesaikan($idManual, 'Hasil dikerjakan manusia.', ['mode' => 'manual']);
cek('selesaikan manual berhasil', ($selesaiManual['ok'] ?? false) === true);
cek('status jadi selesai', ($selesaiManual['tugas']['status'] ?? '') === 'selesai');
cek('hasil tersimpan', ($selesaiManual['tugas']['hasil'] ?? '') === 'Hasil dikerjakan manusia.');

$tidakAda = KraFlowBridge::selesaikan('T999999', 'apa saja');
cek('tugas tak dikenal ditolak', ($tidakAda['ok'] ?? true) === false);

// 6. ringkasan
$ringkas = KraFlowBridge::ringkasan();
cek('ringkasan menghitung total', ($ringkas['total'] ?? 0) >= 2, (string) ($ringkas['total'] ?? 0));

// 7. otorisasi API key
putenv('KRA_FLOW_API_KEY=kunci-uji');
unset($_SERVER['HTTP_X_API_KEY']);
cek('tanpa header ditolak saat kunci diset', KraFlowBridge::authorized() === false);
cek('POST tugas ditolak tanpa kunci', (KraFlowBridge::terimaTugas(['prompt' => 'x'])['ok'] ?? true) === false);
$_SERVER['HTTP_X_API_KEY'] = 'kunci-uji';
cek('header benar diterima', KraFlowBridge::authorized() === true);
putenv('KRA_FLOW_API_KEY');
unset($_SERVER['HTTP_X_API_KEY']);

// 8. generator kustom
putenv('KRA_FLOW_MODE=template');
KraFlowBridge::setGenerator(static function (array $tugas): string {
    return 'HASIL KUSTOM untuk ' . ($tugas['judul'] ?? '?');
});
$kustom = KraFlowBridge::terimaTugas(['prompt' => 'pakai generator kustom', 'judul' => 'Kustom #1']);
$kustomTugas = KraFlowBridge::tugas((string) ($kustom['task_id'] ?? ''));
cek('generator kustom dipakai', str_starts_with((string) ($kustomTugas['hasil'] ?? ''), 'HASIL KUSTOM'));
cek('mode tercatat custom', ($kustomTugas['mode'] ?? '') === 'custom');
KraFlowBridge::setGenerator(null);

echo PHP_EOL . $GLOBALS['lulus'] . '/' . ($GLOBALS['lulus'] + $GLOBALS['gagal']) . ' pemeriksaan lolos' . PHP_EOL;

if (is_file($backup)) {
    @rename($backup, $storage);
} elseif (is_file($storage)) {
    @unlink($storage);
}

exit($GLOBALS['gagal'] > 0 ? 1 : 0);
