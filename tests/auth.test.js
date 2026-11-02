'use strict';
const { setupEnv, startServer } = require('./helpers');
setupEnv();

const test = require('node:test');
const assert = require('node:assert/strict');
const { server } = require('../server');

let base = '';
test.before(async () => { base = await startServer(server); });
test.after(() => { server.closeAllConnections(); server.close(); });

async function post(path, body, cookie) {
  return fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

test('ganti password perlu sesi dan password saat ini benar', async () => {
  const denied = await post('/api/change-password', { currentPassword: 'rahasia123', newPassword: 'baru-aman-456' });
  assert.equal(denied.status, 401);

  const login = await post('/api/login', { password: 'rahasia123' });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];

  const wrongCurrent = await post('/api/change-password', {
    currentPassword: 'bukan-password', newPassword: 'baru-aman-456',
  }, cookie);
  assert.equal(wrongCurrent.status, 401);

  const changed = await post('/api/change-password', {
    currentPassword: 'rahasia123', newPassword: 'baru-aman-456',
  }, cookie);
  assert.equal(changed.status, 200);
  const renewedCookie = changed.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(base + '/api/session', { headers: { cookie: renewedCookie } })).status, 200);

  assert.equal((await post('/api/login', { password: 'rahasia123' })).status, 401);
  assert.equal((await post('/api/login', { password: 'baru-aman-456' })).status, 200);
});
