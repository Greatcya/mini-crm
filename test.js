'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = __dirname;
const ADMIN = {
  username: process.env.TEST_ADMIN_USER || 'admin',
  password: process.env.TEST_ADMIN_PASSWORD || 'admin123'
};
const MANAGER = {
  username: process.env.TEST_MANAGER_USER || 'manager',
  password: process.env.TEST_MANAGER_PASSWORD || 'manager123'
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

async function waitForServer(baseUrl, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
      lastError = new Error(`health status ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(400);
  }
  throw new Error(`Сервер не запустился за ${timeoutMs} мс: ${lastError ? lastError.message : 'нет ответа'}`);
}

async function request(baseUrl, route, options = {}) {
  const headers = { Accept: 'application/json', ...(options.headers || {}) };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.token) headers.Authorization = `Bearer ${options.token}`;

  const response = await fetch(`${baseUrl}${route}`, {
    method: options.method || 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });

  let payload = null;
  try { payload = await response.json(); } catch (error) { payload = null; }
  return { status: response.status, body: payload };
}

async function login(baseUrl, credentials) {
  const response = await request(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: credentials
  });
  assert.equal(response.status, 200, `логин ${credentials.username} должен вернуть 200`);
  assert.ok(response.body && typeof response.body.token === 'string' && response.body.token.length > 20,
    'ответ логина должен содержать JWT');
  assert.equal(response.body.token_type, 'Bearer');
  assert.equal(response.body.user.username, credentials.username);
  return response.body;
}

async function testAuthentication(baseUrl) {
  const unauthorized = await request(baseUrl, '/api/auth/me');
  assert.equal(unauthorized.status, 401, 'защищенный роут без токена должен вернуть 401');

  const badLogin = await request(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { username: ADMIN.username, password: 'definitely-wrong-password' }
  });
  assert.equal(badLogin.status, 401, 'неверный пароль должен вернуть 401');

  const adminSession = await login(baseUrl, ADMIN);
  assert.equal(adminSession.user.role, 'admin');

  const me = await request(baseUrl, '/api/auth/me', { token: adminSession.token });
  assert.equal(me.status, 200, 'JWT должен открывать /api/auth/me');
  assert.equal(me.body.user.username, ADMIN.username);
  assert.equal(me.body.user.role, 'admin');

  const managerSession = await login(baseUrl, MANAGER);
  assert.equal(managerSession.user.role, 'manager');

  const managerRead = await request(baseUrl, '/api/deals', { token: managerSession.token });
  assert.equal(managerRead.status, 200, 'менеджер должен просматривать сделки');

  const managerDelete = await request(baseUrl, '/api/deals/999999', {
    method: 'DELETE',
    token: managerSession.token
  });
  assert.equal(managerDelete.status, 403, 'менеджер не должен удалять сделки');

  console.log('  ✓ JWT-авторизация, /api/auth/me и роли admin/manager');
  return adminSession.token;
}

async function testDashboard(baseUrl, token) {
  const unauthorized = await request(baseUrl, '/api/dashboard');
  assert.equal(unauthorized.status, 401, 'дашборд без токена должен вернуть 401');

  const response = await request(baseUrl, '/api/dashboard', { token });
  assert.equal(response.status, 200, 'дашборд должен вернуть 200');
  assert.ok(response.body && response.body.data, 'ответ должен содержать data');

  const { totals, clients, by_status: byStatus } = response.body.data;
  assert.ok(totals, 'в ответе должны быть totals');
  assert.equal(typeof totals.total_amount, 'number', 'total_amount должен быть числом');
  assert.equal(typeof totals.deals_count, 'number', 'deals_count должен быть числом');
  assert.ok(totals.total_amount >= 0, 'сумма не может быть отрицательной');
  assert.ok(Array.isArray(byStatus), 'by_status должен быть массивом');
  assert.ok(clients && typeof clients.clients_count === 'number');

  const knownStatuses = new Set(['new', 'in_progress', 'won', 'lost']);
  for (const group of byStatus) {
    assert.ok(knownStatuses.has(group.status), `неизвестный статус: ${group.status}`);
    assert.equal(typeof group.deals_count, 'number');
    assert.equal(typeof group.total_amount, 'number');
    assert.ok(group.deals_count >= 0);
    assert.ok(group.total_amount >= 0);
  }

  const groupedCount = byStatus.reduce((sum, group) => sum + group.deals_count, 0);
  const groupedAmount = byStatus.reduce((sum, group) => sum + group.total_amount, 0);
  assert.equal(groupedCount, totals.deals_count, 'SUM(COUNT) по группам должен совпадать с общим COUNT');
  assert.ok(Math.abs(groupedAmount - totals.total_amount) < 0.01,
    'SUM по группам должен совпадать с общей суммой');

  console.log(`  ✓ /api/dashboard: ${totals.deals_count} сделок, ${totals.total_amount} ₽, ${byStatus.length} групп`);
}

async function main() {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`Интеграционные тесты Mini-CRM · ${baseUrl}`);

  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      JWT_SECRET: process.env.JWT_SECRET || 'integration-test-secret',
      ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'admin123',
      MANAGER_PASSWORD: process.env.MANAGER_PASSWORD || 'manager123'
    },
    stdio: ['ignore', 'ignore', 'inherit'],
    windowsHide: true
  });

  let startupError = null;
  child.once('error', (error) => { startupError = error; });
  child.once('exit', (code, signal) => {
    if (code && code !== 0) startupError = new Error(`server.js завершился с кодом ${code}${signal ? ` (${signal})` : ''}`);
  });

  try {
    await waitForServer(baseUrl);
    if (startupError) throw startupError;

    console.log('\nТест 1 — авторизация и разграничение прав');
    const token = await testAuthentication(baseUrl);

    console.log('\nТест 2 — агрегатные данные дашборда');
    await testDashboard(baseUrl, token);

    console.log('\nИтог: 2/2 теста пройдены.');
  } finally {
    if (!child.killed) child.kill('SIGTERM');
    await delay(350);
  }
}

main().catch((error) => {
  console.error('\nТесты не пройдены:', error.message);
  if (error.stack) console.error(error.stack.split('\n').slice(1, 4).join('\n'));
  process.exitCode = 1;
});
