<?php
declare(strict_types=1);

/**
 * Uji cepat KraWowoBridge tanpa web server / MySQL.
 * Jalankan dari folder proyek KRA:  php tools/wowo-bridge-test.php
 * Keluar dengan kode 1 bila ada pemeriksaan yang gagal (siap dipakai di CI).
 */

require_once __DIR__ . '/../api/lib/KraWowoBridge.php';

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

$storage = dirname(__DIR__) . DIRECTORY_SEPARATOR . '.temp' . DIRECTORY_SEPARATOR . 'wowo.json';
$backup = $storage . '.test-backup';
if (is_file($storage)) {
    @rename($storage, $backup);
}

echo "KraWowoBridge — uji dasar" . PHP_EOL;

// 1. pilar
$pilar = KraWowoBridge::pilarKonten();
cek('pilar konten tersedia', count($pilar) >= 3, count($pilar) . ' pilar');
cek('pilar punya nama', isset($pilar[0]['nama']) && $pilar[0]['nama'] !== '', (string) ($pilar[0]['nama'] ?? ''));

// 2. validasi input
$kosong = KraWowoBridge::terimaTugas(['prompt' => '']);
cek('tolak tugas tanpa prompt', ($kosong['ok'] ?? true) === false);

// 3. mode template (default)
putenv('KRA_WOWO_MODE=template');
$tugas = KraWowoBridge::terimaTugas([
    'agen' => 'wowo',
    'pilar' => 'Edukasi',
    'judul' => 'Edukasi #9',
    'prompt' => 'Buat 1 ide konten edukasi',
    'gaya' => 'santai',
    'jumlah_kata' => 250,
]);
cek('tugas diterima', ($tugas['ok'] ?? false) === true, (string) ($tugas['task_id'] ?? ''));
cek('task_id berawalan T', str_starts_with((string) ($tugas['task_id'] ?? ''), 'T'));
cek('mode template langsung selesai', ($tugas['status'] ?? '') === 'selesai');

$id = (string) ($tugas['task_id'] ?? '');
$tersimpan = KraWowoBridge::tugas($id);
cek('tugas tersimpan', $tersimpan !== null);
cek('ide terisi', $tersimpan !== null && trim((string) ($tersimpan['ide'] ?? '')) !== '');
cek('pilar tersimpan', ($tersimpan['pilar'] ?? '') === 'Edukasi');

// 4. daftar + filter
$semua = KraWowoBridge::daftarTugas();
$selesai = KraWowoBridge::daftarTugas('selesai');
cek('daftar tugas berisi', count($semua) >= 1, count($semua) . ' tugas');
cek('filter status selesai', count($selesai) >= 1 && count($selesai) <= count($semua));

// 5. mode manual
putenv('KRA_WOWO_MODE=manual');
$manual = KraWowoBridge::terimaTugas(['prompt' => 'Tulis ide manual', 'pilar' => 'Opini']);
$idManual = (string) ($manual['task_id'] ?? '');
cek('mode manual tetap diproses', ($manual['status'] ?? '') === 'diproses');

$tolak = KraWowoBridge::selesaikan($idManual, '');
cek('tolak ide kosong', ($tolak['ok'] ?? true) === false);

$selesaiManual = KraWowoBridge::selesaikan($idManual, 'Ide jadi dari manusia.', ['mode' => 'manual']);
cek('selesaikan manual berhasil', ($selesaiManual['ok'] ?? false) === true);
cek('status jadi selesai', ($selesaiManual['tugas']['status'] ?? '') === 'selesai');
cek('ide tersimpan', ($selesaiManual['tugas']['ide'] ?? '') === 'Ide jadi dari manusia.');

$tidakAda = KraWowoBridge::selesaikan('T999999', 'apa saja');
cek('tugas tak dikenal ditolak', ($tidakAda['ok'] ?? true) === false);

// 6. ringkasan
$ringkas = KraWowoBridge::ringkasan();
cek('ringkasan menghitung total', ($ringkas['total'] ?? 0) >= 2, (string) ($ringkas['total'] ?? 0));

// 7. otorisasi API key
putenv('KRA_WOWO_API_KEY=kunci-uji');
unset($_SERVER['HTTP_X_API_KEY']);
cek('tanpa header ditolak saat kunci diset', KraWowoBridge::authorized() === false);
cek('POST tugas ditolak tanpa kunci', (KraWowoBridge::terimaTugas(['prompt' => 'x'])['ok'] ?? true) === false);
$_SERVER['HTTP_X_API_KEY'] = 'kunci-uji';
cek('header benar diterima', KraWowoBridge::authorized() === true);
putenv('KRA_WOWO_API_KEY');
unset($_SERVER['HTTP_X_API_KEY']);

// 8. generator kustom
putenv('KRA_WOWO_MODE=template');
KraWowoBridge::setGenerator(static function (array $tugas): string {
    return 'IDE KUSTOM untuk ' . ($tugas['judul'] ?? '?');
});
$kustom = KraWowoBridge::terimaTugas(['prompt' => 'pakai generator kustom', 'judul' => 'Kustom #1']);
$kustomTugas = KraWowoBridge::tugas((string) ($kustom['task_id'] ?? ''));
cek('generator kustom dipakai', str_starts_with((string) ($kustomTugas['ide'] ?? ''), 'IDE KUSTOM'));
cek('mode tercatat custom', ($kustomTugas['mode'] ?? '') === 'custom');
KraWowoBridge::setGenerator(null);

echo PHP_EOL . $GLOBALS['lulus'] . '/' . ($GLOBALS['lulus'] + $GLOBALS['gagal']) . ' pemeriksaan lolos' . PHP_EOL;

if (is_file($backup)) {
    @rename($backup, $storage);
} elseif (is_file($storage)) {
    @unlink($storage);
}

exit($GLOBALS['gagal'] > 0 ? 1 : 0);
