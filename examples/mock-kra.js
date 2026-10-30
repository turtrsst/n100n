'use strict';
// Tiruan API "kantor-rama-ai" untuk menguji contoh alur tanpa server KRA asli.
// Jalankan: node examples/mock-kra.js   (default http://localhost:5680)
//
// Kontrak yang ditiru (generik, bukan alur tertentu):
//   POST /api/tugas                  -> terima tugas  {task_id, status}
//   GET  /api/tugas?status=selesai   -> daftar tugas + hasil
//   POST /api/tugas/:id/selesai      -> tandai selesai manual
//   GET  /health
//
// Env:
//   MOCK_KRA_PORT=5680  MOCK_KRA_KEY=dev-kra-key  MOCK_TUGAS_FAIL=1  MOCK_TUGAS_MS=15000

const http = require('node:http');

const PORT = Number(process.env.MOCK_KRA_PORT || 5680);
const KEY = process.env.MOCK_KRA_KEY || 'dev-kra-key';
const FAIL_FIRST = Number(process.env.MOCK_TUGAS_FAIL || 1);
const DURASI_MS = Number(process.env.MOCK_TUGAS_MS || 15000);

let nextId = 1000;
const tugas = new Map();
let jumlahPost = 0;

function json(res, status, body, extra = {}) {
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, extra));
  res.end(JSON.stringify(body));
}

function bacaBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { resolve({}); }
    });
  });
}

function hasilUntuk(item) {
  const judul = item.judul || 'Tugas';
  return {
    judul,
    hasil: `[${item.agen || 'agen'}] ${judul}: ringkasan singkat, satu contoh konkret, `
      + 'dan satu langkah lanjutan yang bisa dikerjakan hari ini.',
    selesai: new Date().toISOString(),
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const auth = req.headers['x-api-key'] || url.searchParams.get('api_key') || '';
  if (url.pathname !== '/health' && auth !== KEY) return json(res, 401, { ok: false, error: 'api key salah' });

  if (url.pathname === '/health') {
    return json(res, 200, { ok: true, layanan: 'mock-kra', tugas: tugas.size, post: jumlahPost });
  }

  if (url.pathname === '/') {
    return json(res, 200, {
      layanan: 'mock KRA',
      endpoint: ['POST /api/tugas', 'GET /api/tugas?status=selesai', 'POST /api/tugas/:id/selesai'],
      tugas: [...tugas.values()].map((t) => ({ id: t.task_id, status: t.status, judul: t.judul })),
    });
  }

  if (url.pathname === '/api/tugas' && req.method === 'POST') {
    // body WAJIB dibaca dulu walau akan membalas gagal, supaya koneksi keep-alive tidak kacau
    const payload = await bacaBody(req);
    jumlahPost++;
    if (jumlahPost <= FAIL_FIRST) {
      return json(res, 503, { ok: false, error: 'agen sedang sibuk (simulasi gagal)' });
    }
    const task_id = 'T' + (nextId++);
    const item = {
      task_id,
      status: 'diproses',
      agen: payload.agen || 'agen-1',
      judul: payload.judul || '',
      prompt: payload.prompt || '',
      meta: payload.meta || {},
      dibuat: new Date().toISOString(),
      selesai_pada: new Date(Date.now() + DURASI_MS).toISOString(),
    };
    tugas.set(task_id, item);
    console.log(`[mock-kra] POST /api/tugas -> ${task_id} (${item.agen})`);
    return json(res, 202, { ok: true, task_id, status: item.status, diterima: item.dibuat });
  }

  if (url.pathname === '/api/tugas' && req.method === 'GET') {
    const status = url.searchParams.get('status');
    const agen = url.searchParams.get('agen');
    const now = Date.now();
    for (const t of tugas.values()) {
      if (t.status === 'diproses' && Date.parse(t.selesai_pada) <= now) {
        Object.assign(t, hasilUntuk(t), { status: 'selesai', selesai: new Date().toISOString() });
      }
    }
    let items = [...tugas.values()];
    if (status) items = items.filter((t) => t.status === status);
    if (agen) items = items.filter((t) => t.agen === agen);
    return json(res, 200, { ok: true, items, jumlah: items.length });
  }

  const selesai = url.pathname.match(/^\/api\/tugas\/([\w-]+)\/selesai$/);
  if (selesai && req.method === 'POST') {
    const t = tugas.get(selesai[1]);
    if (!t) return json(res, 404, { ok: false, error: 'tugas tidak ada' });
    Object.assign(t, hasilUntuk(t), { status: 'selesai', selesai: new Date().toISOString() });
    return json(res, 200, { ok: true, tugas: t });
  }

  return json(res, 404, { ok: false, error: 'endpoint tidak ada' });
});

if (require.main === module) {
  server.listen(PORT, process.env.MOCK_KRA_HOST || '0.0.0.0', () => {
    console.log(`mock KRA jalan di http://localhost:${PORT} (key: ${KEY}, gagal pertama: ${FAIL_FIRST}x)`);
  });
}

module.exports = { server };
