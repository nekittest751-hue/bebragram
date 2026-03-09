import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || 'change_me';
const COOKIE_NAME = process.env.COOKIE_NAME || 'bebragram_token';
const IS_PROD = process.env.NODE_ENV === 'production';

if (!process.env.DATABASE_URL) {
  console.warn('DATABASE_URL is missing. Copy .env.example to .env and fill it in.');
}

const needsSsl = Boolean(
  process.env.DATABASE_URL &&
  !process.env.DATABASE_URL.includes('localhost') &&
  !process.env.DATABASE_URL.includes('127.0.0.1')
);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: needsSsl ? { rejectUnauthorized: false } : false,
});

const sseClients = new Map();

function addClient(userId, res) {
  const current = sseClients.get(userId) || new Set();
  current.add(res);
  sseClients.set(userId, current);
}

function removeClient(userId, res) {
  const current = sseClients.get(userId);
  if (!current) return;
  current.delete(res);
  if (!current.size) sseClients.delete(userId);
}

function emitToUser(userId, event, payload) {
  const current = sseClients.get(userId);
  if (!current) return;
  const packet = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of current) {
    res.write(packet);
  }
}

async function emitToChatMembers(chatId, event, payload) {
  const { rows } = await pool.query(
    'SELECT user_id FROM chat_members WHERE chat_id = $1',
    [chatId],
  );

  for (const row of rows) {
    emitToUser(row.user_id, event, payload);
  }
}

function signToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
}

function setAuthCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD,
    maxAge: 1000 * 60 * 60 * 24 * 30,
  });
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD,
  });
}

function authMiddleware(req, res, next) {
  const token = req.cookies[COOKIE_NAME];
  if (!token) {
    return res.status(401).json({ error: 'Нужен вход в аккаунт' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ error: 'Сессия истекла, войди заново' });
  }
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS chats (
      id SERIAL PRIMARY KEY,
      type TEXT NOT NULL CHECK (type IN ('dm', 'group', 'channel', 'support')),
      title TEXT,
      owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      is_public BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS chat_members (
      chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (chat_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_messages_chat_id_created_at ON messages(chat_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_chat_members_user_id ON chat_members(user_id);
  `);
}

async function getUserById(userId) {
  const { rows } = await pool.query(
    'SELECT id, username, display_name, created_at FROM users WHERE id = $1 LIMIT 1',
    [userId],
  );
  return rows[0] || null;
}

async function getChatForUser(chatId, userId) {
  const { rows } = await pool.query(
    `SELECT
      c.id,
      c.type,
      c.title,
      c.owner_id,
      c.is_public,
      cm.role,
      EXISTS(
        SELECT 1
        FROM chat_members me
        WHERE me.chat_id = c.id AND me.user_id = $2
      ) AS is_member
    FROM chats c
    LEFT JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = $2
    WHERE c.id = $1
    LIMIT 1`,
    [chatId, userId],
  );
  return rows[0] || null;
}

async function ensureCanRead(chatId, userId) {
  const chat = await getChatForUser(chatId, userId);
  if (!chat) {
    return { error: 'Чат не найден', status: 404 };
  }

  if (chat.type === 'dm' || chat.type === 'support') {
    if (!chat.is_member) return { error: 'Нет доступа', status: 403 };
    return { chat };
  }

  if ((chat.type === 'group' || chat.type === 'channel') && !chat.is_member) {
    return { error: 'Сначала вступи в этот чат', status: 403 };
  }

  return { chat };
}

function canPostInChat(chat) {
  if (!chat.is_member) return false;
  if (chat.type === 'channel') return chat.role === 'owner' || chat.role === 'admin';
  return true;
}

async function listChatsForUser(userId) {
  const { rows } = await pool.query(
    `SELECT
      c.id,
      c.type,
      CASE
        WHEN c.type = 'dm' THEN COALESCE(
          (
            SELECT u2.display_name
            FROM chat_members cm2
            JOIN users u2 ON u2.id = cm2.user_id
            WHERE cm2.chat_id = c.id AND cm2.user_id <> $1
            LIMIT 1
          ),
          'Диалог'
        )
        ELSE COALESCE(c.title, 'Без названия')
      END AS title,
      CASE
        WHEN c.type = 'dm' THEN (
          SELECT '@' || u2.username
          FROM chat_members cm2
          JOIN users u2 ON u2.id = cm2.user_id
          WHERE cm2.chat_id = c.id AND cm2.user_id <> $1
          LIMIT 1
        )
        ELSE CASE
          WHEN c.type = 'group' THEN 'Группа'
          WHEN c.type = 'channel' THEN 'Канал'
          WHEN c.type = 'support' THEN 'Поддержка'
          ELSE 'Чат'
        END
      END AS subtitle,
      m.body AS last_message,
      m.created_at AS last_message_at,
      cm.role,
      c.owner_id,
      CASE
        WHEN c.type = 'channel' THEN (cm.role IN ('owner', 'admin'))
        ELSE TRUE
      END AS can_post
    FROM chat_members cm
    JOIN chats c ON c.id = cm.chat_id
    LEFT JOIN LATERAL (
      SELECT body, created_at
      FROM messages
      WHERE chat_id = c.id
      ORDER BY created_at DESC
      LIMIT 1
    ) m ON TRUE
    WHERE cm.user_id = $1
    ORDER BY COALESCE(m.created_at, c.created_at) DESC, c.id DESC`,
    [userId],
  );

  return rows;
}

async function listExplore(userId) {
  const { rows } = await pool.query(
    `SELECT
      c.id,
      c.type,
      COALESCE(c.title, 'Без названия') AS title,
      COUNT(cm.user_id)::INTEGER AS members_count,
      EXISTS(
        SELECT 1 FROM chat_members me WHERE me.chat_id = c.id AND me.user_id = $1
      ) AS joined
    FROM chats c
    LEFT JOIN chat_members cm ON cm.chat_id = c.id
    WHERE c.type IN ('group', 'channel') AND c.is_public = TRUE
    GROUP BY c.id
    ORDER BY c.created_at DESC`,
    [userId],
  );

  return rows;
}

async function createSupportChatForUser(userId) {
  const existing = await pool.query(
    `SELECT c.id
     FROM chats c
     JOIN chat_members cm ON cm.chat_id = c.id
     WHERE c.type = 'support' AND cm.user_id = $1
     LIMIT 1`,
    [userId],
  );

  if (existing.rows[0]) return existing.rows[0].id;

  const chatResult = await pool.query(
    `INSERT INTO chats (type, title, owner_id, is_public)
     VALUES ('support', 'Служба поддержки', $1, FALSE)
     RETURNING id`,
    [userId],
  );

  const chatId = chatResult.rows[0].id;

  await pool.query(
    `INSERT INTO chat_members (chat_id, user_id, role)
     VALUES ($1, $2, 'owner')`,
    [chatId, userId],
  );

  await pool.query(
    `INSERT INTO messages (chat_id, user_id, body)
     VALUES ($1, NULL, $2)`,
    [chatId, 'Привет! Это демо-служба поддержки Бебраграмма. Опиши вопрос, и здесь появится история обращения.'],
  );

  return chatId;
}

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(express.static(path.join(rootDir, 'public')));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'bebragram' });
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const username = String(req.body.username || '').trim().toLowerCase();
    const displayName = String(req.body.displayName || '').trim();
    const password = String(req.body.password || '');

    if (!/^[a-z0-9_]{3,20}$/.test(username)) {
      return res.status(400).json({ error: 'Username: 3-20 символов, только a-z, 0-9 и _' });
    }

    if (!displayName || displayName.length < 2) {
      return res.status(400).json({ error: 'Укажи имя от 2 символов' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Пароль должен быть не короче 6 символов' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const { rows } = await pool.query(
      `INSERT INTO users (username, display_name, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, username, display_name, created_at`,
      [username, displayName, passwordHash],
    );

    const user = rows[0];
    setAuthCookie(res, signToken(user));
    await createSupportChatForUser(user.id);

    res.status(201).json({ user });
  } catch (error) {
    if (String(error.message).includes('duplicate key')) {
      return res.status(409).json({ error: 'Такой username уже занят' });
    }
    console.error(error);
    res.status(500).json({ error: 'Не удалось зарегистрироваться' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const username = String(req.body.username || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    const { rows } = await pool.query(
      'SELECT id, username, display_name, password_hash, created_at FROM users WHERE username = $1 LIMIT 1',
      [username],
    );

    const user = rows[0];
    if (!user) {
      return res.status(401).json({ error: 'Неверный логин или пароль' });
    }

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'Неверный логин или пароль' });
    }

    setAuthCookie(res, signToken(user));
    await createSupportChatForUser(user.id);
    res.json({
      user: {
        id: user.id,
        username: user.username,
        display_name: user.display_name,
        created_at: user.created_at,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось войти' });
  }
});

app.post('/api/auth/logout', (_req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

app.get('/api/me', authMiddleware, async (req, res) => {
  const user = await getUserById(req.user.id);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  res.json({ user });
});

app.get('/api/stream', authMiddleware, async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });

  res.write(`event: connected\ndata: ${JSON.stringify({ ok: true })}\n\n`);
  addClient(req.user.id, res);

  const interval = setInterval(() => {
    res.write('event: ping\ndata: {}\n\n');
  }, 25000);

  req.on('close', () => {
    clearInterval(interval);
    removeClient(req.user.id, res);
  });
});

app.get('/api/chats', authMiddleware, async (req, res) => {
  const chats = await listChatsForUser(req.user.id);
  res.json({ chats });
});

app.get('/api/explore', authMiddleware, async (req, res) => {
  const items = await listExplore(req.user.id);
  res.json({ items });
});

app.post('/api/chats/support', authMiddleware, async (req, res) => {
  const chatId = await createSupportChatForUser(req.user.id);
  emitToUser(req.user.id, 'refresh', { type: 'support', chatId });
  res.json({ chatId });
});

app.post('/api/chats/dm', authMiddleware, async (req, res) => {
  try {
    const username = String(req.body.username || '').trim().toLowerCase().replace(/^@/, '');
    if (!username) return res.status(400).json({ error: 'Укажи username' });

    const userResult = await pool.query(
      'SELECT id, username, display_name FROM users WHERE username = $1 LIMIT 1',
      [username],
    );
    const target = userResult.rows[0];
    if (!target) return res.status(404).json({ error: 'Пользователь не найден' });
    if (target.id === req.user.id) return res.status(400).json({ error: 'Нельзя создать диалог с собой' });

    const existing = await pool.query(
      `SELECT c.id
       FROM chats c
       JOIN chat_members me ON me.chat_id = c.id AND me.user_id = $1
       JOIN chat_members other ON other.chat_id = c.id AND other.user_id = $2
       WHERE c.type = 'dm'
       AND (SELECT COUNT(*) FROM chat_members cm WHERE cm.chat_id = c.id) = 2
       LIMIT 1`,
      [req.user.id, target.id],
    );

    let chatId = existing.rows[0]?.id;

    if (!chatId) {
      const chatResult = await pool.query(
        `INSERT INTO chats (type, title, owner_id, is_public)
         VALUES ('dm', NULL, $1, FALSE)
         RETURNING id`,
        [req.user.id],
      );
      chatId = chatResult.rows[0].id;

      await pool.query(
        `INSERT INTO chat_members (chat_id, user_id, role)
         VALUES ($1, $2, 'owner'), ($1, $3, 'member')`,
        [chatId, req.user.id, target.id],
      );
    }

    await emitToChatMembers(chatId, 'refresh', { type: 'dm', chatId });
    res.status(201).json({ chatId });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось создать диалог' });
  }
});

app.post('/api/chats/group', authMiddleware, async (req, res) => {
  try {
    const title = String(req.body.title || '').trim();
    if (title.length < 2) return res.status(400).json({ error: 'Название группы слишком короткое' });

    const chatResult = await pool.query(
      `INSERT INTO chats (type, title, owner_id, is_public)
       VALUES ('group', $1, $2, TRUE)
       RETURNING id`,
      [title, req.user.id],
    );

    const chatId = chatResult.rows[0].id;
    await pool.query(
      `INSERT INTO chat_members (chat_id, user_id, role)
       VALUES ($1, $2, 'owner')`,
      [chatId, req.user.id],
    );

    await emitToUser(req.user.id, 'refresh', { type: 'group', chatId });
    res.status(201).json({ chatId });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось создать группу' });
  }
});

app.post('/api/chats/channel', authMiddleware, async (req, res) => {
  try {
    const title = String(req.body.title || '').trim();
    if (title.length < 2) return res.status(400).json({ error: 'Название канала слишком короткое' });

    const chatResult = await pool.query(
      `INSERT INTO chats (type, title, owner_id, is_public)
       VALUES ('channel', $1, $2, TRUE)
       RETURNING id`,
      [title, req.user.id],
    );

    const chatId = chatResult.rows[0].id;
    await pool.query(
      `INSERT INTO chat_members (chat_id, user_id, role)
       VALUES ($1, $2, 'owner')`,
      [chatId, req.user.id],
    );

    await emitToUser(req.user.id, 'refresh', { type: 'channel', chatId });
    res.status(201).json({ chatId });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось создать канал' });
  }
});

app.post('/api/chats/:chatId/join', authMiddleware, async (req, res) => {
  try {
    const chatId = Number(req.params.chatId);
    if (!Number.isInteger(chatId)) return res.status(400).json({ error: 'Некорректный chatId' });

    const { rows } = await pool.query(
      'SELECT id, type, is_public FROM chats WHERE id = $1 LIMIT 1',
      [chatId],
    );
    const chat = rows[0];

    if (!chat) return res.status(404).json({ error: 'Чат не найден' });
    if (!['group', 'channel'].includes(chat.type) || !chat.is_public) {
      return res.status(403).json({ error: 'Вступление в этот чат недоступно' });
    }

    await pool.query(
      `INSERT INTO chat_members (chat_id, user_id, role)
       VALUES ($1, $2, 'member')
       ON CONFLICT (chat_id, user_id) DO NOTHING`,
      [chatId, req.user.id],
    );

    await emitToChatMembers(chatId, 'refresh', { type: 'join', chatId });
    emitToUser(req.user.id, 'refresh', { type: 'join', chatId });
    res.json({ ok: true, chatId });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось вступить в чат' });
  }
});

app.get('/api/chats/:chatId/messages', authMiddleware, async (req, res) => {
  try {
    const chatId = Number(req.params.chatId);
    const permission = await ensureCanRead(chatId, req.user.id);
    if (permission.error) {
      return res.status(permission.status).json({ error: permission.error });
    }

    const { rows } = await pool.query(
      `SELECT
        m.id,
        m.chat_id,
        m.body,
        m.created_at,
        u.id AS sender_id,
        u.username AS sender_username,
        u.display_name AS sender_name
      FROM messages m
      LEFT JOIN users u ON u.id = m.user_id
      WHERE m.chat_id = $1
      ORDER BY m.created_at ASC
      LIMIT 200`,
      [chatId],
    );

    res.json({
      chat: {
        id: permission.chat.id,
        type: permission.chat.type,
        title: permission.chat.title,
        role: permission.chat.role,
        can_post: canPostInChat(permission.chat),
      },
      messages: rows,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось загрузить сообщения' });
  }
});

app.post('/api/chats/:chatId/messages', authMiddleware, async (req, res) => {
  try {
    const chatId = Number(req.params.chatId);
    const body = String(req.body.body || '').trim();
    if (!body) return res.status(400).json({ error: 'Сообщение пустое' });
    if (body.length > 4000) return res.status(400).json({ error: 'Сообщение слишком длинное' });

    const permission = await ensureCanRead(chatId, req.user.id);
    if (permission.error) {
      return res.status(permission.status).json({ error: permission.error });
    }

    if (!canPostInChat(permission.chat)) {
      return res.status(403).json({ error: 'В этом канале писать может только владелец или админ' });
    }

    const { rows } = await pool.query(
      `INSERT INTO messages (chat_id, user_id, body)
       VALUES ($1, $2, $3)
       RETURNING id, chat_id, body, created_at`,
      [chatId, req.user.id, body],
    );

    await emitToChatMembers(chatId, 'refresh', { type: 'message', chatId });
    res.status(201).json({ message: rows[0] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Не удалось отправить сообщение' });
  }
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(rootDir, 'public', 'index.html'));
});

async function start() {
  try {
    await initDb();
    app.listen(PORT, () => {
      console.log(`Bebragram is running on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server', error);
    process.exit(1);
  }
}

start();
