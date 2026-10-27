# Мини-CRM для учета клиентов и сделок

Одностраничное приложение на Express, PostgreSQL и Vanilla JS: JWT-авторизация, роли `admin` / `manager`, CRUD клиентов и сделок, заметки и агрегатный дашборд.

## Запуск

```bash
# 1. PostgreSQL (уже описан в docker-compose.yml)
docker compose -f source/docker-compose.yml up -d

# 2. Зависимости и запуск
npm install
node server.js
```

Откройте <http://localhost:3000>.

При старте сервер сам создает таблицы `users`, `clients`, `deals`, `notes` и демо-пользователей:

| Логин | Пароль | Права |
|---|---|---|
| `admin` | `admin123` | просмотр, создание, изменение, удаление |
| `manager` | `manager123` | просмотр и создание |

## Переменные окружения

| Переменная | По умолчанию |
|---|---|
| `PORT` | `3000` |
| `DB_HOST` | `localhost` |
| `DB_PORT` | `5432` |
| `DB_USER` | `crm_user` |
| `DB_PASSWORD` | `crm_password` |
| `DB_NAME` | `mini_crm` |
| `JWT_SECRET` | dev-значение (задайте в production) |
| `JWT_EXPIRES_IN` | `8h` |

## Тесты

```bash
npm test
```

`test.js` поднимает сервер на свободном порту и проверяет авторизацию, разграничение прав и агрегатный роут `/api/dashboard`.

## Основные API

- `POST /api/auth/login` — получить JWT.
- `GET /api/dashboard` — суммы и количество сделок по статусам (`SUM`, `COUNT`, `GROUP BY`).
- `GET|POST /api/clients`, `GET|PUT|DELETE /api/clients/:id`.
- `GET|POST /api/deals`, `GET|PUT|DELETE /api/deals/:id`.
- `GET|POST /api/clients/:id/notes`, `DELETE /api/notes/:id`.

Защищенные роуты требуют заголовок `Authorization: Bearer <token>`.
