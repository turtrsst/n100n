    // ---------------- integrasi n100n (antrean tugas, generik) ----------------
    if ($action === 'flow-kategori') {
        respond([
            'ok' => true,
            'kategori' => KraFlowBridge::kategori(),
            'diambil' => gmdate('c'),
        ]);
    }

    if ($action === 'flow-tugas') {
        if ($_SERVER['REQUEST_METHOD'] === 'POST') {
            // body dibaca lebih dulu walau nanti ditolak: menjaga koneksi keep-alive
            $payload = json_decode((string) file_get_contents('php://input'), true) ?: $_POST;
            $hasil = KraFlowBridge::terimaTugas(is_array($payload) ? $payload : []);
            respond($hasil, ($hasil['ok'] ?? false) ? 202 : 400);
        }
        $status = isset($_GET['status']) ? (string) $_GET['status'] : null;
        $agen = isset($_GET['agen']) ? (string) $_GET['agen'] : null;
        $limit = (int) ($_GET['limit'] ?? 50);
        $items = KraFlowBridge::daftarTugas($status, $limit, $agen);
        respond([
            'ok' => true,
            'items' => $items,
            'jumlah' => count($items),
            'ringkasan' => KraFlowBridge::ringkasan(),
        ]);
    }

    if ($action === 'flow-selesai') {
        $payload = json_decode((string) file_get_contents('php://input'), true) ?: $_POST;
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            respond(['ok' => false, 'error' => 'flow-selesai requires POST.'], 405);
        }
        $hasil = KraFlowBridge::selesaikan(
            (string) ($payload['task_id'] ?? $_GET['task_id'] ?? ''),
            (string) ($payload['hasil'] ?? ''),
            ['mode' => (string) ($payload['mode'] ?? 'manual')]
        );
        respond($hasil, ($hasil['ok'] ?? false) ? 200 : 400);
    }

    if ($action === 'flow-status') {
        respond(['ok' => true, 'ringkasan' => KraFlowBridge::ringkasan()]);
    }

    if ($action === 'n100n-status') {
        respond(['ok' => true, 'n100n' => KraN100nClient::status(), 'antrean' => KraFlowBridge::ringkasan()]);
    }

    if ($action === 'n100n-workflows') {
        if (!KraFlowBridge::isOperator()) {
            respond(['ok' => false, 'error' => 'Butuh x-api-key atau login KRA.'], 401);
        }
        try {
            $daftar = KraN100nClient::workflows();
        } catch (Throwable $e) {
            respond(['ok' => false, 'error' => $e->getMessage()], 502);
        }
        $ringkas = [];
        foreach ($daftar as $wf) {
            $ringkas[] = [
                'id' => $wf['id'] ?? null,
                'name' => $wf['name'] ?? '',
                'active' => (bool) ($wf['active'] ?? false),
                'trigger' => $wf['trigger'] ?? '',
                'updated' => $wf['updated'] ?? null,
            ];
        }
        respond(['ok' => true, 'workflows' => $ringkas]);
    }

    if ($action === 'n100n-run') {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            respond(['ok' => false, 'error' => 'n100n-run requires POST.'], 405);
        }
        if (!KraFlowBridge::isOperator()) {
            respond(['ok' => false, 'error' => 'Butuh x-api-key atau login KRA.'], 401);
        }
        $payload = json_decode((string) file_get_contents('php://input'), true) ?: $_POST;
        $workflowId = (int) ($payload['workflow_id'] ?? $_GET['workflow_id'] ?? 0);
        if ($workflowId <= 0) {
            respond(['ok' => false, 'error' => 'workflow_id wajib diisi'], 400);
        }
        $items = $payload['items'] ?? [['schedule' => gmdate('c')]];
        if (!is_array($items)) {
            $items = [['schedule' => gmdate('c')]];
        }
        $mode = strtolower((string) ($payload['mode'] ?? $_GET['mode'] ?? 'async'));
        try {
            if ($mode === 'sync') {
                $hasil = KraN100nClient::run($workflowId, $items, (int) ($payload['timeout'] ?? 120));
                respond($hasil);
            }
            $mulai = KraN100nClient::runAsync($workflowId, $items);
            $executionId = (int) ($mulai['execution_id'] ?? 0);
            if ($executionId <= 0) {
                respond(['ok' => false, 'error' => 'n100n tidak mengembalikan execution_id'], 502);
            }
            if (!(bool) ($payload['wait'] ?? true)) {
                respond(['ok' => true, 'execution_id' => $executionId, 'status' => 'running']);
            }
            $detail = KraN100nClient::waitExecution($executionId, (int) ($payload['timeout'] ?? 600));
            respond(['ok' => ($detail['status'] ?? '') === 'success', 'execution' => $detail]);
        } catch (Throwable $e) {
            respond(['ok' => false, 'error' => $e->getMessage()], 502);
        }
    }

    if ($action === 'n100n-execution') {
        if (!KraFlowBridge::isOperator()) {
            respond(['ok' => false, 'error' => 'Butuh x-api-key atau login KRA.'], 401);
        }
        $id = (int) ($_GET['id'] ?? 0);
        if ($id <= 0) {
            respond(['ok' => false, 'error' => 'id eksekusi wajib diisi'], 400);
        }
        try {
            respond(['ok' => true, 'execution' => KraN100nClient::execution($id)]);
        } catch (Throwable $e) {
            respond(['ok' => false, 'error' => $e->getMessage()], 502);
        }
    }
