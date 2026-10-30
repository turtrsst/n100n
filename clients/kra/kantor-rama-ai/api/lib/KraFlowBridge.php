<?php
declare(strict_types=1);

/**
 * KraFlowBridge — sisi KRA untuk workflow n100n (generik, bukan alur tertentu).
 *
 * Endpoint (didaftarkan di api/index.php):
 *   POST ?action=flow-tugas              -> terima tugas dari n100n
 *   GET  ?action=flow-tugas&status=...   -> daftar tugas + hasil
 *   POST ?action=flow-selesai            -> tandai selesai + isi hasil (mode manual)
 *   GET  ?action=flow-status             -> ringkasan
 *
 * Penyimpanan: <project>/.temp/flow.json (flock, tanpa MySQL) — mengikuti pola
 * KraTaskEngine supaya tetap jalan walau MySQL XAMPP mati.
 *
 * Mode menghasilkan hasil (env KRA_FLOW_MODE):
 *   template (default) : ringkasan deterministik, tugas langsung selesai — untuk uji
 *   agent              : pakai KraAgentChat (model AI KRA), gagal -> template
 *   manual             : tetap "diproses" sampai ada POST flow-selesai
 *
 * Generator kustom: KraFlowBridge::setGenerator(fn(array $tugas): string);
 *
 * Kontrak ini sengaja longgar: payload bebas (meta apa pun disimpan apa adanya),
 * jadi alur apa pun di n100n bisa memakai bridge ini sebagai antrean tugas.
 */
final class KraFlowBridge
{
    /** Kategori contoh; override lewat env KRA_FLOW_KATEGORI_FILE (JSON). */
    private const DEFAULT_KATEGORI = [
        ['id' => 1, 'nama' => 'Umum', 'deskripsi' => 'tugas tanpa kategori khusus'],
        ['id' => 2, 'nama' => 'Riset', 'deskripsi' => 'mengumpulkan dan merangkum bahan'],
        ['id' => 3, 'nama' => 'Tulis', 'deskripsi' => 'menyusun draf dari bahan yang ada'],
        ['id' => 4, 'nama' => 'Cek', 'deskripsi' => 'meninjau ulang hasil sebelum dipakai'],
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
        return self::tempDir() . DIRECTORY_SEPARATOR . 'flow.json';
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

    // ------------------------------------------------------------- kategori
    public static function kategori(): array
    {
        $file = trim((string) getenv('KRA_FLOW_KATEGORI_FILE'));
        if ($file !== '' && is_file($file)) {
            $data = json_decode((string) file_get_contents($file), true);
            if (is_array($data)) {
                $list = $data['kategori'] ?? $data;
                if (is_array($list) && $list !== []) {
                    return array_values($list);
                }
            }
        }
        return self::DEFAULT_KATEGORI;
    }

    // --------------------------------------------------------------- tugas
    /**
     * Terima satu tugas dari n100n. Wajib ada `prompt`; `judul`, `agen`,
     * `kategori`, dan field lain opsional (disimpan sebagai meta).
     */
    public static function terimaTugas(array $payload): array
    {
        if (!self::authorized()) {
            return ['ok' => false, 'error' => 'x-api-key tidak cocok (set KRA_FLOW_API_KEY / KRA_API_KEY).'];
        }
        $prompt = trim((string) ($payload['prompt'] ?? ''));
        if ($prompt === '') {
            return ['ok' => false, 'error' => 'prompt wajib diisi'];
        }

        $data = self::load();
        $id = 'T' . (int) (++$data['counter']);
        $tugas = [
            'task_id' => $id,
            'agen' => trim((string) ($payload['agen'] ?? 'agen-1')) ?: 'agen-1',
            'kategori' => trim((string) ($payload['kategori'] ?? 'Umum')) ?: 'Umum',
            'judul' => trim((string) ($payload['judul'] ?? '')) ?: ('Tugas ' . $id),
            'prompt' => $prompt,
            'gaya' => trim((string) ($payload['gaya'] ?? '')),
            'maks_kata' => (int) ($payload['maks_kata'] ?? 0),
            'meta' => is_array($payload['meta'] ?? null) ? $payload['meta'] : [],
            'status' => 'diproses',
            'dibuat' => gmdate('c'),
            'selesai' => null,
            'hasil' => null,
            'mode' => null,
        ];

        $mode = self::mode();
        if ($mode !== 'manual') {
            $hasil = self::generateHasil($tugas, $mode);
            $tugas['hasil'] = $hasil['hasil'];
            $tugas['mode'] = $hasil['mode'];
            if (trim((string) $hasil['hasil']) !== '') {
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

    public static function daftarTugas(?string $status = null, int $limit = 50, ?string $agen = null): array
    {
        $data = self::load();
        $items = array_values($data['tugas']);
        if ($status !== null && $status !== '') {
            $items = array_values(array_filter($items, static function (array $t) use ($status): bool {
                return (string) ($t['status'] ?? '') === $status;
            }));
        }
        if ($agen !== null && $agen !== '') {
            $items = array_values(array_filter($items, static function (array $t) use ($agen): bool {
                return (string) ($t['agen'] ?? '') === $agen;
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

    public static function selesaikan(string $id, string $hasil, array $meta = []): array
    {
        if (!self::authorized()) {
            return ['ok' => false, 'error' => 'x-api-key tidak cocok (set KRA_FLOW_API_KEY / KRA_API_KEY).'];
        }
        $hasil = trim($hasil);
        if ($hasil === '') {
            return ['ok' => false, 'error' => 'hasil wajib diisi'];
        }
        $data = self::load();
        if (!isset($data['tugas'][$id])) {
            return ['ok' => false, 'error' => 'tugas tidak ditemukan: ' . $id];
        }
        $data['tugas'][$id] = array_merge($data['tugas'][$id], [
            'hasil' => $hasil,
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

    // ---------------------------------------------------------------- akses
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
        return trim((string) (getenv('KRA_FLOW_API_KEY') ?: getenv('KRA_API_KEY') ?: ''));
    }

    private static function mode(): string
    {
        $mode = strtolower(trim((string) (getenv('KRA_FLOW_MODE') ?: 'template')));
        return in_array($mode, ['template', 'agent', 'manual'], true) ? $mode : 'template';
    }

    // ------------------------------------------------------------ generator
    private static function generateHasil(array $tugas, string $mode): array
    {
        if (is_callable(self::$generator)) {
            try {
                $hasil = trim((string) call_user_func(self::$generator, $tugas));
                if ($hasil !== '') {
                    return ['hasil' => $hasil, 'mode' => 'custom'];
                }
            } catch (Throwable $e) {
                // lanjut ke mode bawaan
            }
        }

        if ($mode === 'agent' && class_exists('KraAgentChat')) {
            try {
                $agentId = trim((string) (getenv('KRA_FLOW_AGENT') ?: 'rama'));
                $reply = KraAgentChat::dispatch([
                    'channel' => 'flow',
                    'agentId' => $agentId,
                    'message' => (string) ($tugas['prompt'] ?? ''),
                ]);
                $isi = trim((string) ($reply['message'] ?? ''));
                if ($isi !== '') {
                    return ['hasil' => $isi, 'mode' => 'agent'];
                }
            } catch (Throwable $e) {
                // jatuh ke template di bawah
            }
        }

        return ['hasil' => self::templateHasil($tugas), 'mode' => 'template'];
    }

    private static function templateHasil(array $tugas): string
    {
        $kategori = (string) ($tugas['kategori'] ?? 'Umum');
        $judul = (string) ($tugas['judul'] ?? 'Tugas');
        $gaya = (string) ($tugas['gaya'] ?? '');
        $kata = (int) ($tugas['maks_kata'] ?? 0);
        return '[' . $kategori . '] ' . $judul . ': ringkasan singkat, satu contoh konkret, '
            . 'dan satu langkah lanjutan yang bisa dikerjakan hari ini.'
            . ($gaya !== '' ? ' Gaya: ' . $gaya . '.' : '')
            . ($kata > 0 ? ' Sekitar ' . $kata . ' kata.' : '');
    }
}
