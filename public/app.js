const state = {
  user: null,
  chats: [],
  explore: [],
  activeChatId: null,
  activeChat: null,
  eventSource: null,
};

const authView = document.getElementById('authView');
const appView = document.getElementById('appView');
const authError = document.getElementById('authError');
const toast = document.getElementById('toast');
const chatList = document.getElementById('chatList');
const exploreList = document.getElementById('exploreList');
const userName = document.getElementById('userName');
const userTag = document.getElementById('userTag');
const chatTitle = document.getElementById('chatTitle');
const chatMeta = document.getElementById('chatMeta');
const chatBadge = document.getElementById('chatBadge');
const messagesBox = document.getElementById('messages');
const composer = document.getElementById('composer');
const composerHint = document.getElementById('composerHint');

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || 'Ошибка запроса');
  }
  return data;
}

function showAuthError(message) {
  authError.textContent = message;
  authError.classList.remove('hidden');
}

function clearAuthError() {
  authError.textContent = '';
  authError.classList.add('hidden');
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.remove('hidden');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.add('hidden'), 2600);
}

function switchTab(tab) {
  document.querySelectorAll('.tab').forEach((button) => {
    button.classList.toggle('active', button.dataset.tab === tab);
  });
  document.getElementById('loginForm').classList.toggle('active', tab === 'login');
  document.getElementById('registerForm').classList.toggle('active', tab === 'register');
  clearAuthError();
}

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  return new Intl.DateTimeFormat('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: '2-digit',
  }).format(date);
}

function typeLabel(type) {
  if (type === 'dm') return 'ЛС';
  if (type === 'group') return 'Группа';
  if (type === 'channel') return 'Канал';
  if (type === 'support') return 'Поддержка';
  return 'Чат';
}

function renderChats() {
  if (!state.chats.length) {
    chatList.innerHTML = '<div class="chat-item"><strong>Пока пусто</strong><p>Создай диалог, группу, канал или открой поддержку.</p></div>';
    return;
  }

  chatList.innerHTML = state.chats
    .map((chat) => `
      <button class="chat-item ${chat.id === state.activeChatId ? 'active' : ''}" data-chat-id="${chat.id}">
        <div class="chat-item-header">
          <strong>${escapeHtml(chat.title || 'Без названия')}</strong>
          <span class="type-chip">${typeLabel(chat.type)}</span>
        </div>
        <p>${escapeHtml(chat.subtitle || '')}</p>
        <p>${escapeHtml(chat.last_message || 'Сообщений пока нет')}</p>
      </button>
    `)
    .join('');

  chatList.querySelectorAll('[data-chat-id]').forEach((button) => {
    button.addEventListener('click', () => openChat(Number(button.dataset.chatId)));
  });
}

function renderExplore() {
  if (!state.explore.length) {
    exploreList.innerHTML = '<div class="explore-item"><strong>Пока ничего нет</strong><p>Создай публичную группу или канал — они появятся здесь.</p></div>';
    return;
  }

  exploreList.innerHTML = state.explore
    .map((item) => `
      <div class="explore-item">
        <div class="explore-top">
          <div>
            <strong>${escapeHtml(item.title)}</strong>
            <p>${typeLabel(item.type)} · участников: ${item.members_count}</p>
          </div>
          ${item.joined ? '<span class="type-chip">Внутри</span>' : `<button class="secondary-btn join-btn" data-join-id="${item.id}">Вступить</button>`}
        </div>
      </div>
    `)
    .join('');

  exploreList.querySelectorAll('.join-btn').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        await api(`/api/chats/${button.dataset.joinId}/join`, { method: 'POST' });
        await refreshSidebar();
        await openChat(Number(button.dataset.joinId));
        showToast('Ты вступил в чат');
      } catch (error) {
        showToast(error.message);
      }
    });
  });
}

async function refreshSidebar() {
  const [{ chats }, { items }] = await Promise.all([
    api('/api/chats'),
    api('/api/explore'),
  ]);
  state.chats = chats;
  state.explore = items;
  renderChats();
  renderExplore();

  if (state.activeChatId && !state.chats.some((chat) => chat.id === state.activeChatId)) {
    state.activeChatId = null;
    state.activeChat = null;
  }
}

function renderMessages(messages) {
  if (!messages.length) {
    messagesBox.classList.add('empty-state');
    messagesBox.innerHTML = `
      <div class="empty-content">
        <div class="logo large">🪵</div>
        <h3>Пока пусто</h3>
        <p>Отправь первое сообщение в этот чат.</p>
      </div>
    `;
    return;
  }

  messagesBox.classList.remove('empty-state');
  messagesBox.innerHTML = messages
    .map((message) => {
      const mine = message.sender_id === state.user.id;
      const system = message.sender_id == null;
      return `
        <article class="message ${mine ? 'mine' : ''} ${system ? 'system' : ''}">
          <div class="message-top">
            <span class="message-author">${system ? 'Система Бебраграмма' : escapeHtml(message.sender_name || message.sender_username || 'Пользователь')}</span>
            <span class="message-time">${formatDate(message.created_at)}</span>
          </div>
          <div class="message-body">${escapeHtml(message.body)}</div>
        </article>
      `;
    })
    .join('');

  messagesBox.scrollTop = messagesBox.scrollHeight;
}

async function openChat(chatId) {
  try {
    state.activeChatId = chatId;
    renderChats();
    const { chat, messages } = await api(`/api/chats/${chatId}/messages`);
    state.activeChat = chat;

    const sidebarChat = state.chats.find((item) => item.id === chatId);
    chatTitle.textContent = sidebarChat?.title || chat.title || 'Чат';
    chatMeta.textContent = sidebarChat?.subtitle || typeLabel(chat.type);
    chatBadge.textContent = typeLabel(chat.type);
    chatBadge.classList.remove('hidden');

    composer.classList.remove('hidden');
    composer.querySelector('textarea').disabled = !chat.can_post;
    composer.querySelector('button').disabled = !chat.can_post;
    composerHint.textContent = chat.can_post
      ? 'Отправка сообщения в этот чат'
      : 'В этом канале писать может только владелец или админ';

    renderMessages(messages);
  } catch (error) {
    showToast(error.message);
  }
}

function showApp() {
  authView.classList.add('hidden');
  appView.classList.remove('hidden');
  userName.textContent = state.user.display_name;
  userTag.textContent = `@${state.user.username}`;
}

function showAuth() {
  authView.classList.remove('hidden');
  appView.classList.add('hidden');
  state.user = null;
  state.activeChatId = null;
  state.activeChat = null;
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
}

function connectStream() {
  if (state.eventSource) state.eventSource.close();
  const stream = new EventSource('/api/stream');
  state.eventSource = stream;

  stream.addEventListener('refresh', async () => {
    try {
      await refreshSidebar();
      if (state.activeChatId) {
        await openChat(state.activeChatId);
      }
    } catch {
      // ignore transient refresh failures
    }
  });

  stream.onerror = () => {
    setTimeout(() => {
      if (state.user) connectStream();
    }, 3000);
  };
}

async function bootstrap() {
  try {
    const { user } = await api('/api/me');
    state.user = user;
    showApp();
    await refreshSidebar();
    connectStream();
    if (state.chats[0]) {
      await openChat(state.chats[0].id);
    }
  } catch {
    showAuth();
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

document.querySelectorAll('.tab').forEach((button) => {
  button.addEventListener('click', () => switchTab(button.dataset.tab));
});

document.getElementById('loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  clearAuthError();
  try {
    const form = new FormData(event.currentTarget);
    const { user } = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        username: form.get('username'),
        password: form.get('password'),
      }),
    });
    state.user = user;
    showApp();
    await refreshSidebar();
    connectStream();
    if (state.chats[0]) await openChat(state.chats[0].id);
    event.currentTarget.reset();
  } catch (error) {
    showAuthError(error.message);
  }
});

document.getElementById('registerForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  clearAuthError();
  try {
    const form = new FormData(event.currentTarget);
    const { user } = await api('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        displayName: form.get('displayName'),
        username: form.get('username'),
        password: form.get('password'),
      }),
    });
    state.user = user;
    showApp();
    await refreshSidebar();
    connectStream();
    if (state.chats[0]) await openChat(state.chats[0].id);
    event.currentTarget.reset();
  } catch (error) {
    showAuthError(error.message);
  }
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' });
  showAuth();
  switchTab('login');
  showToast('Ты вышел из аккаунта');
});

document.getElementById('refreshBtn').addEventListener('click', async () => {
  await refreshSidebar();
  if (state.activeChatId) await openChat(state.activeChatId);
  showToast('Список обновлен');
});

document.getElementById('supportBtn').addEventListener('click', async () => {
  try {
    const { chatId } = await api('/api/chats/support', { method: 'POST' });
    await refreshSidebar();
    await openChat(chatId);
  } catch (error) {
    showToast(error.message);
  }
});

document.getElementById('dmForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const form = new FormData(event.currentTarget);
    const { chatId } = await api('/api/chats/dm', {
      method: 'POST',
      body: JSON.stringify({ username: form.get('username') }),
    });
    event.currentTarget.reset();
    await refreshSidebar();
    await openChat(chatId);
    showToast('Диалог открыт');
  } catch (error) {
    showToast(error.message);
  }
});

document.getElementById('groupForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const form = new FormData(event.currentTarget);
    const { chatId } = await api('/api/chats/group', {
      method: 'POST',
      body: JSON.stringify({ title: form.get('title') }),
    });
    event.currentTarget.reset();
    await refreshSidebar();
    await openChat(chatId);
    showToast('Группа создана');
  } catch (error) {
    showToast(error.message);
  }
});

document.getElementById('channelForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const form = new FormData(event.currentTarget);
    const { chatId } = await api('/api/chats/channel', {
      method: 'POST',
      body: JSON.stringify({ title: form.get('title') }),
    });
    event.currentTarget.reset();
    await refreshSidebar();
    await openChat(chatId);
    showToast('Канал создан');
  } catch (error) {
    showToast(error.message);
  }
});

composer.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.activeChatId) return;

  const textarea = composer.querySelector('textarea');
  try {
    await api(`/api/chats/${state.activeChatId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body: textarea.value }),
    });
    textarea.value = '';
    await openChat(state.activeChatId);
    await refreshSidebar();
  } catch (error) {
    showToast(error.message);
  }
});

bootstrap();
