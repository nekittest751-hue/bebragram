# Бебраграмм (Bebragram)

Телеграм-подобный мессенджер с бобровым интерфейсом.

Что уже есть:
- регистрация и вход
- личные сообщения
- группы
- каналы
- служба поддержки
- realtime без `ws` через SSE
- один Node/Express сервис: и API, и фронт в одном приложении
- PostgreSQL

## Стек
- Node.js + Express
- PostgreSQL (`pg`)
- SSE (Server-Sent Events) вместо WebSocket
- HTML/CSS/Vanilla JS на фронте

## Быстрый старт локально

```bash
cp .env.example .env
npm install
npm start
```

После этого открой:

```bash
http://localhost:3000
```

## Что нужно в `.env`

```env
PORT=3000
DATABASE_URL=postgres://postgres:postgres@localhost:5432/bebragram
JWT_SECRET=change_me_super_secret
COOKIE_NAME=bebragram_token
APP_URL=http://localhost:3000
```

## Деплой на Koyeb + Neon

Рекомендуемый бесплатный вариант:
1. создаешь PostgreSQL в Neon
2. берешь строку подключения `DATABASE_URL`
3. заливаешь проект на GitHub
4. создаешь Web Service на Koyeb из GitHub-репозитория
5. добавляешь переменные окружения:
   - `DATABASE_URL`
   - `JWT_SECRET`
   - `COOKIE_NAME=bebragram_token`
   - `APP_URL=https://твой-сервис.koyeb.app`
6. деплоишь сервис

Важно: для удаленной PostgreSQL в проекте уже включен SSL, поэтому приложение подходит для Neon/Koyeb.

## Как это работает без `ws`

Вместо WebSocket используется `EventSource` / Server-Sent Events:
- фронт подписывается на `/api/stream`
- сервер пушит событие `refresh`
- клиент обновляет список чатов и сообщения

Это проще для первого деплоя и хорошо подходит для MVP-мессенджера.

## Ограничения текущего MVP

Сейчас это хороший старт, но не полный клон Telegram.
Что еще можно добавить потом:
- аватарки
- поиск по сообщениям
- непрочитанные сообщения
- роли админов в группах
- вложения и файлы
- ответы/реплаи
- редактирование и удаление сообщений
- push-уведомления
- пагинацию истории
- отдельный кабинет поддержки

## Структура

```text
bebragram/
  package.json
  .gitignore
  render.yaml
  .env.example
  README.md
  src/
    server.js
  public/
    index.html
    styles.css
    app.js
```
