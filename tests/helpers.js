'use strict';
// Helper test: siapkan env terisolasi SEBELUM modul server/store di-require.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function setupEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'n100n-test-'));
  process.env.APP_DATA_DIR = path.join(tmp, 'data');
  process.env.APP_PASSWORD = 'rahasia123';
  process.env.APP_API_TOKEN = 'tok-test';
  process.env.APP_SEED = '0';
  process.env.CONTOH_SHEET_DRIVER = 'csv';
  process.env.CONTOH_SUMBER_CSV = path.join(tmp, 'sumber.csv');
  process.env.CONTOH_HASIL_CSV = path.join(tmp, 'hasil.csv');
  process.env.MOCK_KRA_KEY = 'dev-kra-key';
  process.env.KRA_API_KEY = 'dev-kra-key';
  return tmp;
}

async function startServer(server) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return 'http://127.0.0.1:' + server.address().port;
}

async function call(base, method, url, { body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['x-api-key'] = token;
  const res = await fetch(base + url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}

module.exports = { setupEnv, startServer, call };
