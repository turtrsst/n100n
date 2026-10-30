'use strict';
// Node "sheet": baca/tulis Google Sheets (service account) atau CSV lokal (untuk uji tanpa internet).
// Driver dipilih lewat config.driver: "google" (default) atau "csv".

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// ---------- CSV ----------
function parseCsvLine(line, delimiter) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === delimiter) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function escapeCsv(value, delimiter) {
  const s = value === null || value === undefined ? '' : String(value);
  if (s.includes('"') || s.includes(delimiter) || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function readCsv(file, { delimiter = ',', hasHeader = true } = {}) {
  if (!fs.existsSync(file)) return { headers: [], rows: [] };
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  if (!lines.length) return { headers: [], rows: [] };
  const headers = hasHeader ? parseCsvLine(lines[0], delimiter) : [];
  const body = hasHeader ? lines.slice(1) : lines;
  const rows = body.map((line, idx) => {
    const cells = parseCsvLine(line, delimiter);
    if (!hasHeader) return { cells, baris: idx + 1 };
    const obj = { baris: idx + 1 };
    headers.forEach((h, i) => { obj[h.trim()] = cells[i] === undefined ? '' : cells[i]; });
    return obj;
  });
  return { headers, rows };
}

function appendCsv(file, rows, { delimiter = ',', hasHeader = true, headers = [] } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const exists = fileHasContent(file);
  // header hanya diturunkan dari object row; kalau rows berupa array, pakai `headers` eksplisit
  const kolom = headers.length
    ? headers
    : rows.length && !Array.isArray(rows[0]) ? Object.keys(rows[0]) : [];
  let out = '';
  if (!exists && hasHeader && kolom.length) out += kolom.map((h) => escapeCsv(h, delimiter)).join(delimiter) + '\n';
  for (const row of rows) {
    const cells = Array.isArray(row)
      ? row
      : kolom.map((h) => (row[h] === undefined ? '' : row[h]));
    out += cells.map((c) => escapeCsv(c, delimiter)).join(delimiter) + '\n';
  }
  fs.appendFileSync(file, out);
  return { path: file, ditambahkan: rows.length };
}

function fileHasContent(file) {
  try { return fs.statSync(file).size > 0; } catch { return false; }
}

// ---------- Google Sheets (service account, tanpa dependency) ----------
const tokenCache = new Map();

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function loadServiceAccount(cfg) {
  const raw = cfg.service_account || process.env[cfg.service_account_env || 'GOOGLE_SA_JSON'] || '';
  if (!raw) throw new Error('Google service account belum diisi (config.service_account atau env GOOGLE_SA_JSON)');
  const text = raw.trim().startsWith('{') ? raw : fs.readFileSync(raw, 'utf8');
  const sa = JSON.parse(text);
  if (!sa.client_email || !sa.private_key) throw new Error('service account tidak valid: butuh client_email & private_key');
  return sa;
}

async function getAccessToken(sa, scope = 'https://www.googleapis.com/auth/spreadsheets') {
  const cacheKey = sa.client_email + '|' + scope;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.exp > Date.now() + 60000) return cached.token;

  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: sa.client_email,
    scope,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const signInput = header + '.' + claim;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signInput), sa.private_key);
  const assertion = signInput + '.' + b64url(signature);

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('google token gagal: ' + (data.error_description || data.error || res.status));
  tokenCache.set(cacheKey, { token: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 });
  return data.access_token;
}

async function googleFetch(sa, url, init = {}) {
  const token = await getAccessToken(sa);
  const res = await fetch(url, Object.assign({}, init, {
    headers: Object.assign({ Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, init.headers || {}),
    signal: AbortSignal.timeout(30000),
  }));
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error('sheets API ' + res.status + ': ' + String(typeof data === 'string' ? data : JSON.stringify(data)).slice(0, 300));
  return data;
}

function rowsToItems(values, hasHeader) {
  if (!Array.isArray(values) || !values.length) return { headers: [], items: [] };
  if (!hasHeader) return { headers: [], items: values.map((cells) => ({ cells })) };
  const headers = values[0].map((h) => String(h ?? '').trim());
  const items = values.slice(1).map((cells) => {
    const obj = {};
    headers.forEach((h, i) => { if (h) obj[h] = cells[i] === undefined ? '' : cells[i]; });
    return obj;
  });
  return { headers, items };
}

async function runSheet(cfg) {
  const driver = String(cfg.driver || (cfg.path ? 'csv' : 'google')).toLowerCase();
  const action = String(cfg.action || 'read').toLowerCase();

  if (driver === 'csv') {
    const file = String(cfg.path || '');
    if (!file) throw new Error('sheet csv: config.path kosong');
    const delimiter = String(cfg.delimiter || ',');
    const hasHeader = cfg.hasHeader !== false;
    if (action === 'read') {
      const { headers, rows } = readCsv(file, { delimiter, hasHeader });
      return { headers, items: rows };
    }
    if (action === 'append') {
      const rows = normalizeRows(cfg);
      const kolom = (cfg.headers && cfg.headers.length) ? cfg.headers : (cfg.columns || []);
      const info = appendCsv(file, rows, { delimiter, hasHeader, headers: kolom });
      return { headers: kolom, items: [{ ok: true, ...info }] };
    }
    if (action === 'write') {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const rows = normalizeRows(cfg);
      const kolom = (cfg.headers && cfg.headers.length)
        ? cfg.headers
        : (cfg.columns && cfg.columns.length)
          ? cfg.columns
          : (rows.length && !Array.isArray(rows[0]) ? Object.keys(rows[0]) : []);
      let out = kolom.length ? kolom.map((h) => escapeCsv(h, delimiter)).join(delimiter) + '\n' : '';
      for (const row of rows) {
        const cells = Array.isArray(row) ? row : kolom.map((h) => row[h] ?? '');
        out += cells.map((c) => escapeCsv(c, delimiter)).join(delimiter) + '\n';
      }
      fs.writeFileSync(file, out);
      return { headers: kolom, items: [{ ok: true, path: file, ditulis: rows.length }] };
    }
    throw new Error('sheet csv: action tidak dikenal: ' + action);
  }

  const sa = loadServiceAccount(cfg);
  const spreadsheetId = String(cfg.spreadsheetId || process.env[cfg.spreadsheetIdEnv || 'GOOGLE_SHEET_ID'] || '');
  if (!spreadsheetId) throw new Error('sheet google: spreadsheetId kosong');
  const range = String(cfg.range || 'Sheet1!A1');
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}`;
  const hasHeader = cfg.hasHeader !== false;

  if (action === 'read') {
    const data = await googleFetch(sa, `${base}/values/${encodeURIComponent(range)}?majorDimension=ROWS`);
    const { headers, items } = rowsToItems(data.values || [], hasHeader);
    return { headers, items };
  }
  if (action === 'append') {
    const rows = normalizeRows(cfg);
    const values = rows.map((r) => (Array.isArray(r) ? r : (r && r.cells) || Object.values(r)));
    const data = await googleFetch(sa, `${base}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
      method: 'POST',
      body: JSON.stringify({ values }),
    });
    return { headers: [], items: [{ ok: true, updates: data.updates || null }] };
  }
  if (action === 'update') {
    const rows = normalizeRows(cfg);
    const values = rows.map((r) => (Array.isArray(r) ? r : Object.values(r)));
    const data = await googleFetch(sa, `${base}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`, {
      method: 'PUT',
      body: JSON.stringify({ values }),
    });
    return { headers: [], items: [{ ok: true, updates: data || null }] };
  }
  throw new Error('sheet google: action tidak dikenal: ' + action);
}

// rows bisa berupa array of array, array of object, atau satu object.
function normalizeRows(cfg) {
  const raw = cfg.rows !== undefined ? cfg.rows : cfg.values !== undefined ? cfg.values : [];
  const arr = Array.isArray(raw) ? raw : [raw];
  if (cfg.columns && Array.isArray(cfg.columns) && cfg.columns.length) {
    return arr.map((r) => cfg.columns.map((c) => (r && r[c] !== undefined ? r[c] : '')));
  }
  return arr.filter((r) => r !== null && r !== undefined);
}

module.exports = { runSheet, readCsv, appendCsv, parseCsvLine, escapeCsv, getAccessToken, rowsToItems };
