'use strict';
const { setupEnv, startServer } = require('./helpers');
setupEnv();
process.env.APP_PASSWORD = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const { server } = require('../server');

let base = '';
test.before(async () => { base = await startServer(server); });
test.after(() => { server.closeAllConnections(); server.close(); });

test('password default pertama kali adalah 123456', async () => {
  const initial = await fetch(base + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: '123456' }),
  });
  assert.equal(initial.status, 200);
});
