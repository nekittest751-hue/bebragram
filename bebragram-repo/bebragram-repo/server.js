const express = require('express');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const chats = [
  {
    id: 'dam-builders',
    title: 'Плотинщики',
    subtitle: 'Главный штаб бобров',
    emoji: '🪵',
    members: 124,
    accent: 'wood'
  },
  {
    id: 'river-news',
    title: 'Речные новости',
    subtitle: 'Что нового на берегу',
    emoji: '🌊',
    members: 89,
    accent: 'river'
  },
  {
    id: 'gnaw-lab',
    title: 'ГрызLab',
    subtitle: 'Идеи, мемы и тесты',
    emoji: '🦫',
    members: 42,
    accent: 'beaver'
  }
];

const messagesByChat = {
  'dam-builders': [
    createMessage('system', 'BebraBot', 'Добро пожаловать в Бебраграмм. Здесь строят плотины и обсуждают релизы.', '09:01'),
    createMessage('other', 'Хвостыч', 'Render уже готов. Без ws, только SSE — как ты и просил.', '09:03'),
    createMessage('me', 'Ты', 'Идеально. Давайте сделаем интерфейс побобринее.', '09:05')
  ],
  'river-news': [
    createMessage('system', 'BebraBot', 'Уровень воды стабильный. Сервер на берегу Render работает.', '08:40'),
    createMessage('other', 'Лесной аналитик', 'Сегодня в тренде ветки, брёвна и хороший UI.', '08:46')
  ],
  'gnaw-lab': [
    createMessage('system', 'BebraBot', 'Тестовая зона для новых фич.', '10:00'),
    createMessage('other', 'Инженер Клык', 'Следующий этап: профили, реакции и хранение в Postgres.', '10:04')
  ]
};

const subscribers = new Map();
for (const chat of chats) {
  subscribers.set(chat.id, new Set());
}

function createMessage(kind, author, text, time) {
  return {
    id: crypto.randomUUID(),
    kind,
    author,
    text,
    time: time || new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
  };
}

function emit(chatId, payload) {
  const listeners = subscribers.get(chatId);
  if (!listeners || listeners.size === 0) return;

  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of listeners) {
    res.write(data);
  }
}

function getChatSnapshot() {
  return chats.map((chat) => {
    const messages = messagesByChat[chat.id] || [];
    const lastMessage = messages[messages.length - 1];

    return {
      ...chat,
      lastMessage: lastMessage ? lastMessage.text : 'Пока тишина',
      lastTime: lastMessage ? lastMessage.time : '--:--'
    };
  });
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'bebragram',
    transport: 'sse'
  });
});

app.get('/api/chats', (_req, res) => {
  res.json(getChatSnapshot());
});

app.get('/api/messages', (req, res) => {
  const chatId = req.query.chat;
  if (!chatId || !messagesByChat[chatId]) {
    return res.status(404).json({ error: 'Чат не найден' });
  }

  return res.json(messagesByChat[chatId]);
});

app.post('/api/messages', (req, res) => {
  const { chatId, author, text } = req.body || {};

  if (!chatId || !messagesByChat[chatId]) {
    return res.status(404).json({ error: 'Чат не найден' });
  }

  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'Пустое сообщение' });
  }

  const safeAuthor = typeof author === 'string' && author.trim()
    ? author.trim().slice(0, 24)
    : 'Гость-бобр';

  const message = createMessage('me', safeAuthor, text.trim().slice(0, 1000));
  messagesByChat[chatId].push(message);
  emit(chatId, { type: 'message', chatId, message });

  setTimeout(() => {
    const answer = createMessage('other', 'BebraBot', generateReply(text));
    messagesByChat[chatId].push(answer);
    emit(chatId, { type: 'message', chatId, message: answer });
  }, 900);

  return res.status(201).json(message);
});

app.get('/api/events', (req, res) => {
  const chatId = req.query.chat;
  if (!chatId || !subscribers.has(chatId)) {
    return res.status(404).json({ error: 'Чат не найден' });
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  res.write(`event: hello\ndata: ${JSON.stringify({ ok: true, chatId })}\n\n`);

  const listeners = subscribers.get(chatId);
  listeners.add(res);

  const heartbeat = setInterval(() => {
    res.write(`event: ping\ndata: ${Date.now()}\n\n`);
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    listeners.delete(res);
    res.end();
  });
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

function generateReply(input) {
  const source = String(input || '').toLowerCase();

  if (source.includes('render')) {
    return 'На Render всё ок: держим long-lived HTTP через SSE и не трогаем ws.';
  }

  if (source.includes('бобр') || source.includes('beaver') || source.includes('бебр')) {
    return 'Бобр одобряет. Добавим ещё дерева, воды и мощный хвостовой UX.';
  }

  if (source.includes('сервер')) {
    return 'Сервер отвечает через Express. Для продакшна лучше вынести сообщения в Postgres или Redis.';
  }

  return 'Сообщение принято. Плотина строится, чат живёт, Бебраграмм работает.';
}

app.listen(PORT, HOST, () => {
  console.log(`Bebragram running on http://${HOST}:${PORT}`);
});
