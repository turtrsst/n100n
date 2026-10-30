<?php
declare(strict_types=1);

/**
 * KraN100nClient — jembatan HTTP KRA -> n100n (engine automasi lokal n8n-like).
 *
 * Konfigurasi lewat environment (XAMPP: setprop atau .env pembungkus Apache):
 *   KRA_N100N_URL     default http://127.0.0.1:5679
 *   KRA_N100N_TOKEN   isi dengan APP_API_TOKEN dari .env n100n
 *
 * Contoh:
 *   $status = KraN100nClient::status();                        // cek hidup
 *   $exec   = KraN100nClient::runAsync(1, [['schedule' => gmdate('c')]]);
 *   $hasil  = KraN100nClient::waitExecution((int) $exec['execution_id'], 600);
 *
 * Tidak memakai Composer; curl bila ada, kalau tidak ada jatuh ke PHP streams
 * (pola yang sama dengan KraModelDispatcher).
 */
final class KraN100nClient
{
    public static function baseUrl(): string
    {
        $url = trim((string) (getenv('KRA_N100N_URL') ?: 'http://127.0.0.1:5679'));
        return rtrim($url, '/');
    }

    public static function token(): string
    {
        return trim((string) getenv('KRA_N100N_TOKEN'));
    }

    public static function isConfigured(): bool
    {
        return self::token() !== '';
    }

    /** Ringkasan untuk dashboard: tidak pernah melempar exception. */
    public static function status(): array
    {
        $info = [
            'configured' => self::isConfigured(),
            'baseUrl' => self::baseUrl(),
            'ok' => false,
        ];
        if (!self::isConfigured()) {
            $info['error'] = 'KRA_N100N_TOKEN belum diisi. Ambil dari APP_API_TOKEN di .env n100n.';
            return $info;
        }
        try {
            $health = self::health();
            $info['ok'] = (bool) ($health['ok'] ?? false);
            $info['health'] = $health;
        } catch (Throwable $e) {
            $info['error'] = $e->getMessage();
        }
        return $info;
    }

    public static function health(): array
    {
        return self::request('GET', '/api/health', null, 5);
    }

    public static function workflows(): array
    {
        return self::request('GET', '/api/workflows');
    }

    public static function workflow(int $id): array
    {
        return self::request('GET', '/api/workflows/' . $id);
    }

    /** Jalankan workflow dan tunggu sampai selesai (pakai untuk workflow pendek). */
    public static function run(int $id, array $items = [[]], int $timeoutSeconds = 120): array
    {
        return self::request('POST', '/api/workflows/' . $id . '/run', ['items' => $items], $timeoutSeconds);
    }

    /** Jalankan di latar belakang; cocok untuk alur yang berisi node wait panjang. */
    public static function runAsync(int $id, array $items = [[]]): array
    {
        return self::request('POST', '/api/workflows/' . $id . '/run?async=1', ['items' => $items], 15);
    }

    public static function execution(int $id, int $timeoutSeconds = 30): array
    {
        return self::request('GET', '/api/executions/' . $id, null, $timeoutSeconds);
    }

    /** Poll sampai status bukan "running" lagi (atau timeout). */
    public static function waitExecution(int $id, int $timeoutSeconds = 300, int $intervalMs = 1500): array
    {
        $deadline = time() + max(1, $timeoutSeconds);
        $last = [];
        while (time() < $deadline) {
            $last = self::execution($id);
            if (($last['status'] ?? 'running') !== 'running') {
                return $last;
            }
            usleep(max(200, $intervalMs) * 1000);
        }
        $last['timeout'] = true;
        return $last;
    }

    /** Panggil webhook n100n (workflow trigger webhook yang aktif). */
    public static function webhook(string $path, array $payload = [], bool $wait = false, ?string $webhookToken = null): array
    {
        $query = [];
        if ($wait) {
            $query[] = 'wait=1';
        }
        if ($webhookToken !== null && $webhookToken !== '') {
            $query[] = 'token=' . rawurlencode($webhookToken);
        }
        $suffix = $query === [] ? '' : '?' . implode('&', $query);
        return self::request('POST', '/webhook/' . ltrim($path, '/') . $suffix, $payload);
    }

    private static function request(string $method, string $path, ?array $body = null, int $timeoutSeconds = 30, int $retry = 1): array
    {
        if (!self::isConfigured()) {
            throw new RuntimeException('KRA_N100N_TOKEN belum diisi. Ambil dari APP_API_TOKEN di .env n100n.');
        }
        $url = self::baseUrl() . $path;
        $payload = $body === null ? null : json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        $headers = [
            'Content-Type: application/json',
            'Accept: application/json',
            'x-api-key: ' . self::token(),
        ];

        $lastError = null;
        for ($attempt = 0; $attempt <= $retry; $attempt++) {
            [$status, $raw] = self::http($method, $url, $headers, $payload, $timeoutSeconds);
            $data = json_decode($raw, true);
            if ($status >= 200 && $status < 300) {
                return is_array($data) ? $data : ['ok' => true, 'raw' => $raw];
            }
            $message = is_array($data) && isset($data['error'])
                ? (string) $data['error']
                : substr($raw, 0, 300);
            $lastError = new RuntimeException('n100n membalas HTTP ' . $status . ': ' . $message);
            if ($status < 500 && $status !== 429) {
                break;
            }
            if ($attempt < $retry) {
                usleep(250000 * ($attempt + 1));
            }
        }
        throw $lastError ?? new RuntimeException('Permintaan ke n100n gagal tanpa keterangan.');
    }

    /** @return array{0:int,1:string} [status, body mentah] */
    private static function http(string $method, string $url, array $headers, ?string $payload, int $timeoutSeconds): array
    {
        if (function_exists('curl_init')) {
            $ch = curl_init($url);
            if ($ch !== false) {
                $options = [
                    CURLOPT_CUSTOMREQUEST => $method,
                    CURLOPT_RETURNTRANSFER => true,
                    CURLOPT_HTTPHEADER => $headers,
                    CURLOPT_TIMEOUT => max(1, $timeoutSeconds),
                    CURLOPT_CONNECTTIMEOUT => 10,
                ];
                if ($payload !== null) {
                    $options[CURLOPT_POSTFIELDS] = $payload;
                }
                curl_setopt_array($ch, $options);
                $raw = curl_exec($ch);
                $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
                $error = curl_error($ch);
                curl_close($ch);
                if ($raw === false) {
                    throw new RuntimeException(
                        'n100n tidak bisa dihubungi di ' . self::baseUrl() . ': ' . ($error !== '' ? $error : 'koneksi gagal')
                    );
                }
                return [$status, (string) $raw];
            }
        }

        // Cadangan tanpa ekstensi curl (pola KraModelDispatcher).
        $context = stream_context_create([
            'http' => [
                'method' => $method,
                'header' => implode("\r\n", $headers) . "\r\n",
                'content' => $payload ?? '',
                'timeout' => max(1, $timeoutSeconds),
                'ignore_errors' => true,
            ],
        ]);
        $raw = @file_get_contents($url, false, $context);
        if ($raw === false) {
            $last = error_get_last();
            $message = is_array($last) ? (string) ($last['message'] ?? '') : '';
            throw new RuntimeException(
                'n100n tidak bisa dihubungi di ' . self::baseUrl() . ': ' . ($message !== '' ? $message : 'koneksi gagal')
            );
        }
        $status = 200;
        $responseHeaders = $http_response_header ?? [];
        foreach ($responseHeaders as $lines) {
            if (preg_match('#^HTTP/\S+\s+(\d{3})#', (string) $lines, $match) === 1) {
                $status = (int) $match[1];
            }
        }
        return [$status, (string) $raw];
    }
}
