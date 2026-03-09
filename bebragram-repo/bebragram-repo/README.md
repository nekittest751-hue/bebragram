# Бебраграмм 🦫

Телеграм-подобный чат с бобровым интерфейсом.

## Что внутри

- фронт без сборщика: `public/index.html`, `public/styles.css`, `public/app.js`
- сервер на `Express`
- realtime без `ws`: используется **Server-Sent Events (SSE)**
- готово для деплоя на **Render**

## Быстрый старт

```bash
npm install
npm start
```

Открой `http://localhost:3000`.

## Почему без ws

Ты просил вариант без модуля `ws`, поэтому realtime сделан через SSE:

- клиент слушает `/api/events`
- отправка сообщений идёт обычным `POST /api/messages`
- для Render это проще и стабильнее, чем тянуть websocket-стек

## Ограничения текущего MVP

Сейчас сообщения хранятся **в памяти процесса**. После рестарта сервера всё сбросится.

Для нормального продакшна на Render лучше вынести данные в:

- Render Postgres
- Redis / Upstash Redis

## API

- `GET /api/health`
- `GET /api/chats`
- `GET /api/messages?chat=dam-builders`
- `POST /api/messages`
- `GET /api/events?chat=dam-builders`

Пример body для `POST /api/messages`:

```json
{
  "chatId": "dam-builders",
  "author": "Тралалеро Бобреро",
  "text": "Render жив?"
}
```

## Дальше можно добавить

- авторизацию
- список контактов
- загрузку аватарок
- хранение сообщений в Postgres
- реакции, треды, вложения
- приватные чаты и каналы
