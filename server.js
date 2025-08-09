const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { nanoid } = require('nanoid');
const Database = require('better-sqlite3');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// SQLite setup
const db = new Database(path.join(__dirname, 'chat.db'));
db.pragma('journal_mode = wal');
db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    text TEXT NOT NULL,
    ts INTEGER NOT NULL,
    FOREIGN KEY(room_id) REFERENCES rooms(id)
  );
`);

// In-memory connections map per room for online presence
const liveRooms = new Map(); // roomId -> Map(socketId, { id, name })

function getLiveRoom(roomId) {
  if (!liveRooms.has(roomId)) liveRooms.set(roomId, new Map());
  return liveRooms.get(roomId);
}

// DB helpers
const insertRoom = db.prepare('INSERT INTO rooms (id, created_at) VALUES (?, ?)');
const getRoom = db.prepare('SELECT id FROM rooms WHERE id = ?');
const insertMessage = db.prepare('INSERT INTO messages (id, room_id, user_id, name, text, ts) VALUES (?, ?, ?, ?, ?, ?)');
const listRecentMessages = db.prepare('SELECT id, user_id as userId, name, text, ts FROM messages WHERE room_id = ? ORDER BY ts ASC LIMIT ?');

io.on('connection', (socket) => {
  let currentRoomId = null;
  let userId = nanoid(8);

  // Create lobby explicitly
  socket.on('create-room', ({ roomId }) => {
    roomId = (roomId || '').trim();
    if (!roomId) return socket.emit('create-room-result', { ok: false, error: 'Room name required' });
    const exists = getRoom.get(roomId);
    if (exists) return socket.emit('create-room-result', { ok: false, error: 'Room already exists' });
    insertRoom.run(roomId, Date.now());
    socket.emit('create-room-result', { ok: true, roomId });
  });

  // Join lobby (only succeeds if room exists)
  socket.on('join', ({ roomId, name }) => {
    roomId = (roomId || '').trim();
    const displayName = (name && String(name).trim()) || `User-${userId}`;
    if (!roomId) return socket.emit('join-result', { ok: false, error: 'Room name required' });
    const exists = getRoom.get(roomId);
    if (!exists) return socket.emit('join-result', { ok: false, error: 'Room does not exist' });

    currentRoomId = roomId;
    const live = getLiveRoom(roomId);
    live.set(socket.id, { id: userId, name: displayName });
    socket.join(roomId);

    // Send current state to the new user (only after success)
    const messages = listRecentMessages.all(roomId, 500);
    socket.emit('join-result', {
      ok: true,
      roomId,
      userId,
      users: Array.from(live.values()),
      messages,
    });

    // Notify others
    socket.to(roomId).emit('user-joined', { id: userId, name: displayName });
  });

  socket.on('message', (text) => {
    if (!currentRoomId) return;
    const live = liveRooms.get(currentRoomId);
    if (!live) return;
    const user = live.get(socket.id);
    if (!user) return;
    const msg = {
      id: nanoid(10),
      userId: user.id,
      name: user.name,
      text: String(text || '').slice(0, 2000),
      ts: Date.now(),
    };
    insertMessage.run(msg.id, currentRoomId, msg.userId, msg.name, msg.text, msg.ts);
    io.to(currentRoomId).emit('message', msg);
  });

  socket.on('typing', (isTyping) => {
    if (!currentRoomId) return;
    const live = liveRooms.get(currentRoomId);
    if (!live) return;
    const user = live.get(socket.id);
    if (!user) return;
    socket.to(currentRoomId).emit('typing', { userId: user.id, name: user.name, isTyping: !!isTyping });
  });

  socket.on('disconnect', () => {
    if (!currentRoomId) return;
    const live = liveRooms.get(currentRoomId);
    if (!live) return;
    const user = live.get(socket.id);
    if (user) {
      live.delete(socket.id);
      socket.to(currentRoomId).emit('user-left', { id: user.id, name: user.name });
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});


