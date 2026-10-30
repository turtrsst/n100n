<?php
declare(strict_types=1);

/**
 * KraWowoBridge — sisi KRA yang dipanggil Workflow WOWO (n100n).
 *
 * Endpoint (lihat api/index.php):
 *   GET  ?action=wowo-pilar            -> daftar pilar konten
 *   POST ?action=wowo-tugas            -> Wowo menerima tugas  (dipanggil n100n)
 *   GET  ?action=wowo-tugas&status=... -> daftar tugas + ide
 *   POST ?action=wowo-selesai          -> tandai selesai + isi ide (kalau manual)
 *
 * Penyimpanan: <project>/.temp/wowo.json (flock, tanpa MySQL) — mengikuti pola
 * KraTaskEngine supaya tetap jalan walau MySQL XAMPP mati.
 *
 * Mode menghasilkan ide (env KRA_WOWO_MODE):
 *   template (default) : ide contoh deterministik, alur langsung selesai — untuk uji
 *   agent              : pakai KraAgentChat (model AI KRA), gagal -> template
 *   manual             : biarkan "diproses" sampai ada POST wowo-selesai
 *
 * Generator kustom: KraWowoBridge::setGenerator(fn(array $tugas): string);
 */
final class KraWowoBridge
{
    private const DEFAULT_PILAR = [
        ['id' => 1, 'nama' => 'Edukasi', 'deskripsi' => 'menjelaskan konsep ke pembaca awam'],
        ['id' => 2, 'nama' => 'Studi Kasus', 'deskripsi' => 'cerita nyata dari lapangan'],
        ['id' => 3, 'nama' => 'Tips Praktis', 'deskripsi' => 'langkah singkat yang bisa langsung dicoba'],
        ['id' => 4, 'nama' => 'Opini', 'deskripsi' => 'sudut pandang penulis atas isu hangat'],
    ];

    /** @var callable|null */
    private static $generator = null;

    public static function setGenerator(?callable $generator): void
    {
        self::$generator = $generator;
    }

    // ---------------------------------------------------------------- storage
    private static function tempDir(): string
    {
        $dir = dirname(__DIR__, 2) . DIRECTORY_SEPARATOR . '.temp';
        if (!is_dir($dir)) {
            @mkdir($dir, 0777, true);
        }
        return $dir;
    }

    private static function storagePath(): string
    {
        return self::tempDir() . DIRECTORY_SEPARATOR . 'wowo.json';
    }

    private static function load(): array
    {
        $path = self::storagePath();
        if (!is_file($path)) {
            return ['counter' => 1000, 'tugas' => []];
        }
        $raw = (string) @file_get_contents($path);
        $data = json_decode($raw, true);
        if (!is_array($data)) {
            return ['counter' => 1000, 'tugas' => []];
        }
        return [
            'counter' => (int) ($data['counter'] ?? 1000),
            'tugas' => is_array($data['tugas'] ?? null) ? $data['tugas'] : [],
        ];
    }

    private static function save(array $data): void
    {
        $path = self::storagePath();
        $handle = @fopen($path, 'c');
        if ($handle === false) {
            throw new RuntimeException('Tidak bisa menulis ' . $path);
        }
        try {
            flock($handle, LOCK_EX);
            ftruncate($handle, 0);
            rewind($handle);
            fwrite($handle, (string) json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
            fflush($handle);
        } finally {
            flock($handle, LOCK_UN);
            fclose($handle);
        }
    }

    // -------------------------------------------------------------- pilar
    public static function pilarKonten(): array
    {
        $file = trim((string) getenv('KRA_WOWO_PILAR_FILE'));
        if ($file !== '' && is_file($file)) {
            $data = json_decode((string) file_get_contents($file), true);
            if (is_array($data)) {
                $list = $data['pilar'] ?? $data;
                if (is_array($list) && $list !== []) {
                    return array_values($list);
                }
            }
        }
        return self::DEFAULT_PILAR;
    }

    // -------------------------------------------------------------- tugas
    public static function terimaTugas(array $payload): array
    {
        if (!self::authorized()) {
            return ['ok' => false, 'error' => 'x-api-key tidak cocok (set KRA_WOWO_API_KEY / KRA_API_KEY).'];
        }
        $prompt = trim((string) ($payload['prompt'] ?? ''));
        if ($prompt === '') {
            return ['ok' => false, 'error' => 'prompt wajib diisi'];
        }

        $data = self::load();
        $id = 'T' . (int) (++$data['counter']);
        $tugas = [
            'task_id' => $id,
            'agen' => trim((string) ($payload['agen'] ?? 'wowo')) ?: 'wowo',
            'pilar' => trim((string) ($payload['pilar'] ?? 'Umum')) ?: 'Umum',
            'judul' => trim((string) ($payload['judul'] ?? '')) ?: ('Konten ' . $id),
            'prompt' => $prompt,
            'gaya' => trim((string) ($payload['gaya'] ?? '')),
            'jumlah_kata' => (int) ($payload['jumlah_kata'] ?? 300),
            'status' => 'diproses',
            'dibuat' => gmdate('c'),
            'selesai' => null,
            'ide' => null,
            'mode' => null,
        ];

        $mode = self::mode();
        if ($mode !== 'manual') {
            $hasil = self::generateIde($tugas, $mode);
            $tugas['ide'] = $hasil['ide'];
            $tugas['mode'] = $hasil['mode'];
            if (trim((string) $hasil['ide']) !== '') {
                $tugas['status'] = 'selesai';
                $tugas['selesai'] = gmdate('c');
            }
        }

        $data['tugas'][$id] = $tugas;
        self::save($data);

        return [
            'ok' => true,
            'task_id' => $id,
            'status' => $tugas['status'],
            'diterima' => $tugas['dibuat'],
        ];
    }

    public static function daftarTugas(?string $status = null, int $limit = 50): array
    {
        $data = self::load();
        $items = array_values($data['tugas']);
        if ($status !== null && $status !== '') {
            $items = array_values(array_filter($items, static function (array $t) use ($status): bool {
                return (string) ($t['status'] ?? '') === $status;
            }));
        }
        usort($items, static function (array $a, array $b): int {
            return strcmp((string) ($b['dibuat'] ?? ''), (string) ($a['dibuat'] ?? ''));
        });
        return array_slice($items, 0, max(1, $limit));
    }

    public static function tugas(string $id): ?array
    {
        $data = self::load();
        return $data['tugas'][$id] ?? null;
    }

    public static function selesaikan(string $id, string $ide, array $meta = []): array
    {
        if (!self::authorized()) {
            return ['ok' => false, 'error' => 'x-api-key tidak cocok (set KRA_WOWO_API_KEY / KRA_API_KEY).'];
        }
        $ide = trim($ide);
        if ($ide === '') {
            return ['ok' => false, 'error' => 'ide wajib diisi'];
        }
        $data = self::load();
        if (!isset($data['tugas'][$id])) {
            return ['ok' => false, 'error' => 'tugas tidak ditemukan: ' . $id];
        }
        $data['tugas'][$id] = array_merge($data['tugas'][$id], [
            'ide' => $ide,
            'status' => 'selesai',
            'selesai' => gmdate('c'),
            'mode' => (string) ($meta['mode'] ?? 'manual'),
        ], is_array($meta) ? $meta : []);
        self::save($data);
        return ['ok' => true, 'tugas' => $data['tugas'][$id]];
    }

    public static function ringkasan(): array
    {
        $data = self::load();
        $semua = array_values($data['tugas']);
        $hitung = ['diproses' => 0, 'selesai' => 0];
        foreach ($semua as $tugas) {
            $status = (string) ($tugas['status'] ?? '');
            if (isset($hitung[$status])) {
                $hitung[$status]++;
            }
        }
        return [
            'total' => count($semua),
            'diproses' => $hitung['diproses'],
            'selesai' => $hitung['selesai'],
            'mode' => self::mode(),
            'storage' => self::storagePath(),
            'terakhir' => $semua[0] ?? null,
        ];
    }

    // -------------------------------------------------------------- akses
    public static function authorized(): bool
    {
        $expected = self::apiKey();
        if ($expected === '') {
            return true; // lokal tanpa kunci: izinkan (n100n juga tanpa token bila APP_API_TOKEN kosong)
        }
        $given = trim((string) ($_SERVER['HTTP_X_API_KEY'] ?? ''));
        return $given !== '' && hash_equals($expected, $given);
    }

    /** Aksi admin (n100n-run dll): API key ATAU login KRA. */
    public static function isOperator(): bool
    {
        if (self::apiKey() !== '' && self::authorized()) {
            return true;
        }
        if (self::apiKey() === '') {
            return true;
        }
        if (class_exists('KraAuth')) {
            try {
                return KraAuth::authenticate() !== null;
            } catch (Throwable $e) {
                return false;
            }
        }
        return false;
    }

    private static function apiKey(): string
    {
        return trim((string) (getenv('KRA_WOWO_API_KEY') ?: getenv('KRA_API_KEY') ?: ''));
    }

    private static function mode(): string
    {
        $mode = strtolower(trim((string) (getenv('KRA_WOWO_MODE') ?: 'template')));
        return in_array($mode, ['template', 'agent', 'manual'], true) ? $mode : 'template';
    }

    // ---------------------------------------------------------- generator
    private static function generateIde(array $tugas, string $mode): array
    {
        if (is_callable(self::$generator)) {
            try {
                $ide = trim((string) call_user_func(self::$generator, $tugas));
                if ($ide !== '') {
                    return ['ide' => $ide, 'mode' => 'custom'];
                }
            } catch (Throwable $e) {
                // lanjut ke mode bawaan
            }
        }

        if ($mode === 'agent' && class_exists('KraAgentChat')) {
            try {
                $agentId = trim((string) (getenv('KRA_WOWO_AGENT') ?: 'rama'));
                $reply = KraAgentChat::dispatch([
                    'channel' => 'wowo',
                    'agentId' => $agentId,
                    'message' => (string) ($tugas['prompt'] ?? ''),
                ]);
                $isi = trim((string) ($reply['message'] ?? ''));
                if ($isi !== '') {
                    return ['ide' => $isi, 'mode' => 'agent'];
                }
            } catch (Throwable $e) {
                // jatuh ke template di bawah
            }
        }

        return ['ide' => self::templateIde($tugas), 'mode' => 'template'];
    }

    private static function templateIde(array $tugas): string
    {
        $pilar = (string) ($tugas['pilar'] ?? 'Umum');
        $judul = (string) ($tugas['judul'] ?? 'Ide baru');
        $gaya = (string) ($tugas['gaya'] ?? '');
        $kata = (int) ($tugas['jumlah_kata'] ?? 300);
        return '[' . $pilar . '] ' . $judul . ': mulai dari pertanyaan yang paling sering ditanya, '
            . 'bongkar satu mitos yang beredar, lalu tutup dengan satu langkah praktis yang bisa dicoba hari ini.'
            . ($gaya !== '' ? ' Gaya: ' . $gaya . '.' : '')
            . ' Target sekitar ' . $kata . ' kata.';
    }
}
