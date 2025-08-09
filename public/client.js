const socket = io();

const $messages = document.getElementById('messages');
const $input = document.getElementById('input');
const $sendBtn = document.getElementById('sendBtn');
const $roomId = document.getElementById('roomId');
const $name = document.getElementById('name');
const $joinBtn = document.getElementById('joinBtn');
const $createBtn = document.getElementById('createBtn');
const $status = document.getElementById('status');
const $shareLink = document.getElementById('shareLink');
const $copyLinkBtn = document.getElementById('copyLinkBtn');

let joined = false;
let myUserId = null;
let typingTimeout = null;

function addMessage({ name, text, ts }) {
  const li = document.createElement('li');
  const time = new Date(ts).toLocaleTimeString();
  li.innerHTML = `<div class="meta">[${time}] <span class="name">${escapeHtml(name)}</span></div><div>${linkify(escapeHtml(text))}</div>`;
  $messages.appendChild(li);
  $messages.scrollTop = $messages.scrollHeight;
}

function systemMessage(text) {
  const li = document.createElement('li');
  li.innerHTML = `<div class="meta">SYSTEM</div><div>${escapeHtml(text)}</div>`;
  $messages.appendChild(li);
  $messages.scrollTop = $messages.scrollHeight;
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (m) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[m]));
}

function linkify(str) {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  return str.replace(urlRegex, (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
}

$joinBtn.addEventListener('click', () => {
  const roomId = ($roomId.value || 'lobby').trim();
  const name = ($name.value || '').trim();
  socket.emit('join', { roomId, name });
});

$createBtn.addEventListener('click', () => {
  const roomId = ($roomId.value || '').trim();
  if (!roomId) {
    systemMessage('Room name required to create');
    return;
  }
  socket.emit('create-room', { roomId });
});

$copyLinkBtn.addEventListener('click', async () => {
  if (!$shareLink.value) return;
  try {
    await navigator.clipboard.writeText($shareLink.value);
    $copyLinkBtn.textContent = 'Copied!';
    setTimeout(() => ($copyLinkBtn.textContent = 'Copy'), 1200);
  } catch {}
});

$sendBtn.addEventListener('click', () => {
  const text = $input.value.trim();
  if (!joined || !text) return;
  socket.emit('message', text);
  $input.value = '';
});

// Enter to send
$input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $sendBtn.click();
  }
});

$input.addEventListener('input', () => {
  if (!joined) return;
  socket.emit('typing', true);
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => socket.emit('typing', false), 1200);
});

socket.on('connect', () => {
  $status.textContent = 'connected';
});

socket.on('disconnect', () => {
  $status.textContent = 'disconnected';
});

socket.on('create-room-result', (res) => {
  if (!res.ok) {
    systemMessage(`Create failed: ${res.error}`);
    return;
  }
  systemMessage(`Room '${res.roomId}' created. Joining...`);
  const name = ($name.value || '').trim();
  socket.emit('join', { roomId: res.roomId, name });
});

socket.on('join-result', ({ ok, error, roomId, userId, users, messages }) => {
  if (!ok) {
    systemMessage(`Join failed: ${error}`);
    return;
  }
  joined = true;
  myUserId = userId;
  $status.textContent = `joined room ${roomId} as ${users.find(u => u.id === userId)?.name || 'you'}`;
  $messages.innerHTML = '';
  messages.forEach(addMessage);
  systemMessage(`Users online: ${users.length}`);

  // Build shareable link
  const url = new URL(window.location.href);
  url.searchParams.set('room', roomId);
  const me = users.find(u => u.id === userId)?.name || '';
  if (me) url.searchParams.set('name', me);
  $shareLink.value = url.toString();
});

socket.on('user-joined', (user) => {
  systemMessage(`${user.name} joined`);
});

socket.on('user-left', (user) => {
  systemMessage(`${user.name} left`);
});

socket.on('message', (msg) => {
  addMessage(msg);
});

let typingUsers = new Map();
socket.on('typing', ({ name, isTyping, userId }) => {
  if (userId === myUserId) return;
  if (isTyping) {
    typingUsers.set(userId, name);
  } else {
    typingUsers.delete(userId);
  }
  const names = Array.from(typingUsers.values());
  if (names.length === 0) {
    $status.textContent = 'online';
  } else {
    $status.textContent = `${names.join(', ')} typing...`;
  }
});

// Auto-join from query params (requires room to exist)
window.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(window.location.search);
  const room = (params.get('room') || '').trim();
  const name = (params.get('name') || '').trim();
  if (room) $roomId.value = room;
  if (name) $name.value = name;
  if (room) {
    socket.emit('join', { roomId: room, name });
  }
});


