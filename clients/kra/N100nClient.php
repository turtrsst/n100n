<?php
/**
 * N100nClient — klien PHP untuk n100n (engine automasi lokal).
 *
 * Drop-in untuk kantor-rama-ai (Laravel): simpan sebagai app/Support/N100nClient.php
 * (atau app/Services/N100nClient.php), lalu daftarkan di config/services.php:
 *
 *   'n100n' => [
 *       'url'   => env('N100N_URL', 'http://127.0.0.1:5679'),
 *       'token' => env('N100N_TOKEN'),
 *   ],
 *
 * Pemakaian dari controller/job KRA:
 *
 *   $n = N100nClient::fromEnv();
 *   $n->run(3, [['nama' => 'Rama']]);                 // tunggu sampai selesai
 *   $id = $n->runAsync(3, [['nama' => 'Rama']]);      // 202 + execution_id
 *   $n->waitExecution($id, 120);
 *
 * Tanpa dependency: hanya ekstensi curl + json.
 */

namespace App\Support;

class N100nException extends \RuntimeException
{
    public int $status;
    public array|string|null $payload;

    public function __construct(string $message, int $status = 0, array|string|null $payload = null)
    {
        parent::__construct($message, $status);
        $this->status = $status;
        $this->payload = $payload;
    }
}

class N100nClient
{
    private string $baseUrl;
    private string $token;
    private int $timeout;
    private int $retry;

    public function __construct(?string $baseUrl = null, ?string $token = null, int $timeout = 30, int $retry = 2)
    {
        $this->baseUrl = rtrim($baseUrl ?: getenv('N100N_URL') ?: 'http://127.0.0.1:5679', '/');
        $this->token = (string) ($token ?: getenv('N100N_TOKEN') ?: '');
        $this->timeout = max(1, $timeout);
        $this->retry = max(0, $retry);
    }

    public static function fromEnv(): self
    {
        return new self(
            getenv('N100N_URL') ?: null,
            getenv('N100N_TOKEN') ?: null,
            (int) (getenv('N100N_TIMEOUT') ?: 30)
        );
    }

    // ---------- utilitas ----------
    private function request(string $method, string $path, ?array $body = null, ?int $timeout = null): array
    {
        if ($this->token === '') {
            throw new N100nException('N100N_TOKEN belum diisi (ambil dari APP_API_TOKEN di .env n100n).');
        }
        $url = $this->baseUrl . $path;
        $payload = $body === null ? null : json_encode($body, JSON_UNESCAPED_UNICODE);
        $lastError = null;

        for ($attempt = 0; $attempt <= $this->retry; $attempt++) {
            $ch = curl_init($url);
            curl_setopt_array($ch, [
                CURLOPT_CUSTOMREQUEST  => $method,
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_TIMEOUT        => $timeout ?: $this->timeout,
                CURLOPT_CONNECTTIMEOUT => 10,
                CURLOPT_HTTPHEADER     => array_filter([
                    'Content-Type: application/json',
                    'Accept: application/json',
                    'x-api-key: ' . $this->token,
                ]),
                CURLOPT_POSTFIELDS     => $payload,
            ]);
            $raw = curl_exec($ch);
            $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
            $curlErr = curl_error($ch);
            curl_close($ch);

            if ($raw === false) {
                $lastError = new N100nException('n100n tidak bisa dihubungi: ' . $curlErr);
            } else {
                $data = json_decode($raw, true);
                if ($status >= 200 && $status < 300) {
                    return is_array($data) ? $data : ['raw' => $raw];
                }
                // 5xx layak diulang, 4xx tidak
                $lastError = new N100nException(
                    'n100n membalas HTTP ' . $status . ': ' . substr((string) $raw, 0, 300),
                    $status,
                    $data ?? $raw
                );
                if ($status < 500 && $status !== 429) {
                    throw $lastError;
                }
            }

            if ($attempt < $this->retry) {
                usleep((int) (250000 * pow(2, $attempt))); // 250ms, 500ms, ...
            }
        }
        throw $lastError ?? new N100nException('n100n request gagal tanpa keterangan');
    }

    // ---------- endpoint ----------
    public function health(): array
    {
        return $this->request('GET', '/api/health', null, 5);
    }

    public function workflows(): array
    {
        return $this->request('GET', '/api/workflows');
    }

    public function workflow(int $id): array
    {
        return $this->request('GET', '/api/workflows/' . $id);
    }

    public function createWorkflow(array $definition): array
    {
        return $this->request('POST', '/api/workflows', $definition);
    }

    public function updateWorkflow(int $id, array $changes): array
    {
        return $this->request('PUT', '/api/workflows/' . $id, $changes);
    }

    public function deleteWorkflow(int $id): array
    {
        return $this->request('DELETE', '/api/workflows/' . $id);
    }

    public function setActive(int $id, bool $active): array
    {
        return $this->request('POST', '/api/workflows/' . $id . '/toggle', ['active' => $active]);
    }

    /** Jalankan workflow dan tunggu hasilnya (pakai untuk workflow pendek). */
    public function run(int $id, array $items = [[]], int $timeout = 120): array
    {
        return $this->request('POST', '/api/workflows/' . $id . '/run', ['items' => $items], $timeout);
    }

    /** Jalankan di latar belakang; kembali cepat dengan execution_id. Cocok untuk WOWO yang pakai wait panjang. */
    public function runAsync(int $id, array $items = [[]]): int
    {
        $res = $this->request('POST', '/api/workflows/' . $id . '/run?async=1', ['items' => $items], 15);
        if (empty($res['execution_id'])) {
            throw new N100nException('n100n tidak mengembalikan execution_id');
        }
        return (int) $res['execution_id'];
    }

    public function execution(int $id): array
    {
        return $this->request('GET', '/api/executions/' . $id);
    }

    public function executions(?int $workflowId = null, int $limit = 20): array
    {
        $q = '/api/executions?limit=' . $limit . ($workflowId ? '&workflow_id=' . $workflowId : '');
        return $this->request('GET', $q);
    }

    /** Tunggu sampai eksekusi tidak lagi "running" (poll tiap $intervalMs). */
    public function waitExecution(int $id, int $timeoutSec = 300, int $intervalMs = 2000): array
    {
        $deadline = time() + max(1, $timeoutSec);
        while (time() < $deadline) {
            $exec = $this->execution($id);
            if (($exec['status'] ?? 'running') !== 'running') {
                return $exec;
            }
            usleep($intervalMs * 1000);
        }
        return $this->execution($id) + ['timeout' => true];
    }

    /** Panggil webhook n100n (workflow dengan trigger webhook & aktif). */
    public function webhook(string $path, array $payload = [], bool $wait = false, ?string $webhookToken = null): array
    {
        $q = [];
        if ($wait) $q[] = 'wait=1';
        if ($webhookToken) $q[] = 'token=' . urlencode($webhookToken);
        $suffix = $q ? '?' . implode('&', $q) : '';
        return $this->request('POST', '/webhook/' . ltrim($path, '/') . $suffix, $payload);
    }
}
