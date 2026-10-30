<?php
/**
 * Kerangka endpoint KRA yang dipanggil Workflow WOWO (n100n).
 * Salin ke kantor-rama-ai, sesuaikan query-nya dengan tabel yang sudah ada.
 *
 * Kontrak yang diharapkan workflows/wowo.json:
 *   GET  /api/pilar-konten          -> {"pilar":[{"id":1,"nama":"Edukasi","deskripsi":"..."}]}
 *   POST /api/tugas                 -> {"task_id":"T123","status":"diproses"}
 *   GET  /api/tugas?agen=wowo&status=selesai
 *                                   -> {"items":[{"task_id":"T123","status":"selesai","ide":"..."}]}
 *
 * Auth: header  x-api-key: <KRA_API_KEY>  (samakan dengan .env n100n)
 * Semua balasan JSON. Kode status 5xx/429 akan di-retry otomatis oleh n100n.
 */

declare(strict_types=1);

// ---------------------------------------------------------------------------
// 1. Konfigurasi & koneksi (contoh PDO; ganti dengan Eloquent kalau Laravel)
// ---------------------------------------------------------------------------
$API_KEY = getenv('KRA_API_KEY') ?: 'dev-kra-key';

$pdo = new PDO(
    sprintf('mysql:host=%s;port=%s;dbname=%s;charset=utf8mb4',
        getenv('DB_HOST') ?: '127.0.0.1',
        getenv('DB_PORT') ?: '3306',
        getenv('DB_DATABASE') ?: 'kra'),
    getenv('DB_USERNAME') ?: 'root',
    getenv('DB_PASSWORD') ?: ''
);
$pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);

header('Content-Type: application/json; charset=utf-8');

function balas(int $status, array $data): void
{
    http_response_code($status);
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

// ---------------------------------------------------------------------------
// 2. Auth
// ---------------------------------------------------------------------------
$given = $_SERVER['HTTP_X_API_KEY'] ?? '';
if (!hash_equals($API_KEY, $given)) {
    balas(401, ['ok' => false, 'error' => 'x-api-key salah']);
}

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';

// ---------------------------------------------------------------------------
// 3. GET /api/pilar-konten
// ---------------------------------------------------------------------------
if ($method === 'GET' && $path === '/api/pilar-konten') {
    // TODO: ganti dengan query tabel pilar konten milik KRA.
    $stmt = $pdo->query('SELECT id, nama, deskripsi FROM pilar_konten ORDER BY id');
    balas(200, ['ok' => true, 'pilar' => $stmt->fetchAll(PDO::FETCH_ASSOC)]);
}

// ---------------------------------------------------------------------------
// 4. POST /api/tugas  (n100n -> Wowo)
// ---------------------------------------------------------------------------
if ($method === 'POST' && $path === '/api/tugas') {
    $body = json_decode(file_get_contents('php://input') ?: '[]', true) ?: [];
    if (empty($body['prompt'])) {
        balas(400, ['ok' => false, 'error' => 'prompt wajib diisi']);
    }

    // Kalau agen sedang sibuk, balas 503 -> n100n akan retry sendiri.
    // if (agenSibuk()) balas(503, ['ok' => false, 'error' => 'agen sibuk']);

    // TODO: sesuaikan dengan tabel tugas KRA.
    $stmt = $pdo->prepare(
        'INSERT INTO tugas_wowo (agen, pilar, judul, prompt, gaya, jumlah_kata, status, dibuat)
         VALUES (:agen, :pilar, :judul, :prompt, :gaya, :kata, "diproses", NOW())'
    );
    $stmt->execute([
        ':agen'   => $body['agen'] ?? 'wowo',
        ':pilar'  => $body['pilar'] ?? 'Umum',
        ':judul'  => $body['judul'] ?? '',
        ':prompt' => $body['prompt'],
        ':gaya'   => $body['gaya'] ?? '',
        ':kata'   => (int) ($body['jumlah_kata'] ?? 300),
    ]);

    balas(202, [
        'ok'      => true,
        'task_id' => 'T' . $pdo->lastInsertId(),
        'status'  => 'diproses',
    ]);
}

// ---------------------------------------------------------------------------
// 5. GET /api/tugas?agen=wowo&status=selesai
// ---------------------------------------------------------------------------
if ($method === 'GET' && $path === '/api/tugas') {
    $agen = $_GET['agen'] ?? 'wowo';
    $status = $_GET['status'] ?? null;

    $sql = 'SELECT id AS task_id, agen, pilar, judul, ide, hasil, status, dibuat
            FROM tugas_wowo WHERE agen = :agen';
    $params = [':agen' => $agen];
    if ($status !== null) {
        $sql .= ' AND status = :status';
        $params[':status'] = $status;
    }
    $sql .= ' ORDER BY id DESC LIMIT 50';

    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    balas(200, ['ok' => true, 'items' => $stmt->fetchAll(PDO::FETCH_ASSOC)]);
}

// ---------------------------------------------------------------------------
// 6. POST /api/tugas/{id}/selesai  (dipanggil agen Wowo setelah selesai)
// ---------------------------------------------------------------------------
if ($method === 'POST' && preg_match('#^/api/tugas/([\w-]+)/selesai$#', $path, $m)) {
    $body = json_decode(file_get_contents('php://input') ?: '[]', true) ?: [];
    $stmt = $pdo->prepare('UPDATE tugas_wowo SET ide = :ide, hasil = :hasil, status = "selesai" WHERE id = :id');
    $stmt->execute([
        ':ide'   => $body['ide'] ?? '',
        ':hasil' => json_encode($body['hasil'] ?? []),
        ':id'    => $m[1],
    ]);
    balas(200, ['ok' => true]);
}

balas(404, ['ok' => false, 'error' => 'endpoint tidak ada']);
