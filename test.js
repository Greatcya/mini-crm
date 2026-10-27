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
  return { adminToken: adminSession.token, managerToken: managerSession.token };
}

async function testCrudAndNotes(baseUrl, adminToken, managerToken) {
  const suffix = Date.now();
  const clientName = `API Test ${suffix}`;
  const dealTitle = `Deal ${suffix}`;
  let clientId = null;
  let dealId = null;
  let noteId = null;
  let managerNoteId = null;

  try {
    const badClient = await request(baseUrl, '/api/clients', {
      method: 'POST',
      token: adminToken,
      body: { name: 'Bad email', email: 'bad@' }
    });
    assert.equal(badClient.status, 400, 'некорректный email должен отклоняться');

    const createdClient = await request(baseUrl, '/api/clients', {
      method: 'POST',
      token: adminToken,
      body: {
        name: clientName,
        company: 'Integration Lab',
        email: `qa-${suffix}@example.com`,
        phone: '+7 900 000-00-00',
        status: 'active'
      }
    });
    assert.equal(createdClient.status, 201, 'клиент должен создаваться');
    clientId = createdClient.body.data.id;

    const updatedClient = await request(baseUrl, `/api/clients/${clientId}`, {
      method: 'PUT',
      token: adminToken,
      body: {
        name: clientName,
        company: 'Integration Lab',
        email: `qa-${suffix}@example.com`,
        phone: '+7 900 000-00-01',
        status: 'vip'
      }
    });
    assert.equal(updatedClient.status, 200, 'клиент должен обновляться');
    assert.equal(updatedClient.body.data.status, 'vip');

    const clientSearch = await request(baseUrl, `/api/clients?search=${encodeURIComponent(clientName)}`, {
      token: adminToken
    });
    assert.equal(clientSearch.status, 200);
    assert.ok(clientSearch.body.data.some((client) => client.id === clientId), 'поиск должен находить клиента');

    const badDeal = await request(baseUrl, '/api/deals', {
      method: 'POST',
      token: adminToken,
      body: { client_id: clientId, title: 'Bad deal', amount: -10, status: 'new' }
    });
    assert.equal(badDeal.status, 400, 'отрицательная сумма должна отклоняться');

    const createdDeal = await request(baseUrl, '/api/deals', {
      method: 'POST',
      token: adminToken,
      body: {
        client_id: clientId,
        title: dealTitle,
        amount: 12345.67,
        status: 'new',
        description: 'Проверка CRUD'
      }
    });
    assert.equal(createdDeal.status, 201, 'сделка должна создаваться');
    dealId = createdDeal.body.data.id;

    const movedDeal = await request(baseUrl, `/api/deals/${dealId}`, {
      method: 'PUT',
      token: adminToken,
      body: {
        client_id: clientId,
        title: dealTitle,
        amount: 12345.67,
        status: 'won',
        description: 'Статус изменён'
      }
    });
    assert.equal(movedDeal.status, 200, 'сделка должна обновляться');
    assert.equal(movedDeal.body.data.status, 'won', 'статус сделки должен меняться');

    const dealSearch = await request(baseUrl, `/api/deals?search=${encodeURIComponent(dealTitle)}`, {
      token: managerToken
    });
    assert.equal(dealSearch.status, 200);
    assert.ok(dealSearch.body.data.some((deal) => deal.id === dealId), 'поиск должен находить сделку');

    const managerUpdate = await request(baseUrl, `/api/deals/${dealId}`, {
      method: 'PUT',
      token: managerToken,
      body: {
        client_id: clientId,
        title: dealTitle,
        amount: 12345.67,
        status: 'lost',
        description: 'Менеджер не должен менять'
      }
    });
    assert.equal(managerUpdate.status, 403, 'менеджер не должен редактировать сделки');

    const createdNote = await request(baseUrl, `/api/clients/${clientId}/notes`, {
      method: 'POST',
      token: adminToken,
      body: { body: 'Первичная заметка' }
    });
    assert.equal(createdNote.status, 201, 'заметка должна создаваться');
    noteId = createdNote.body.data.id;

    const updatedNote = await request(baseUrl, `/api/notes/${noteId}`, {
      method: 'PUT',
      token: adminToken,
      body: { body: 'Обновлённая заметка' }
    });
    assert.equal(updatedNote.status, 200, 'заметка должна обновляться');
    assert.equal(updatedNote.body.data.body, 'Обновлённая заметка');

    const managerNote = await request(baseUrl, `/api/clients/${clientId}/notes`, {
      method: 'POST',
      token: managerToken,
      body: { body: 'Комментарий менеджера' }
    });
    assert.equal(managerNote.status, 201, 'менеджер должен добавлять заметки');
    managerNoteId = managerNote.body.data.id;

    const managerDeleteNote = await request(baseUrl, `/api/notes/${managerNoteId}`, {
      method: 'DELETE',
      token: managerToken
    });
    assert.equal(managerDeleteNote.status, 403, 'менеджер не должен удалять заметки');

    const notes = await request(baseUrl, `/api/clients/${clientId}/notes`, { token: adminToken });
    assert.equal(notes.status, 200);
    assert.equal(notes.body.data.length, 2, 'обе заметки должны быть в списке');

    const deletedNote = await request(baseUrl, `/api/notes/${managerNoteId}`, {
      method: 'DELETE',
      token: adminToken
    });
    assert.equal(deletedNote.status, 200);
    managerNoteId = null;

    console.log('  ✓ CRUD клиента/сделки, смена статуса, поиск и заметки; права менеджера ограничены');
  } finally {
    if (managerNoteId) {
      await request(baseUrl, `/api/notes/${managerNoteId}`, { method: 'DELETE', token: adminToken }).catch(() => {});
    }
    if (dealId) {
      await request(baseUrl, `/api/deals/${dealId}`, { method: 'DELETE', token: adminToken }).catch(() => {});
    }
    if (clientId) {
      await request(baseUrl, `/api/clients/${clientId}`, { method: 'DELETE', token: adminToken }).catch(() => {});
    }
  }
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
    const tokens = await testAuthentication(baseUrl);

    console.log('\nТест 2 — CRUD, статусы, поиск и заметки');
    await testCrudAndNotes(baseUrl, tokens.adminToken, tokens.managerToken);

    console.log('\nТест 3 — агрегатные данные дашборда');
    await testDashboard(baseUrl, tokens.adminToken);

    console.log('\nИтог: 3/3 теста пройдены.');
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
