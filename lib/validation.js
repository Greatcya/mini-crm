'use strict';

const USER_ROLES = Object.freeze(['admin', 'manager']);
const DEAL_STATUSES = Object.freeze(['new', 'in_progress', 'won', 'lost']);
const CLIENT_STATUSES = Object.freeze(['active', 'inactive', 'vip']);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function cleanString(value, maxLength = 255) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength);
}

function parseId(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function parseMoney(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return null;
  return Math.round(amount * 100) / 100;
}

function isEmail(value) {
  return typeof value === 'string' && EMAIL_RE.test(value);
}

function validateLogin(body = {}) {
  const username = cleanString(body.username, 60);
  const password = typeof body.password === 'string' ? body.password : '';
  if (!username || !password) {
    return { error: 'Укажите username и password' };
  }
  return { value: { username, password } };
}

function validateRegistration(body = {}) {
  const username = cleanString(body.username, 60);
  const password = typeof body.password === 'string' ? body.password : '';
  const role = cleanString(body.role, 20) || 'manager';

  if (!username || username.length < 3 || password.length < 6 || !USER_ROLES.includes(role)) {
    return { error: 'username >= 3, password >= 6, role = admin|manager' };
  }
  return { value: { username, password, role } };
}

function validateClientPayload(body = {}) {
  const name = cleanString(body.name, 160);
  const company = cleanString(body.company, 160);
  const email = cleanString(body.email, 160);
  const phone = cleanString(body.phone, 60);
  const status = cleanString(body.status, 20) || 'active';

  if (!name) {
    return { error: 'Укажите название или имя клиента' };
  }
  if (email && !isEmail(email)) {
    return { error: 'Укажите корректный email' };
  }
  if (!CLIENT_STATUSES.includes(status)) {
    return { error: 'Недопустимый статус клиента' };
  }

  return { value: { name, company, email, phone, status } };
}

function validateDealPayload(body = {}) {
  const clientId = parseId(body.client_id);
  const title = cleanString(body.title, 200);
  const amount = parseMoney(body.amount);
  const status = cleanString(body.status, 20) || 'new';
  const description = cleanString(body.description, 4000);

  if (!clientId) {
    return { error: 'Укажите корректного клиента' };
  }
  if (!title) {
    return { error: 'Укажите название сделки' };
  }
  if (amount === null) {
    return { error: 'Укажите корректную сумму' };
  }
  if (!DEAL_STATUSES.includes(status)) {
    return { error: 'Недопустимый статус сделки' };
  }

  return { value: { clientId, title, amount, status, description } };
}

function validateNotePayload(body = {}) {
  const text = cleanString(body.body, 4000);
  if (!text) {
    return { error: 'Укажите текст заметки' };
  }
  return { value: { body: text } };
}

module.exports = {
  USER_ROLES,
  DEAL_STATUSES,
  CLIENT_STATUSES,
  cleanString,
  parseId,
  parseMoney,
  isEmail,
  validateLogin,
  validateRegistration,
  validateClientPayload,
  validateDealPayload,
  validateNotePayload,
};
