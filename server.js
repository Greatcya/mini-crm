'use strict';

const path = require('path');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool, types } = require('pg');

// NUMERIC -> number, чтобы суммы в JSON были числами, а не строками.
types.setTypeParser(1700, (value) => (value === null ? null : Number(value)));

const PORT = Number(process.env.PORT) || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'mini-crm-dev-secret-change-me';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '8h';

const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'crm_user',
  password: process.env.DB_PASSWORD || 'crm_password',
  database: process.env.DB_NAME || 'mini_crm',
  max: Number(process.env.DB_POOL_MAX) || 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
};

const pool = new Pool(dbConfig);
pool.on('error', (error) => {
  audit('db.pool_error', { level: 'ERROR', message: error.message });
});

function audit(event, details = {}) {
  const { level = 'INFO', ...rest } = details;
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    level,
    scope: 'audit',
    event,
    ...rest,
  }));
}

function appLog(level, message, details = {}) {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    level,
    scope: 'app',
    message,
    ...details,
  }));
}

const TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(60) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'manager'
      CHECK (role IN ('admin', 'manager')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS clients (
    id SERIAL PRIMARY KEY,
    name VARCHAR(160) NOT NULL,
    company VARCHAR(160),
    email VARCHAR(160),
    phone VARCHAR(60),
    status VARCHAR(20) NOT NULL DEFAULT 'active'
      CHECK (status IN ('active', 'inactive', 'vip')),
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS deals (
    id SERIAL PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    title VARCHAR(200) NOT NULL,
    amount NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
    status VARCHAR(20) NOT NULL DEFAULT 'new'
      CHECK (status IN ('new', 'in_progress', 'won', 'lost')),
    description TEXT,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS notes (
    id SERIAL PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_clients_status ON clients(status);
  CREATE INDEX IF NOT EXISTS idx_deals_status ON deals(status);
  CREATE INDEX IF NOT EXISTS idx_deals_client_id ON deals(client_id);
  CREATE INDEX IF NOT EXISTS idx_notes_client_id ON notes(client_id);
`;

async function initializeDatabase() {
  const startedAt = Date.now();
  audit('db.connecting', {
    host: dbConfig.host,
    port: dbConfig.port,
    database: dbConfig.database,
    user: dbConfig.user,
  });

  await pool.query('SELECT 1');
  audit('db.connected', { latency_ms: Date.now() - startedAt });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(TABLES_SQL);

    const adminHash = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'admin123', 10);
    const managerHash = await bcrypt.hash(process.env.MANAGER_PASSWORD || 'manager123', 10);

    await client.query(
      `INSERT INTO users (username, password_hash, role)
       VALUES ($1, $2, 'admin')
       ON CONFLICT (username) DO NOTHING`,
      ['admin', adminHash]
    );
    await client.query(
      `INSERT INTO users (username, password_hash, role)
       VALUES ($1, $2, 'manager')
       ON CONFLICT (username) DO NOTHING`,
      ['manager', managerHash]
    );

    await client.query('COMMIT');
    audit('db.schema_ready', { tables: ['users', 'clients', 'deals', 'notes'] });
    audit('db.seed_ready', { users: ['admin', 'manager'] });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));

app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on('finish', () => {
    appLog('INFO', 'http.request', {
      method: req.method,
      path: req.originalUrl.split('?')[0],
      status: res.statusCode,
      duration_ms: Date.now() - startedAt,
      ip: req.ip,
      user: req.user ? req.user.username : null,
    });
  });
  next();
});

function issueToken(user) {
  return jwt.sign(
    { sub: String(user.id), username: user.username, role: user.role },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

function publicUser(user) {
  return { id: user.id, username: user.username, role: user.role };
}

function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Требуется Bearer JWT-токен' } });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (!payload || !['admin', 'manager'].includes(payload.role)) {
      throw new Error('invalid role');
    }
    req.user = {
      id: Number(payload.sub),
      username: payload.username,
      role: payload.role,
    };
    return next();
  } catch (error) {
    audit('auth.token_rejected', { level: 'WARN', ip: req.ip, reason: error.message });
    return res.status(401).json({ error: { code: 'INVALID_TOKEN', message: 'Токен недействителен или истек' } });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Требуется авторизация' } });
    }
    if (!roles.includes(req.user.role)) {
      audit('auth.forbidden', {
        level: 'WARN',
        user: req.user.username,
        role: req.user.role,
        method: req.method,
        path: req.originalUrl.split('?')[0],
      });
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Недостаточно прав для операции' } });
    }
    return next();
  };
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function cleanString(value, maxLength) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength);
}

function parseId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function parseMoney(value) {
  if (value === '' || value === null || value === undefined || typeof value === 'boolean') return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) / 100 : null;
}

const DEAL_STATUSES = ['new', 'in_progress', 'won', 'lost'];
const CLIENT_STATUSES = ['active', 'inactive', 'vip'];

app.get('/api/health', asyncHandler(async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ status: 'ok', database: 'up', timestamp: new Date().toISOString() });
}));

app.post('/api/auth/login', asyncHandler(async (req, res) => {
  const username = cleanString(req.body && req.body.username, 60);
  const password = typeof (req.body && req.body.password) === 'string' ? req.body.password : '';

  if (!username || !password) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Укажите username и password' } });
  }

  const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
  const user = result.rows[0];
  const valid = user ? await bcrypt.compare(password, user.password_hash) : false;

  if (!valid) {
    audit('auth.login_failed', { level: 'WARN', username, ip: req.ip });
    return res.status(401).json({ error: { code: 'BAD_CREDENTIALS', message: 'Неверный логин или пароль' } });
  }

  const token = issueToken(user);
  audit('auth.login_success', { user: user.username, role: user.role, ip: req.ip });
  res.json({ token, token_type: 'Bearer', expires_in: JWT_EXPIRES_IN, user: publicUser(user) });
}));

app.get('/api/auth/me', authenticate, asyncHandler(async (req, res) => {
  const result = await pool.query('SELECT id, username, role, created_at FROM users WHERE id = $1', [req.user.id]);
  if (!result.rows[0]) {
    return res.status(401).json({ error: { code: 'USER_GONE', message: 'Пользователь не найден' } });
  }
  res.json({ user: result.rows[0] });
}));

app.post('/api/auth/register', authenticate, requireRole('admin'), asyncHandler(async (req, res) => {
  const username = cleanString(req.body && req.body.username, 60);
  const password = typeof (req.body && req.body.password) === 'string' ? req.body.password : '';
  const role = cleanString(req.body && req.body.role, 20) || 'manager';

  if (!username || username.length < 3 || password.length < 6 || !['admin', 'manager'].includes(role)) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'username >= 3, password >= 6, role = admin|manager' },
    });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const result = await pool.query(
    `INSERT INTO users (username, password_hash, role)
     VALUES ($1, $2, $3)
     RETURNING id, username, role, created_at`,
    [username, passwordHash, role]
  );

  audit('user.created', { actor: req.user.username, user: username, role });
  res.status(201).json({ user: result.rows[0] });
}));

app.get('/api/users', authenticate, requireRole('admin'), asyncHandler(async (req, res) => {
  const result = await pool.query('SELECT id, username, role, created_at FROM users ORDER BY id');
  res.json({ data: result.rows });
}));

app.get('/api/clients', authenticate, asyncHandler(async (req, res) => {
  const params = [];
  const where = [];

  if (req.query.status) {
    if (!CLIENT_STATUSES.includes(req.query.status)) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Недопустимый статус клиента' } });
    }
    params.push(req.query.status);
    where.push(`c.status = $${params.length}`);
  }

  const search = cleanString(req.query.search, 100);
  if (search) {
    params.push(`%${search}%`);
    where.push(`(c.name ILIKE $${params.length} OR c.company ILIKE $${params.length} OR c.email ILIKE $${params.length})`);
  }

  const result = await pool.query(
    `SELECT c.*, u.username AS created_by_username,
            (SELECT COUNT(*)::int FROM deals d WHERE d.client_id = c.id) AS deals_count,
            (SELECT COALESCE(SUM(d.amount), 0) FROM deals d WHERE d.client_id = c.id) AS deals_total
     FROM clients c
     LEFT JOIN users u ON u.id = c.created_by
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY c.created_at DESC, c.id DESC`,
    params
  );

  res.json({ data: result.rows });
}));

app.get('/api/clients/:id', authenticate, asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Некорректный id' } });
  }

  const result = await pool.query(
    `SELECT c.*, u.username AS created_by_username
     FROM clients c LEFT JOIN users u ON u.id = c.created_by
     WHERE c.id = $1`,
    [id]
  );
  if (!result.rows[0]) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Клиент не найден' } });
  }

  const notes = await pool.query(
    `SELECT n.*, u.username AS created_by_username
     FROM notes n LEFT JOIN users u ON u.id = n.created_by
     WHERE n.client_id = $1 ORDER BY n.created_at DESC`,
    [id]
  );

  res.json({ data: { ...result.rows[0], notes: notes.rows } });
}));

app.post('/api/clients', authenticate, requireRole('admin', 'manager'), asyncHandler(async (req, res) => {
  const name = cleanString(req.body && req.body.name, 160);
  const company = cleanString(req.body && req.body.company, 160);
  const email = cleanString(req.body && req.body.email, 160);
  const phone = cleanString(req.body && req.body.phone, 60);
  const status = cleanString(req.body && req.body.status, 20) || 'active';

  if (!name || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) || !CLIENT_STATUSES.includes(status)) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'Проверьте name, email и status' },
    });
  }

  const result = await pool.query(
    `INSERT INTO clients (name, company, email, phone, status, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [name, company, email, phone, status, req.user.id]
  );

  audit('client.created', { actor: req.user.username, client_id: result.rows[0].id, name });
  res.status(201).json({ data: result.rows[0] });
}));

app.put('/api/clients/:id', authenticate, requireRole('admin'), asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Некорректный id' } });
  }

  const name = cleanString(req.body && req.body.name, 160);
  const company = cleanString(req.body && req.body.company, 160);
  const email = cleanString(req.body && req.body.email, 160);
  const phone = cleanString(req.body && req.body.phone, 60);
  const status = cleanString(req.body && req.body.status, 20) || 'active';

  if (!name || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) || !CLIENT_STATUSES.includes(status)) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'Проверьте name, email и status' },
    });
  }

  const result = await pool.query(
    `UPDATE clients
     SET name = $1, company = $2, email = $3, phone = $4, status = $5, updated_at = NOW()
     WHERE id = $6
     RETURNING *`,
    [name, company, email, phone, status, id]
  );
  if (!result.rows[0]) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Клиент не найден' } });
  }

  audit('client.updated', { actor: req.user.username, client_id: id });
  res.json({ data: result.rows[0] });
}));

app.delete('/api/clients/:id', authenticate, requireRole('admin'), asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Некорректный id' } });
  }

  const result = await pool.query('DELETE FROM clients WHERE id = $1 RETURNING id, name', [id]);
  if (!result.rows[0]) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Клиент не найден' } });
  }

  audit('client.deleted', { level: 'WARN', actor: req.user.username, client_id: id, name: result.rows[0].name });
  res.json({ data: { id } });
}));

app.get('/api/deals', authenticate, asyncHandler(async (req, res) => {
  const params = [];
  const where = [];

  if (req.query.status) {
    if (!DEAL_STATUSES.includes(req.query.status)) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Недопустимый статус сделки' } });
    }
    params.push(req.query.status);
    where.push(`d.status = $${params.length}`);
  }

  if (req.query.client_id) {
    const clientId = parseId(req.query.client_id);
    if (!clientId) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Некорректный client_id' } });
    }
    params.push(clientId);
    where.push(`d.client_id = $${params.length}`);
  }

  const search = cleanString(req.query.search, 100);
  if (search) {
    params.push(`%${search}%`);
    where.push(`(d.title ILIKE $${params.length} OR c.name ILIKE $${params.length})`);
  }

  const result = await pool.query(
    `SELECT d.*, c.name AS client_name, c.company AS client_company, u.username AS created_by_username
     FROM deals d
     JOIN clients c ON c.id = d.client_id
     LEFT JOIN users u ON u.id = d.created_by
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY d.created_at DESC, d.id DESC`,
    params
  );

  res.json({ data: result.rows });
}));

app.get('/api/deals/:id', authenticate, asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Некорректный id' } });
  }

  const result = await pool.query(
    `SELECT d.*, c.name AS client_name, c.company AS client_company, u.username AS created_by_username
     FROM deals d
     JOIN clients c ON c.id = d.client_id
     LEFT JOIN users u ON u.id = d.created_by
     WHERE d.id = $1`,
    [id]
  );
  if (!result.rows[0]) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Сделка не найдена' } });
  }

  res.json({ data: result.rows[0] });
}));

app.post('/api/deals', authenticate, requireRole('admin', 'manager'), asyncHandler(async (req, res) => {
  const clientId = parseId(req.body && req.body.client_id);
  const title = cleanString(req.body && req.body.title, 200);
  const amount = parseMoney(req.body && req.body.amount);
  const status = cleanString(req.body && req.body.status, 20) || 'new';
  const description = cleanString(req.body && req.body.description, 4000);

  if (!clientId || !title || amount === null || !DEAL_STATUSES.includes(status)) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'Проверьте client_id, title, amount и status' },
    });
  }

  const clientExists = await pool.query('SELECT 1 FROM clients WHERE id = $1', [clientId]);
  if (!clientExists.rows[0]) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Клиент не найден' } });
  }

  const result = await pool.query(
    `INSERT INTO deals (client_id, title, amount, status, description, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [clientId, title, amount, status, description, req.user.id]
  );

  audit('deal.created', {
    actor: req.user.username,
    deal_id: result.rows[0].id,
    client_id: clientId,
    amount,
    status,
  });
  res.status(201).json({ data: result.rows[0] });
}));

app.put('/api/deals/:id', authenticate, requireRole('admin'), asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Некорректный id' } });
  }

  const clientId = parseId(req.body && req.body.client_id);
  const title = cleanString(req.body && req.body.title, 200);
  const amount = parseMoney(req.body && req.body.amount);
  const status = cleanString(req.body && req.body.status, 20) || 'new';
  const description = cleanString(req.body && req.body.description, 4000);

  if (!clientId || !title || amount === null || !DEAL_STATUSES.includes(status)) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'Проверьте client_id, title, amount и status' },
    });
  }

  const clientExists = await pool.query('SELECT 1 FROM clients WHERE id = $1', [clientId]);
  if (!clientExists.rows[0]) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Клиент не найден' } });
  }

  const result = await pool.query(
    `UPDATE deals
     SET client_id = $1, title = $2, amount = $3, status = $4, description = $5, updated_at = NOW()
     WHERE id = $6
     RETURNING *`,
    [clientId, title, amount, status, description, id]
  );
  if (!result.rows[0]) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Сделка не найдена' } });
  }

  audit('deal.updated', { actor: req.user.username, deal_id: id, status, amount });
  res.json({ data: result.rows[0] });
}));

app.delete('/api/deals/:id', authenticate, requireRole('admin'), asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Некорректный id' } });
  }

  const result = await pool.query('DELETE FROM deals WHERE id = $1 RETURNING id, title, amount', [id]);
  if (!result.rows[0]) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Сделка не найдена' } });
  }

  audit('deal.deleted', { level: 'WARN', actor: req.user.username, deal_id: id, amount: result.rows[0].amount });
  res.json({ data: { id } });
}));

app.get('/api/clients/:id/notes', authenticate, asyncHandler(async (req, res) => {
  const clientId = parseId(req.params.id);
  if (!clientId) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Некорректный id' } });
  }

  const result = await pool.query(
    `SELECT n.*, u.username AS created_by_username
     FROM notes n LEFT JOIN users u ON u.id = n.created_by
     WHERE n.client_id = $1 ORDER BY n.created_at DESC`,
    [clientId]
  );

  res.json({ data: result.rows });
}));

app.post('/api/clients/:id/notes', authenticate, requireRole('admin', 'manager'), asyncHandler(async (req, res) => {
  const clientId = parseId(req.params.id);
  const body = cleanString(req.body && req.body.body, 4000);
  if (!clientId || !body) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Укажите текст заметки' } });
  }

  const clientExists = await pool.query('SELECT 1 FROM clients WHERE id = $1', [clientId]);
  if (!clientExists.rows[0]) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Клиент не найден' } });
  }

  const result = await pool.query(
    `INSERT INTO notes (client_id, body, created_by)
     VALUES ($1, $2, $3) RETURNING *`,
    [clientId, body, req.user.id]
  );

  audit('note.created', { actor: req.user.username, client_id: clientId, note_id: result.rows[0].id });
  res.status(201).json({ data: result.rows[0] });
}));

app.delete('/api/notes/:id', authenticate, requireRole('admin'), asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Некорректный id' } });
  }

  const result = await pool.query('DELETE FROM notes WHERE id = $1 RETURNING id, client_id', [id]);
  if (!result.rows[0]) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Заметка не найдена' } });
  }

  audit('note.deleted', { level: 'WARN', actor: req.user.username, note_id: id });
  res.json({ data: { id } });
}));

// Агрегатный SQL для дашборда: SUM + COUNT + GROUP BY по статусу сделки.
app.get('/api/dashboard', authenticate, asyncHandler(async (req, res) => {
  const byStatusResult = await pool.query(
    `SELECT status,
            COUNT(*)::int AS deals_count,
            COALESCE(SUM(amount), 0) AS total_amount
     FROM deals
     GROUP BY status
     ORDER BY status`
  );

  const totalsResult = await pool.query(
    `SELECT COUNT(*)::int AS deals_count,
            COALESCE(SUM(amount), 0) AS total_amount
     FROM deals`
  );

  const clientsResult = await pool.query(
    `SELECT COUNT(*)::int AS clients_count,
            COUNT(*) FILTER (WHERE status = 'vip')::int AS vip_clients_count
     FROM clients`
  );

  const byStatus = byStatusResult.rows.map((row) => ({
    status: row.status,
    deals_count: row.deals_count,
    total_amount: row.total_amount,
  }));

  audit('dashboard.read', { actor: req.user.username, groups: byStatus.length });
  res.json({
    data: {
      totals: totalsResult.rows[0],
      clients: clientsResult.rows[0],
      by_status: byStatus,
      generated_at: new Date().toISOString(),
    },
  });
}));

app.use(express.static(path.join(__dirname, 'public')));

app.use('/api', (req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'API-маршрут не найден' } });
});

app.use((error, req, res, next) => {
  const pgCode = error && error.code;
  let status = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'Внутренняя ошибка сервера';

  if (error && error.type === 'entity.parse.failed') {
    status = 400;
    code = 'BAD_JSON';
    message = 'Некорректный JSON в теле запроса';
  } else if (pgCode === '23505') {
    status = 409;
    code = 'CONFLICT';
    message = 'Запись с такими данными уже существует';
  } else if (pgCode === '23503') {
    status = 400;
    code = 'FK_VIOLATION';
    message = 'Связанная запись не найдена';
  } else if (pgCode === '23514' || pgCode === '22P02') {
    status = 400;
    code = 'VALIDATION_ERROR';
    message = 'Данные не прошли проверку';
  }

  audit('request.failed', {
    level: 'ERROR',
    method: req.method,
    path: req.originalUrl.split('?')[0],
    status,
    code,
    message: error.message,
  });

  res.status(status).json({ error: { code, message } });
});

async function startServer() {
  await initializeDatabase();
  return new Promise((resolve, reject) => {
    const server = app.listen(PORT, () => {
      audit('server.started', { port: PORT, pid: process.pid });
      console.log(`Mini-CRM доступна на http://localhost:${PORT}`);
      resolve(server);
    });
    server.on('error', reject);
  });
}

async function shutdown(signal) {
  audit('server.stopping', { signal });
  await pool.end().catch(() => {});
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

if (require.main === module) {
  startServer().catch((error) => {
    audit('server.start_failed', { level: 'ERROR', message: error.message, stack: error.stack });
    process.exit(1);
  });
}

module.exports = { app, pool, initializeDatabase, startServer };
