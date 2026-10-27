'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
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
} = require('./lib/validation');

test('cleanString обрезает пробелы, ограничивает длину и отбрасывает пустые значения', () => {
  assert.equal(cleanString('  ООО Вектор  ', 160), 'ООО Вектор');
  assert.equal(cleanString('abcdef', 3), 'abc');
  assert.equal(cleanString('   '), null);
  assert.equal(cleanString(null), null);
  assert.equal(cleanString(42), null);
});

test('parseId принимает только целые положительные идентификаторы', () => {
  assert.equal(parseId(7), 7);
  assert.equal(parseId('42'), 42);
  assert.equal(parseId(' 15 '), 15);
  assert.equal(parseId(0), null);
  assert.equal(parseId(-1), null);
  assert.equal(parseId(1.5), null);
  assert.equal(parseId('1.5'), null);
  assert.equal(parseId('1e2'), null);
  assert.equal(parseId(true), null);
  assert.equal(parseId('abc'), null);
});

test('parseMoney принимает неотрицательные числа и округляет до копеек', () => {
  assert.equal(parseMoney(125000.5), 125000.5);
  assert.equal(parseMoney('125000.555'), 125000.56);
  assert.equal(parseMoney(0), 0);
  assert.equal(parseMoney(''), null);
  assert.equal(parseMoney('   '), null);
  assert.equal(parseMoney(null), null);
  assert.equal(parseMoney(undefined), null);
  assert.equal(parseMoney(true), null);
  assert.equal(parseMoney(-1), null);
  assert.equal(parseMoney('abc'), null);
});

test('isEmail проверяет базовый формат адреса', () => {
  assert.equal(isEmail('hello@vector.ru'), true);
  assert.equal(isEmail('bad@'), false);
  assert.equal(isEmail('bad'), false);
  assert.equal(isEmail(null), false);
});

test('validateLogin требует логин и пароль', () => {
  assert.deepEqual(validateLogin({ username: ' admin ', password: 'secret' }), {
    value: { username: 'admin', password: 'secret' },
  });
  assert.ok(validateLogin({ username: '', password: 'secret' }).error);
  assert.ok(validateLogin({ username: 'admin', password: '' }).error);
});

test('validateRegistration проверяет длину и роль', () => {
  assert.deepEqual(validateRegistration({ username: 'manager2', password: 'secret1', role: 'manager' }), {
    value: { username: 'manager2', password: 'secret1', role: 'manager' },
  });
  assert.deepEqual(validateRegistration({ username: 'user1', password: 'secret1' }).value.role, 'manager');
  assert.ok(validateRegistration({ username: 'ab', password: 'secret1' }).error);
  assert.ok(validateRegistration({ username: 'user1', password: '123' }).error);
  assert.ok(validateRegistration({ username: 'user1', password: 'secret1', role: 'owner' }).error);
});

test('validateClientPayload применяет статус по умолчанию и проверяет поля', () => {
  assert.deepEqual(validateClientPayload({
    name: '  ООО Вектор ',
    email: 'hello@vector.ru',
    status: 'vip',
  }), {
    value: {
      name: 'ООО Вектор',
      company: null,
      email: 'hello@vector.ru',
      phone: null,
      status: 'vip',
    },
  });

  assert.equal(validateClientPayload({ name: 'Клиент' }).value.status, 'active');
  assert.ok(validateClientPayload({ name: '' }).error);
  assert.ok(validateClientPayload({ name: 'Клиент', email: 'bad@' }).error);
  assert.ok(validateClientPayload({ name: 'Клиент', status: 'blocked' }).error);
  assert.deepEqual(CLIENT_STATUSES, ['active', 'inactive', 'vip']);
});

test('validateDealPayload проверяет клиента, сумму и статус', () => {
  const valid = validateDealPayload({
    client_id: '3',
    title: ' Внедрение CRM ',
    amount: '250000.50',
    status: 'in_progress',
    description: 'Первый этап',
  });

  assert.deepEqual(valid, {
    value: {
      clientId: 3,
      title: 'Внедрение CRM',
      amount: 250000.5,
      status: 'in_progress',
      description: 'Первый этап',
    },
  });

  assert.equal(validateDealPayload({ client_id: 1, title: 'Сделка', amount: 0 }).value.status, 'new');
  assert.ok(validateDealPayload({ client_id: 0, title: 'Сделка', amount: 0 }).error);
  assert.ok(validateDealPayload({ client_id: 1, title: '', amount: 0 }).error);
  assert.ok(validateDealPayload({ client_id: 1, title: 'Сделка', amount: -1 }).error);
  assert.ok(validateDealPayload({ client_id: 1, title: 'Сделка', amount: 0, status: 'done' }).error);
  assert.deepEqual(DEAL_STATUSES, ['new', 'in_progress', 'won', 'lost']);
});

test('validateNotePayload требует непустой текст', () => {
  assert.deepEqual(validateNotePayload({ body: ' Позвонить завтра ' }), {
    value: { body: 'Позвонить завтра' },
  });
  assert.ok(validateNotePayload({ body: '   ' }).error);
});
