const state = {
  chats: [],
  currentChatId: 'dam-builders',
  currentUser: localStorage.getItem('bebragram:user') || '',
  eventSource: null
};

const chatList = document.getElementById('chatList');
const chatItemTemplate = document.getElementById('chatItemTemplate');
const messageTemplate = document.getElementById('messageTemplate');
const messagesEl = document.getElementById('messages');
const messageInput = document.getElementById('messageInput');
const composer = document.getElementById('composer');
const searchInput = document.getElementById('searchInput');
const chatTitle = document.getElementById('chatTitle');
const chatSubtitle = document.getElementById('chatSubtitle');
const chatEmoji = document.getElementById('chatEmoji');
const themeBtn = document.getElementById('themeBtn');

init().catch(showFatal);

async function init() {
  if (!state.currentUser) {
    state.currentUser = (window.prompt('Как тебя зовут, бобр?', 'Гость-бобр') || 'Гость-бобр').trim() || 'Гость-бобр';
    localStorage.setItem('bebragram:user', state.currentUser);
  }

  await loadChats();
  renderChats();
  await selectChat(state.currentChatId);

  composer.addEventListener('submit', onSend);
  searchInput.addEventListener('input', renderChats);
  themeBtn.addEventListener('click', () => {
    document.body.classList.toggle('alt');
  });
}

async function loadChats() {
  const res = await fetch('/api/chats');
  state.chats = await res.json();
}

function renderChats() {
  const query = searchInput.value.trim().toLowerCase();
  chatList.innerHTML = '';

  const filtered = state.chats.filter((chat) => {
    return [chat.title, chat.subtitle, chat.lastMessage].some((part) => part.toLowerCase().includes(query));
  });

  for (const chat of filtered) {
    const node = chatItemTemplate.content.firstElementChild.cloneNode(true);
    node.dataset.chatId = chat.id;
    if (chat.id === state.currentChatId) node.classList.add('active');

    node.querySelector('.chat-item-icon').textContent = chat.emoji;
    node.querySelector('.chat-item-title').textContent = chat.title;
    node.querySelector('.chat-item-time').textContent = chat.lastTime;
    node.querySelector('.chat-item-subtitle').textContent = chat.lastMessage;
    node.querySelector('.chat-item-members').textContent = `${chat.members} бобров`;

    node.addEventListener('click', () => selectChat(chat.id));
    chatList.appendChild(node);
  }
}

async function selectChat(chatId) {
  state.currentChatId = chatId;
  renderChats();

  const current = state.chats.find((chat) => chat.id === chatId);
  if (!current) return;

  chatTitle.textContent = current.title;
  chatSubtitle.textContent = current.subtitle;
  chatEmoji.textContent = current.emoji;

  const res = await fetch(`/api/messages?chat=${encodeURIComponent(chatId)}`);
  const messages = await res.json();
  renderMessages(messages);
  connectEvents(chatId);
}

function renderMessages(messages) {
  messagesEl.innerHTML = '';

  if (!messages.length) {
    messagesEl.innerHTML = '<div class="empty-state">Здесь пока тихо. Первый грызни клавиатуру.</div>';
    return;
  }

  for (const message of messages) {
    appendMessage(message);
  }

  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function appendMessage(message) {
  const node = messageTemplate.content.firstElementChild.cloneNode(true);
  node.classList.add(message.kind);
  node.querySelector('.avatar').textContent = avatarFor(message);
  node.querySelector('.author').textContent = message.author;
  node.querySelector('.time').textContent = message.time;
  node.querySelector('.text').textContent = message.text;
  messagesEl.appendChild(node);
}

function avatarFor(message) {
  if (message.kind === 'system') return '📣';
  if (message.kind === 'me') return '🦫';
  return '🌲';
}

async function onSend(event) {
  event.preventDefault();
  const text = messageInput.value.trim();
  if (!text) return;

  const res = await fetch('/api/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chatId: state.currentChatId,
      author: state.currentUser,
      text
    })
  });

  if (!res.ok) {
    alert('Не удалось отправить сообщение');
    return;
  }

  messageInput.value = '';
  await refreshChats();
}

function connectEvents(chatId) {
  if (state.eventSource) {
    state.eventSource.close();
  }

  const stream = new EventSource(`/api/events?chat=${encodeURIComponent(chatId)}`);
  stream.onmessage = async (event) => {
    const payload = JSON.parse(event.data);
    if (payload.type === 'message' && payload.chatId === state.currentChatId) {
      appendMessage(payload.message);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      await refreshChats();
    }
  };

  stream.onerror = () => {
    setTimeout(() => connectEvents(chatId), 1500);
  };

  state.eventSource = stream;
}

async function refreshChats() {
  const previous = state.currentChatId;
  await loadChats();
  state.currentChatId = previous;
  renderChats();
}

function showFatal(error) {
  console.error(error);
  messagesEl.innerHTML = `<div class="empty-state">Бобр уронил брёвна. Ошибка: ${error?.message || error}</div>`;
}
