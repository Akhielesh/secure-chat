// Using React from CDN globals
const { useEffect, useMemo, useRef, useState, forwardRef } = React;

const DB_KEY = "chatdb_v5";
// Cross-page broadcast
const bc = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('chat_app') : null;
function broadcast(msg) { try { bc && bc.postMessage(msg); } catch {}
}

function now() { return Date.now(); }
function obf(pw) { return Array.from(pw).map(c => String.fromCharCode(c.charCodeAt(0) ^ 23)).join(""); }
function normalizeDB(db) {
  if (!db.nextIds) db.nextIds = { user: 1, conversation: 1, message: 1, invite: 1 };
  if (db.nextIds && db.nextIds.invite == null) db.nextIds.invite = 1;
  if (!db.invites) db.invites = [];
  if (!db.readStates) db.readStates = [];
  if (!db.version || db.version < 5) db.version = 5;
  if (db.users) db.users.forEach(u => {
    if (typeof u.showActive !== 'boolean') u.showActive = true;
    if (typeof u.showReadReceipts !== 'boolean') u.showReadReceipts = true;
  });
  return db;
}
function loadDB() {
  const raw = localStorage.getItem(DB_KEY);
  if (!raw) {
    const db = seedDB();
    localStorage.setItem(DB_KEY, JSON.stringify(db));
    return db;
  }
  try { return normalizeDB(JSON.parse(raw)); } catch {
    const db = seedDB();
    localStorage.setItem(DB_KEY, JSON.stringify(db));
    return db;
  }
}
function saveDB(db) { localStorage.setItem(DB_KEY, JSON.stringify(db)); window.dispatchEvent(new CustomEvent("chatdb:update")); broadcast({ type: 'db:update' }); }
function seedDB() {
  const db = { users: [], conversations: [], members: [], messages: [], invites: [], readStates: [], nextIds: { user: 1, conversation: 1, message: 1, invite: 1 }, version: 5 };
  const u1 = { id: db.nextIds.user++, username: "alice", password: obf("secret123"), createdAt: now(), updatedAt: now(), avatar: undefined, bio: "Just Alice.", lastSeen: now(), showActive: true };
  const u2 = { id: db.nextIds.user++, username: "bob", password: obf("secret123"), createdAt: now(), updatedAt: now(), avatar: undefined, bio: "Bob from the block.", lastSeen: now(), showActive: true };
  db.users.push(u1, u2);
  const lobby = { id: db.nextIds.conversation++, type: "LOBBY", name: "General", description: "Say hi to everyone", isPublic: true, ownerId: u1.id, createdAt: now(), updatedAt: now(), avatar: undefined };
  db.conversations.push(lobby);
  db.members.push({ userId: u1.id, conversationId: lobby.id, role: "OWNER", joinedAt: now(), invitedById: undefined });
  db.members.push({ userId: u2.id, conversationId: lobby.id, role: "MEMBER", joinedAt: now(), invitedById: u1.id });
  db.messages.push({ id: db.nextIds.message++, conversationId: lobby.id, senderId: u1.id, body: "Welcome to General!", createdAt: now() });
  db.messages.push({ id: db.nextIds.message++, conversationId: lobby.id, senderId: u2.id, body: "Hey Alice 👋", createdAt: now() });
  return db;
}

const dao = {
  get() { return loadDB(); },
  mutate(mut) { const db = loadDB(); normalizeDB(db); mut(db); saveDB(db); return db; },
  findUserByUsername(username) { const db = loadDB(); return db.users.find(u => u.username === username) || null; },
  findUserById(id) { const db = loadDB(); return db.users.find(u => u.id === id) || null; },
  listUsersLike(q) { const db = loadDB(); const s = q.trim().toLowerCase(); if (!s) return []; return db.users.filter(u=>u.username.toLowerCase().includes(s)); },
  createUser(username, password) { return this.mutate(db => { if (db.users.some(u => u.username === username)) throw new Error("Username already taken"); const user = { id: db.nextIds.user++, username, password: obf(password), createdAt: now(), updatedAt: now(), avatar: undefined, bio: "", lastSeen: now(), showActive: true }; db.users.push(user); broadcast({ type: 'user:updated', userId: user.id }); }).users.find(u => u.username === username); },
  login(username, password) { const u = this.findUserByUsername(username); if (!u || u.password !== obf(password)) throw new Error("Invalid credentials"); this.mutate(db => { const uu = db.users.find(x => x.id === u.id); if (uu) uu.lastSeen = now(); broadcast({ type: 'presence:update', userId: u.id }); }); return u; },
  setOffline(userId) { this.mutate(db => { const u = db.users.find(x=>x.id===userId); if (u) u.lastSeen = 0; broadcast({ type: 'presence:update', userId }); }); },
  updateUser(userId, { username, password, bio, avatar, showActive, showReadReceipts }) { this.mutate(db => { const u = db.users.find(x => x.id === userId); if (!u) throw new Error("User not found"); if (username && username !== u.username) { if (db.users.some(us => us.username === username)) throw new Error("Username already taken"); u.username = username; } if (typeof bio === 'string') u.bio = bio; if (typeof avatar === 'string') u.avatar = avatar; if (typeof showActive === 'boolean') u.showActive = showActive; if (typeof showReadReceipts === 'boolean') u.showReadReceipts = showReadReceipts; if (password) u.password = obf(password); u.updatedAt = now(); broadcast({ type: 'user:updated', userId }); }); },
  touchUser(userId) { this.mutate(db => { const u = db.users.find(x=>x.id===userId); if (u) u.lastSeen = now(); broadcast({ type: 'presence:update', userId }); }); },
  // Unread message tracking - only count messages that have never been read
  getUnreadCount(conversationId, userId) { 
    const db = loadDB(); 
    const messages = db.messages.filter(m => m.conversationId === conversationId && m.senderId !== userId); 
    const readState = db.readStates?.find(rs => rs.conversationId === conversationId && rs.userId === userId); 
    if (!readState) return messages.length; 
    return messages.filter(m => m.createdAt > readState.lastReadAt).length; 
  },
  markAsRead(conversationId, userId) { 
    this.mutate(db => { 
      if (!db.readStates) db.readStates = []; 
      const idx = db.readStates.findIndex(rs => rs.conversationId === conversationId && rs.userId === userId); 
      const readState = { conversationId, userId, lastReadAt: now() }; 
      if (idx >= 0) db.readStates[idx] = readState; 
      else db.readStates.push(readState); 
    }); 
  },
  listUserConversations(userId) { const db = loadDB(); const convos = db.conversations.filter(c => db.members.some(m => m.userId === userId && m.conversationId === c.id)); return convos.sort((a,b) => b.updatedAt - a.updatedAt); },
  listUserMemberships(userId) { const db = loadDB(); return db.members.filter(m => m.userId === userId); },
  listLobbies() { const db = loadDB(); return db.conversations.filter(c => c.type === "LOBBY" && c.isPublic); },
  getConversation(id) { const db = loadDB(); return db.conversations.find(c => c.id === id) || null; },
  listMembers(conversationId) { const db = loadDB(); return db.members.filter(m => m.conversationId === conversationId); },
  isMember(conversationId, userId) { const db = loadDB(); return !!db.members.find(m=>m.conversationId===conversationId && m.userId===userId); },
  getRole(conversationId, userId) { const db = loadDB(); return (db.members.find(m => m.conversationId===conversationId && m.userId===userId)?.role) || null; },
  removeMember(conversationId, actorId, targetUserId) { this.mutate(db => { const actor = db.members.find(m=>m.conversationId===conversationId && m.userId===actorId); if (!actor || (actor.role!=='OWNER' && actor.role!=='ADMIN')) throw new Error('Not allowed'); const idx = db.members.findIndex(m=>m.conversationId===conversationId && m.userId===targetUserId); if (idx<0) throw new Error('User not a member'); db.members.splice(idx,1); broadcast({ type: 'membership:removed', conversationId, targetUserId }); }); },
  ensureDM(userId, otherUsername) { const other = this.findUserByUsername(otherUsername); if (!other) throw new Error("User not found"); if (other.id === userId) throw new Error("Cannot DM yourself"); const db = loadDB(); const existing = db.conversations.find(c => c.type === "DIRECT" && db.members.some(m => m.userId === userId && m.conversationId === c.id) && db.members.some(m => m.userId === other.id && m.conversationId === c.id)); if (existing) { this.ensureServerMembership(existing.id, [otherUsername]); return existing; } return this.mutate(db => { const convo = { id: db.nextIds.conversation++, type: "DIRECT", name: undefined, description: undefined, isPublic: false, ownerId: undefined, createdAt: now(), updatedAt: now() }; db.conversations.push(convo); db.members.push({ userId, conversationId: convo.id, role: "OWNER", joinedAt: now() }); db.members.push({ userId: other.id, conversationId: convo.id, role: "MEMBER", joinedAt: now() }); this.ensureServerMembership(convo.id, [otherUsername]); broadcast({ type: 'convo:new', conversationId: convo.id }); }).conversations.at(-1); },
  createGroup(ownerId, name, memberUsernames) { const users = memberUsernames.map(u => this.findUserByUsername(u)).filter(Boolean); return this.mutate(db => { const convo = { id: db.nextIds.conversation++, type: "GROUP", name, description: "", isPublic: false, ownerId, createdAt: now(), updatedAt: now() }; db.conversations.push(convo); db.members.push({ userId: ownerId, conversationId: convo.id, role: "OWNER", joinedAt: now() }); for (const u of users) if (u && u.id !== ownerId) db.members.push({ userId: u.id, conversationId: convo.id, role: "MEMBER", invitedById: ownerId, joinedAt: now() }); this.ensureServerMembership(convo.id, memberUsernames); window.dispatchEvent(new CustomEvent('chat:membership', { detail: { kind: 'group-created', conversationId: convo.id, ownerId } })); broadcast({ type: 'membership:event', kind: 'group-created', conversationId: convo.id }); }).conversations.at(-1); },
  inviteToGroup(conversationId, inviterId, username) { const user = this.findUserByUsername(username); if (!user) throw new Error("User not found"); this.mutate(db => { const convo = db.conversations.find(c => c.id === conversationId && c.type === "GROUP"); if (!convo) throw new Error("Group not found"); const inviter = db.members.find(m => m.conversationId === conversationId && m.userId === inviterId); if (!inviter || (inviter.role !== "OWNER" && inviter.role !== "ADMIN")) throw new Error("Not allowed"); const already = db.members.find(m => m.conversationId === conversationId && m.userId === user.id); if (!already) { db.members.push({ userId: user.id, conversationId, role: "MEMBER", invitedById: inviterId, joinedAt: now() }); window.dispatchEvent(new CustomEvent('chat:membership', { detail: { kind: 'group-invite', conversationId, inviterId, invitedUserId: user.id } })); broadcast({ type: 'membership:event', kind: 'group-invite', conversationId }); } }); },
  setMemberRole(conversationId, actorId, targetUserId, role) { this.mutate(db => { const actor = db.members.find(m => m.conversationId===conversationId && m.userId===actorId); if (!actor || actor.role === 'MEMBER') throw new Error('Only owner/admin can change roles'); if (role === 'OWNER') throw new Error('Cannot assign owner'); const member = db.members.find(m => m.conversationId===conversationId && m.userId===targetUserId); if (!member) throw new Error('User not in conversation'); member.role = role; broadcast({ type: 'membership:role', conversationId, targetUserId, role }); }); },
  updateGroup(conversationId, actorId, { name, description }) { this.mutate(db => { const convo = db.conversations.find(c => c.id === conversationId); if (!convo || convo.type !== 'GROUP') throw new Error('Group not found'); const actor = db.members.find(m => m.conversationId===conversationId && m.userId===actorId); if (!actor || (actor.role!=='OWNER' && actor.role!=='ADMIN')) throw new Error('Only admins/owner can edit'); if (typeof name === 'string' && name.trim()) convo.name = name.trim(); if (typeof description === 'string') convo.description = description; convo.updatedAt = now(); broadcast({ type: 'convo:update', conversationId }); }); },
  createLobby(ownerId, name) { return this.mutate(db => { const existing = db.conversations.find(c => c.type==='LOBBY' && (c.name||'').toLowerCase()===name.toLowerCase()); if (existing) throw new Error('Lobby name already exists'); const convo = { id: db.nextIds.conversation++, type: "LOBBY", name, description: "", isPublic: true, ownerId, createdAt: now(), updatedAt: now(), avatar: undefined }; db.conversations.push(convo); db.members.push({ userId: ownerId, conversationId: convo.id, role: "OWNER", joinedAt: now() }); window.dispatchEvent(new CustomEvent('chat:membership', { detail: { kind: 'lobby-created', conversationId: convo.id, ownerId } })); broadcast({ type: 'membership:event', kind: 'lobby-created', conversationId: convo.id }); }).conversations.at(-1); },
  joinLobby(userId, conversationId) { this.mutate(db => { const convo = db.conversations.find(c => c.id === conversationId && c.type === "LOBBY" && c.isPublic); if (!convo) throw new Error("Lobby not found"); const exists = db.members.find(m => m.userId === userId && m.conversationId === conversationId); if (!exists) { db.members.push({ userId, conversationId, role: "MEMBER", joinedAt: now() }); window.dispatchEvent(new CustomEvent('chat:membership', { detail: { kind: 'lobby-joined', conversationId, userId } })); broadcast({ type: 'membership:event', kind: 'lobby-joined', conversationId }); } }); },
  findLobbyByExactName(name) { const db = loadDB(); return db.conversations.find(c => c.type==='LOBBY' && (c.name||'').toLowerCase() === name.trim().toLowerCase()) || null; },
  searchLobbiesByName(q) { const db = loadDB(); const s = q.trim().toLowerCase(); if (!s) return []; return db.conversations.filter(c => c.type==='LOBBY' && (c.name||'').toLowerCase().includes(s)); },
  inviteToLobby(lobbyId, inviterId, username) { const user = this.findUserByUsername(username); if (!user) throw new Error('User not found'); this.mutate(db => { const convo = db.conversations.find(c => c.id===lobbyId && c.type==='LOBBY'); if (!convo) throw new Error('Lobby not found'); const inviter = db.members.find(m => m.conversationId===lobbyId && m.userId===inviterId); if (!inviter || (inviter.role!=='OWNER' && inviter.role!=='ADMIN')) throw new Error('Not allowed'); const already = db.members.find(m => m.conversationId===lobbyId && m.userId===user.id); if (already) throw new Error('Already a member'); const invite = { id: db.nextIds.invite++, kind: 'INVITE', lobbyId, fromUserId: inviterId, toUserId: user.id, status: 'PENDING', createdAt: now() }; db.invites.push(invite); broadcast({ type: 'lobby:invite:new', toUserId: user.id, lobbyId }); }); },
  listUserInvites(userId) { const db = loadDB(); return db.invites.filter(i => i.toUserId===userId && i.kind==='INVITE' && i.status==='PENDING'); },
  acceptLobbyInvite(inviteId, actingUserId) { this.mutate(db => { const inv = db.invites.find(i=>i.id===inviteId && i.kind==='INVITE'); if (!inv) throw new Error('Invite not found'); if (inv.toUserId !== actingUserId) throw new Error('Not allowed'); inv.status='ACCEPTED'; const exists = db.members.find(m=>m.userId===actingUserId && m.conversationId===inv.lobbyId); if (!exists) db.members.push({ userId: actingUserId, conversationId: inv.lobbyId, role: 'MEMBER', joinedAt: now(), invitedById: inv.fromUserId }); window.dispatchEvent(new CustomEvent('chat:membership', { detail: { kind: 'lobby-joined', conversationId: inv.lobbyId, userId: actingUserId } })); broadcast({ type: 'membership:event', kind: 'lobby-joined', conversationId: inv.lobbyId }); }); },
  declineLobbyInvite(inviteId, actingUserId) { this.mutate(db => { const inv = db.invites.find(i=>i.id===inviteId && i.kind==='INVITE'); if (!inv) throw new Error('Invite not found'); if (inv.toUserId !== actingUserId) throw new Error('Not allowed'); inv.status='REJECTED'; broadcast({ type: 'lobby:invite:declined', toUserId: actingUserId, lobbyId: inv.lobbyId }); }); },
  requestJoinLobbyByName(userId, lobbyName) { this.mutate(db => { const lobby = db.conversations.find(c=>c.type==='LOBBY' && (c.name||'').toLowerCase()===lobbyName.trim().toLowerCase()); if (!lobby) throw new Error('Lobby not found'); const exists = db.members.find(m=>m.userId===userId && m.conversationId===lobby.id); if (exists) throw new Error('Already a member'); const alreadyReq = db.invites.find(i=>i.kind==='REQUEST' && i.lobbyId===lobby.id && i.fromUserId===userId && i.status==='PENDING'); if (alreadyReq) throw new Error('Request already pending'); const req = { id: db.nextIds.invite++, kind: 'REQUEST', lobbyId: lobby.id, fromUserId: userId, toUserId: null, status: 'PENDING', createdAt: now() }; db.invites.push(req); broadcast({ type: 'lobby:request:new', fromUserId: userId, lobbyId: lobby.id }); }); },
  listLobbyRequestsForUser(userId) { const db = loadDB(); const myAdminOf = db.conversations.filter(c=>c.type==='LOBBY' && db.members.some(m=>m.conversationId===c.id && m.userId===userId && (m.role==='OWNER'||m.role==='ADMIN'))).map(c=>c.id); return db.invites.filter(i=>i.kind==='REQUEST' && i.status==='PENDING' && myAdminOf.includes(i.lobbyId)); },
  approveLobbyRequest(inviteId, actorId) { this.mutate(db => { const inv = db.invites.find(i=>i.id===inviteId && i.kind==='REQUEST'); if (!inv) throw new Error('Request not found'); const admin = db.members.find(m=>m.conversationId===inv.lobbyId && m.userId===actorId); if (!admin || (admin.role!=='OWNER' && admin.role!=='ADMIN')) throw new Error('Not allowed'); inv.status='ACCEPTED'; const exists = db.members.find(m=>m.userId===inv.fromUserId && m.conversationId===inv.lobbyId); if (!exists) db.members.push({ userId: inv.fromUserId, conversationId: inv.lobbyId, role: 'MEMBER', joinedAt: now(), invitedById: actorId }); window.dispatchEvent(new CustomEvent('chat:membership', { detail: { kind: 'lobby-joined', conversationId: inv.lobbyId, userId: inv.fromUserId } })); broadcast({ type: 'membership:event', kind: 'lobby-joined', conversationId: inv.lobbyId }); }); },
  rejectLobbyRequest(inviteId, actorId) { this.mutate(db => { const inv = db.invites.find(i=>i.id===inviteId && i.kind==='REQUEST'); if (!inv) throw new Error('Request not found'); const admin = db.members.find(m=>m.conversationId===inv.lobbyId && m.userId===actorId); if (!admin || (admin.role!=='OWNER' && admin.role!=='ADMIN')) throw new Error('Not allowed'); inv.status='REJECTED'; broadcast({ type: 'lobby:request:rejected', fromUserId: inv.fromUserId, lobbyId: inv.lobbyId }); }); },
  updateLobby(conversationId, actorId, { name, description, avatar }) { this.mutate(db => { const convo = db.conversations.find(c => c.id === conversationId); if (!convo || convo.type !== 'LOBBY') throw new Error('Lobby not found'); const actor = db.members.find(m => m.conversationId===conversationId && m.userId===actorId); if (!actor || (actor.role!=='OWNER' && actor.role!=='ADMIN')) throw new Error('Only admins/owner can edit'); if (typeof name === 'string' && name.trim()) convo.name = name.trim(); if (typeof description === 'string') convo.description = description; if (typeof avatar === 'string') convo.avatar = avatar; convo.updatedAt = now(); broadcast({ type: 'convo:update', conversationId }); }); },
  listMessages(conversationId, limit=200) { const db = loadDB(); return db.messages.filter(m => m.conversationId === conversationId).sort((a,b) => a.id - b.id).slice(-limit); },
  lastMessage(conversationId) { const msgs = this.listMessages(conversationId, 1e9); return msgs[msgs.length-1] || null; },
  postMessage(conversationId, senderId, body, metadata) { this.mutate(db => { const msg = { id: db.nextIds.message++, conversationId, senderId, body, metadata, createdAt: now() }; db.messages.push(msg); const convo = db.conversations.find(c => c.id === conversationId); if (convo) convo.updatedAt = now(); const sender = db.users.find(u=>u.id===senderId); if (sender) sender.lastSeen = now(); window.dispatchEvent(new CustomEvent('chat:new', { detail: { msg } })); broadcast({ type: 'chat:new', msg }); }); },
  updateMessage(conversationId, messageId, updater) { this.mutate(db => { const m = db.messages.find(x=>x.id===messageId && x.conversationId===conversationId); if (!m) throw new Error('Message not found'); const next = updater({ ...m }); Object.assign(m, next); window.dispatchEvent(new CustomEvent('chatdb:update')); }); },
  reactMessage(conversationId, messageId, emoji, userId) { this.updateMessage(conversationId, messageId, (m)=>{ const meta = m.metadata||{}; const reactions = meta.reactions || {}; const arr = reactions[emoji] || []; const idx = arr.indexOf(userId); if (idx>=0) arr.splice(idx,1); else arr.push(userId); reactions[emoji] = arr; meta.reactions = reactions; return { metadata: meta }; }); },
  pinMessage(conversationId, messageId, pin=true) { this.updateMessage(conversationId, messageId, (m)=>{ const meta = m.metadata||{}; meta.pinned = !!pin; return { metadata: meta }; }); },
  async ensureServerMembership(roomId, usernames) {
    // Call server API to ensure all users are members of the room
    try {
      await fetch('/api/room/ensure-membership', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ roomId: String(roomId), usernames })
      });
    } catch (e) {
      console.warn('Failed to ensure server membership:', e);
    }
  },
};

if (bc) {
  bc.onmessage = (e) => {
    const { type, ...detail } = e.data || {};
    if (!type) return;
    if (type === 'db:update') { window.dispatchEvent(new CustomEvent('chatdb:update')); }
    if (type === 'chat:new') { window.dispatchEvent(new CustomEvent('chat:new', { detail })); }
    if (type === 'membership:event') { window.dispatchEvent(new CustomEvent('chat:membership', { detail })); }
    if (type === 'presence:update') { window.dispatchEvent(new CustomEvent('presence:update', { detail })); window.dispatchEvent(new CustomEvent('chatdb:update')); }
    if (type.startsWith('lobby:')) { window.dispatchEvent(new CustomEvent(type, { detail })); }
    if (type === 'convo:update' || type === 'convo:new') { window.dispatchEvent(new CustomEvent('chatdb:update')); }
    if (type === 'user:updated') { window.dispatchEvent(new CustomEvent('chatdb:update')); }
  };
}

function presenceFor(user) {
  const ms = now() - (user?.lastSeen||0);
  if (ms < 2*60*1000) return 'ONLINE';
  if (ms < 10*60*1000) return 'AWAY';
  return 'OFFLINE';
}

const EMOJIS = [
  { ch:"👍", name:"thumbs up" }, { ch:"❤️", name:"red heart" }, { ch:"😂", name:"joy" }, { ch:"🎉", name:"tada" },
  { ch:"🔥", name:"fire" }, { ch:"🙏", name:"pray" }, { ch:"😊", name:"smile" }, { ch:"✨", name:"sparkles" },
  { ch:"😀", name:"grinning" }, { ch:"😁", name:"beaming" }, { ch:"🤣", name:"rofl" }, { ch:"😎", name:"cool" },
  { ch:"🤔", name:"thinking" }, { ch:"😴", name:"sleep" }, { ch:"🙌", name:"raised hands" }, { ch:"👏", name:"clap" },
  { ch:"💙", name:"blue heart" }, { ch:"💯", name:"100" }, { ch:"🧠", name:"brain" }, { ch:"🚀", name:"rocket" },
  { ch:"☕", name:"coffee" }, { ch:"🍕", name:"pizza" }, { ch:"🪄", name:"magic" }, { ch:"📎", name:"paperclip" }
];

function EmojiPicker({ onPick, recentKey='recent_emojis' }) {
  const [q, setQ] = useState("");
  const [recent, setRecent] = useState(()=>{
    try { return JSON.parse(localStorage.getItem(recentKey)||'[]'); } catch { return []; }
  });
  const filtered = useMemo(() => { const s = q.trim().toLowerCase(); return !s ? EMOJIS : EMOJIS.filter(e => e.name.includes(s)); }, [q]);
  function pick(ch){
    onPick(ch);
    const next = [ch, ...recent.filter(x=>x!==ch)].slice(0,8);
    setRecent(next);
    localStorage.setItem(recentKey, JSON.stringify(next));
  }
  return (
    <div className="border rounded-2xl p-3 bg-white shadow-sm w-64">
      <input value={q} onChange={e=>setQ(e.target.value)} placeholder="Search emojis…" className="w-full px-2 py-1 text-sm border rounded-lg" />
      {recent.length>0 && (
        <div className="mt-2">
          <div className="text-xs text-gray-500 mb-1">Recent</div>
          <div className="flex flex-wrap gap-2">
            {recent.map(ch => <button key={ch} onClick={()=>pick(ch)} className="text-xl leading-none hover:scale-110">{ch}</button>)}
          </div>
        </div>
      )}
      <div className="grid grid-cols-8 gap-2 max-h-40 overflow-y-auto">
        {filtered.map(e => (
          <button key={e.ch+e.name} onClick={()=>pick(e.ch)} className="text-xl leading-none hover:scale-110">{e.ch}</button>
        ))}
      </div>
    </div>
  );
}

function Section({ title, children, right }) {
  return (
    <div className="mb-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-700">{title}</h3>
        {right}
      </div>
      <div className="mt-2">{children}</div>
    </div>
  );
}

function Pill({ children, className="" }) { return <span className={`px-2 py-0.5 text-xs rounded-full bg-gray-100 ${className}`}>{children}</span>; }
const Input = forwardRef(function Input(props, ref) { const { className, ...rest } = props; return <input ref={ref} {...rest} className={`w-full px-3 py-2 rounded-lg border border-gray-300 focus:outline-none focus:ring ${className||''}`} /> });
function Button({ children, onClick, className="", disabled, type="button" }) { return <button type={type} onClick={onClick} disabled={disabled} className={`px-3 py-2 rounded-lg bg-black text-white text-sm disabled:opacity-50 btn-transitions ${className}`}>{children}</button> }
function Textarea(props) { return <textarea {...props} className={`w-full px-3 py-2 rounded-lg border border-gray-300 focus:outline-none focus:ring h-24 ${props.className||''}`} /> }
function formatTime(ts) { const d = new Date(ts); return d.toLocaleString(); }
function renderText(str) {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const parts = String(str||'').split(urlRegex);
  return parts.map((part, idx) => {
    if (urlRegex.test(part)) {
      return <a key={idx} href={part} target="_blank" rel="noopener noreferrer" className="underline break-words">{part}</a>;
    }
    return <span key={idx}>{part}</span>;
  });
}
function previewText(str, max=80) {
  const s = String(str||'').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max-1)) + '…';
}

function Toggle({ checked, onChange, label }) {
  return (
    <label className="flex items-center gap-3 select-none cursor-pointer">
      <span className="text-sm">{label}</span>
      <span className={`inline-flex items-center w-10 h-6 rounded-full transition-colors ${checked? 'bg-black':'bg-gray-300'}`} onClick={()=>onChange(!checked)}>
        <span className={`inline-block w-5 h-5 bg-white rounded-full shadow transform transition-transform ${checked? 'translate-x-4':'translate-x-1'}`} />
      </span>
    </label>
  );
}
function hashToHue(str='A'){ let h=0; for(let i=0;i<str.length;i++){ h=(h*31+str.charCodeAt(i))%360; } return h; }
function Avatar({ user, size=32 }) { const style = { width: size, height: size };
  const status = user?.showActive ? presenceFor(user) : null;
  const ring = status==='ONLINE'? 'ring-2 ring-green-500' : status==='AWAY'? 'ring-2 ring-yellow-400' : status==='OFFLINE'? 'ring-2 ring-gray-400' : '';
  if (user?.avatar) return <img src={user.avatar} alt={user.username} className={`rounded-full object-cover shadow-sm ${ring}`} style={style} />;
  const hue = hashToHue(String(user?.username||'U'));
  const bg = `linear-gradient(135deg, hsl(${hue},80%,55%), hsl(${(hue+40)%360},80%,60%))`;
  return <div className={`rounded-full text-white flex items-center justify-center uppercase shadow-sm ${ring}`} style={{...style, background: bg}}>{user?.username?.slice(0,1)}</div>;
}
function labelForDirect(convo, myId) { const ms = dao.listMembers(convo.id); const others = ms.map(m=>m.userId).filter(id=>id!==myId); const other = dao.findUserById(others[0]); return other ? other.username : "Direct chat"; }
function labelForConvo(convoId, myId) { const c = dao.getConversation(convoId); if (!c) return `Conversation #${convoId}`; return c.name || (c.type==='DIRECT' ? labelForDirect(c, myId) : (c.type==='GROUP' ? `Group #${c.id}` : c.name || `Lobby #${c.id}`)); }

function ToastCenter({ me, activeConversationId }) {
  const [toasts, setToasts] = useState([]);
  useEffect(() => {
    function pushToast(convoId, senderId) {
      setToasts(prev => {
        const idx = prev.findIndex(t => t.convoId === convoId);
        const sender = dao.findUserById(senderId);
        const label = labelForConvo(convoId, me.id);
        if (idx >= 0) { const next = [...prev]; next[idx] = { ...next[idx], count: next[idx].count + 1, label, senderName: sender?.username }; return next; }
        const t = { id: `${convoId}-${Date.now()}`, convoId, label, senderName: sender?.username, count: 1 };
        const ms = 5000; setTimeout(() => setToasts(p => p.filter(x => x.id !== t.id)), ms);
        return [...prev, t];
      });
    }
    function pushInfoToast(text) { const t = { id: `i-${Date.now()}`, convoId: null, label: text, senderName: undefined, count: 1 }; setToasts(prev=>{ const ms=5000; setTimeout(()=>setToasts(p=>p.filter(x=>x.id!==t.id)), ms); return [...prev, t]; }); }
    const onNew = (e) => {
      const { msg } = e.detail;
      if (!msg) return;
      if (msg.senderId === me.id) return;
      // Only notify if I'm a member of that conversation
      const isMember = dao.isMember(msg.conversationId, me.id);
      if (!isMember) return;
      if (msg.conversationId === activeConversationId) return;
      const label = `${dao.findUserById(msg.senderId)?.username}: ${msg.body}`;
      pushToast({ kind:'message', convoId: msg.conversationId, label, ts: now() });
    };
    const onMembership = (e) => { const { kind, conversationId } = e.detail||{}; const label = labelForConvo(conversationId, me.id) || 'Conversation'; const msg = kind==='lobby-joined'?`Joined lobby: ${label}`: kind==='group-created'?`Group created: ${label}`: kind==='lobby-created'?`Lobby created: ${label}`: 'Membership update'; pushInfoToast(msg); };
    const onReqRejected = (e) => { if (e.detail?.fromUserId===me.id) pushInfoToast('Your lobby request was rejected'); };
    const onInviteNew = (e) => { if (e.detail?.toUserId===me.id) pushInfoToast('You have a new lobby invite'); };
    const onInviteDeclined = (e) => { if (e.detail?.toUserId===me.id) pushInfoToast('You declined a lobby invite'); };
    window.addEventListener('chat:new', onNew);
    window.addEventListener('chat:membership', onMembership);
    window.addEventListener('lobby:request:rejected', onReqRejected);
    window.addEventListener('lobby:invite:new', onInviteNew);
    window.addEventListener('lobby:invite:declined', onInviteDeclined);
    return () => {
      window.removeEventListener('chat:new', onNew);
      window.removeEventListener('chat:membership', onMembership);
      window.removeEventListener('lobby:request:rejected', onReqRejected);
      window.removeEventListener('lobby:invite:new', onInviteNew);
      window.removeEventListener('lobby:invite:declined', onInviteDeclined);
    };
  }, [me.id, activeConversationId]);
  return (
    <div className="fixed top-4 right-4 z-50 space-y-2">
      {toasts.map(t => (
        <div key={t.id} className="bg-black text-white rounded-xl shadow px-3 py-2 w-72">
          <div className="flex items-start justify-between">
            <div>
              <div className="text-xs opacity-70">Notification</div>
              <div className="text-sm font-medium truncate">{t.label}</div>
              {t.senderName && <div className="text-xs opacity-80">from {t.senderName} · {t.count} {t.count>1?"messages":"message"}</div>}
            </div>
            <button className="ml-3 opacity-70 hover:opacity-100" onClick={()=>setToasts(prev=>prev.filter(x=>x.id!==t.id))}>×</button>
          </div>
        </div>
      ))}
    </div>
  );
}

function NotificationBell({ me, activeConversationId, onOpenConversation, open, onOpenChange }) {
  const [count, setCount] = useState(0);
  const [ring, setRing] = useState(false);
  const [items, setItems] = useState([]); // {id, kind, convoId, label, ts}
  const ref = useRef(null);
  // Inject keyframes for ring effect once
  useEffect(() => {
    if (document.getElementById('notif-ring-keyframes')) return;
    const style = document.createElement('style');
    style.id = 'notif-ring-keyframes';
    style.innerHTML = "@keyframes bellRing {0%{transform:rotate(0)}10%{transform:rotate(15deg)}20%{transform:rotate(-15deg)}30%{transform:rotate(10deg)}40%{transform:rotate(-10deg)}50%{transform:rotate(6deg)}60%{transform:rotate(-6deg)}100%{transform:rotate(0)}}";
    document.head.appendChild(style);
  }, []);
  function pushItem(it) {
    setItems(prev => [{ ...it, id: `${it.convoId||it.kind}-${Date.now()}` }, ...prev].slice(0,50));
    setCount(c => c + 1);
    setRing(true); setTimeout(()=>setRing(false), 700);
  }
  // Clear counter when opened but keep items
  useEffect(() => { if (open && count>0) setCount(0); }, [open]);
  // Close on outside click
  useEffect(() => {
    function onDoc(e){ if (!ref.current) return; if (!ref.current.contains(e.target)) onOpenChange(false); }
    if (open) { document.addEventListener('mousedown', onDoc); return ()=>document.removeEventListener('mousedown', onDoc); }
  }, [open, onOpenChange]);
  useEffect(() => {
    const onNew = (e) => { const { msg } = e.detail; if (msg.senderId === me.id) return; if (msg.conversationId === activeConversationId) return; const label = `${dao.findUserById(msg.senderId)?.username}: ${msg.body}`; pushItem({ kind:'message', convoId: msg.conversationId, label, ts: now() }); };
    const onMembership = (e) => { const { kind, conversationId } = e.detail||{}; const text = kind==='lobby-joined'? 'Lobby joined' : kind==='group-created'? 'Group created' : kind==='lobby-created'? 'Lobby created' : 'Membership update'; pushItem({ kind, convoId: conversationId, label: text, ts: now() }); };
    const onReqRejected = (e) => { if (e.detail?.fromUserId===me.id) pushItem({ kind:'request-rejected', convoId: e.detail.lobbyId, label:'Lobby request rejected', ts: now() }); };
    const onInviteNew = (e) => { if (e.detail?.toUserId===me.id) pushItem({ kind:'invite', convoId: e.detail.lobbyId, label:'New lobby invite', ts: now() }); };
    window.addEventListener('chat:new', onNew);
    window.addEventListener('chat:membership', onMembership);
    window.addEventListener('lobby:request:rejected', onReqRejected);
    window.addEventListener('lobby:invite:new', onInviteNew);
    return () => { window.removeEventListener('chat:new', onNew); window.removeEventListener('chat:membership', onMembership); window.removeEventListener('lobby:request:rejected', onReqRejected); window.removeEventListener('lobby:invite:new', onInviteNew); };
  }, [me.id, activeConversationId]);
  // Don't auto-clear notifications when viewing conversation - let user decide
  const clearAll = () => { setItems([]); setCount(0); };
  const removeItem = (it) => { setItems(prev => prev.filter(x => x !== it)); };
  const openItem = (it) => { if (it.convoId) onOpenConversation?.(it.convoId); onOpenChange(false); };
  return (
    <div className="relative" ref={ref}>
      <button className="relative px-3 py-2 rounded-lg border hover:bg-gray-50" onClick={() => onOpenChange(!open)} title="Notifications">
        <span className="inline-block" style={{ display:'inline-block', transformOrigin:'top center', animation: ring? 'bellRing 0.6s ease':'' }}>
          {/* Minimalist bell SVG */}
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10 20a2 2 0 0 0 4 0"/>
            <path d="M22 17h-2a3 3 0 0 1-3-3V9a5 5 0 0 0-10 0v5a3 3 0 0 1-3 3H2"/>
          </svg>
        </span>
        {(!open && count > 0) && (
          <span className="absolute -top-1 -right-1 bg-black text-white text-[10px] px-1.5 py-0.5 rounded-full">{count}</span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-80 bg-white border rounded-2xl shadow z-20 p-2 max-h-80 overflow-y-auto">
          <div className="flex items-center justify-between px-1 pb-2">
            <div className="text-sm font-semibold">Notifications</div>
            <button className="text-xs text-gray-500 hover:underline" onClick={clearAll}>Clear all</button>
          </div>
          {items.length===0 ? (
            <div className="text-xs text-gray-500 px-2 py-6 text-center">No notifications</div>
          ) : (
            <div className="space-y-1">
              {items.map(it => (
                <div key={it.id} className="flex items-start gap-2 p-2 rounded-lg hover:bg-gray-50">
                  <button className="flex-1 text-left" onClick={()=>openItem(it)}>
                    <div className="flex items-start gap-2">
                      <span className="mt-1">🔔</span>
                      <span className="text-sm">
                        <span className="font-medium">{it.label}</span>
                        {it.convoId && <span className="text-xs text-gray-500"> · Convo #{it.convoId}</span>}
                      </span>
                    </div>
                  </button>
                  <button className="text-gray-400 hover:text-gray-600 text-xs px-1" onClick={()=>removeItem(it)} title="Remove">×</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Modal({ open, onClose, title, children, footer }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative bg-white w-full max-w-lg rounded-2xl shadow p-4 z-10">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-semibold">{title}</h3>
          <button onClick={onClose} className="text-xl">×</button>
        </div>
        <div className="max-h-[60vh] overflow-y-auto">{children}</div>
        {footer && <div className="mt-4 flex justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}

function ProfileView({ user }) {
  const [showImageModal, setShowImageModal] = useState(false);
  if (!user) return null;
  const memberships = dao.listUserMemberships(user.id);
  const convos = memberships.map(m => dao.getConversation(m.conversationId)).filter(Boolean);
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <div className="cursor-pointer" onClick={() => setShowImageModal(true)}>
          <Avatar user={user} size={56} />
        </div>
        <div>
          <div className="text-lg font-semibold">{user.username}</div>
          {user.bio && <div className="text-sm text-gray-600">{user.bio}</div>}
        </div>
      </div>
      
      {/* Image Modal */}
      {showImageModal && (
        <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50" onClick={() => setShowImageModal(false)}>
          <div className="max-w-screen max-h-screen p-4" onClick={e => e.stopPropagation()}>
            <img 
              src={user.avatar || `https://api.dicebear.com/7.x/initials/svg?seed=${user.username}`} 
              alt={`${user.username}'s profile`}
              className="max-w-full max-h-full object-contain rounded-lg"
            />
            <button 
              onClick={() => setShowImageModal(false)}
              className="absolute top-4 right-4 text-white bg-black bg-opacity-50 rounded-full p-2 hover:bg-opacity-75"
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          </div>
        </div>
      )}
      <div>
        <h4 className="text-sm font-semibold mb-1">Memberships</h4>
        <div className="space-y-1">
          {convos.map(c => (
            <div key={c.id} className="text-sm flex items-center gap-2">
              {c.type==='DIRECT' && <Pill>DM</Pill>}
              {c.type==='GROUP' && <Pill className="bg-blue-100">Group</Pill>}
              {c.type==='LOBBY' && <Pill className="bg-green-100">Lobby</Pill>}
              <span>{c.name || `Conversation #${c.id}`}</span>
            </div>
          ))}
          {convos.length===0 && <div className="text-xs text-gray-500">No memberships yet.</div>}
        </div>
      </div>
    </div>
  );
}

function ProfileEdit({ me, onClose, onSaved }) {
  const [username, setUsername] = useState(me.username);
  const [password, setPassword] = useState("");
  const [bio, setBio] = useState(me.bio || "");
  const [showActive, setShowActive] = useState(!!me.showActive);
  const fileRef = useRef(null);
  const [err, setErr] = useState("");
  function save() { try { dao.updateUser(me.id, { username: username.trim(), password: password || undefined, bio, showActive }); onSaved(); onClose(); } catch (e) { setErr(e.message); } }
  function onPickFile(e) { const f = e.target.files?.[0]; if (!f) return; const reader = new FileReader(); reader.onload = () => { dao.updateUser(me.id, { avatar: reader.result }); onSaved(); }; reader.readAsDataURL(f); }
  return (
    <div className="space-y-3">
      {err && <div className="text-red-600 text-sm">{err}</div>}
      <div className="flex items-center gap-3">
        <Avatar user={me} size={56} />
        <div className="flex gap-2">
          <Button onClick={()=>fileRef.current?.click()} className="bg-gray-700">Change avatar</Button>
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onPickFile} />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-2">
        <Input value={username} onChange={e=>setUsername(e.target.value)} placeholder="Username" onKeyDown={e=>{ if(e.key==='Enter') save(); }} />
        <Input value={password} type="password" onChange={e=>setPassword(e.target.value)} placeholder="New password (optional)" onKeyDown={e=>{ if(e.key==='Enter') save(); }} />
        <Textarea value={bio} onChange={e=>setBio(e.target.value)} placeholder="Bio (optional)" />
      </div>
      <div className="px-1">
        <label className="flex items-center justify-between p-2 border rounded-xl">
          <span className="text-sm">Show active status (green/yellow/grey ring)</span>
          <input type="checkbox" checked={showActive} onChange={e=>setShowActive(e.target.checked)} />
        </label>
      </div>
      <div className="flex justify-end gap-2">
        <Button className="bg-gray-700" onClick={onClose}>Cancel</Button>
        <Button onClick={save}>Save</Button>
      </div>
    </div>
  );
}

function MemberRow({ me, convo, member, canManage, onChanged }) {
  const u = dao.findUserById(member.userId);
  return (
    <div className="flex items-center justify-between p-2 border rounded-lg">
      <div className="flex items-center gap-2">
        <Avatar user={u} size={24} /><span className="text-sm">{u?.username}</span>
        <Pill className="ml-2">{member.role}</Pill>
      </div>
      {canManage && me.id!==member.userId && (
        <div className="flex gap-2">
          <Button className="bg-gray-700" onClick={()=>{ try { dao.setMemberRole(convo.id, me.id, member.userId,'MEMBER'); onChanged(); } catch(e){ alert(e.message);} }}>Make Member</Button>
          <Button onClick={()=>{ try { dao.setMemberRole(convo.id, me.id, member.userId,'ADMIN'); onChanged(); } catch(e){ alert(e.message);} }}>Make Admin</Button>
          <Button className="bg-gray-700" onClick={()=>{ try { dao.removeMember(convo.id, me.id, member.userId); onChanged(); } catch(e){ alert(e.message);} }}>Remove</Button>
        </div>
      )}
    </div>
  );
}

function LobbyInfo({ me, convo, onClose, onSaved }) {
  const [name, setName] = useState(convo.name || "Lobby");
  const [desc, setDesc] = useState(convo.description || "");
  const [err, setErr] = useState("");
  const fileRef = useRef(null);
  const members = dao.listMembers(convo.id);
  const myRole = dao.getRole(convo.id, me.id);
  const canEdit = myRole==='OWNER' || myRole==='ADMIN';
  function save() { try { dao.updateLobby(convo.id, me.id, { name, description: desc }); onSaved(); onClose(); } catch (e) { setErr(e.message); }
  }
  function onPickFile(e) { const f = e.target.files?.[0]; if (!f) return; const reader = new FileReader(); reader.onload = () => { try { dao.updateLobby(convo.id, me.id, { avatar: reader.result }); onSaved(); } catch (er) { alert(er.message); } }; reader.readAsDataURL(f); }
  return (
    <div className="space-y-3">
      {err && <div className="text-red-600 text-sm">{err}</div>}
      <div className="flex items-center gap-3">
        {convo.avatar ? <img src={convo.avatar} alt="Lobby" className="rounded-full w-14 h-14 object-cover" /> : <div className="rounded-full w-14 h-14 bg.green-100 flex items-center justify-center">L</div>}
        {canEdit && (
          <div className="flex gap-2">
            <Button onClick={()=>fileRef.current?.click()} className="bg-gray-700">Change icon</Button>
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onPickFile} />
          </div>
        )}
      </div>
      <div className="grid grid-cols-1 gap-2">
        <Input value={name} onChange={e=>setName(e.target.value)} placeholder="Lobby name" disabled={!canEdit} />
        <Textarea value={desc} onChange={e=>setDesc(e.target.value)} placeholder="Bio/description" disabled={!canEdit} />
      </div>
      <div>
        <h4 className="text-sm font-semibold mb-1">Members</h4>
        <div className="space-y-1">
          {members.map(m => (
            <MemberRow key={m.userId} me={me} convo={convo} member={m} canManage={myRole==='OWNER' || myRole==='ADMIN'} onChanged={onSaved} />
          ))}
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Button className="bg-gray-700" onClick={onClose}>Close</Button>
        {canEdit && <Button onClick={save}>Save</Button>}
      </div>
    </div>
  );
}

function GroupInfo({ me, convo, onClose, onSaved }) {
  const [name, setName] = useState(convo.name || "Group");
  const [desc, setDesc] = useState(convo.description || "");
  const members = dao.listMembers(convo.id);
  const myRole = dao.getRole(convo.id, me.id);
  const canEdit = myRole==='OWNER' || myRole==='ADMIN';
  function save() { try { dao.updateGroup(convo.id, me.id, { name, description: desc }); onSaved(); onClose(); } catch (e) { alert(e.message); } }
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-2">
        <Input value={name} onChange={e=>setName(e.target.value)} placeholder="Group name" disabled={!canEdit} />
        <Textarea value={desc} onChange={e=>setDesc(e.target.value)} placeholder="Description" disabled={!canEdit} />
      </div>
      <div>
        <h4 className="text-sm font-semibold mb-1">Members</h4>
        <div className="space-y-1">
          {members.map(m => (
            <MemberRow key={m.userId} me={me} convo={convo} member={m} canManage={myRole==='OWNER' || myRole==='ADMIN'} onChanged={onSaved} />
          ))}
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Button className="bg-gray-700" onClick={onClose}>Close</Button>
        {canEdit && <Button onClick={save}>Save</Button>}
      </div>
    </div>
  );
}

function AuthView({ onAuthed }) {
  const [mode, setMode] = useState(()=>{
    try { return sessionStorage.getItem('initial_auth_mode') || 'login'; } catch { return 'login'; }
  });
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [err, setErr] = useState("");
  const userRef = useRef(null); const passRef = useRef(null); const confirmRef = useRef(null);
  
  async function submit() {
    try {
      setErr("");
      const uName = username.trim(); const pw = password;
      
      // Client-side validation
      if (uName.length < 3) {
        setErr("Username must be at least 3 characters");
        return;
      }
      if (uName.length > 64) {
        setErr("Username must be no more than 64 characters");
        return;
      }
      if (pw.length < 6) {
        setErr("Password must be at least 6 characters");
        return;
      }
      if (pw.length > 200) {
        setErr("Password must be no more than 200 characters");
        return;
      }
      
      // Confirm password validation for signup
      if (mode === 'signup' && pw !== confirmPassword) {
        setErr("Passwords do not match");
        return;
      }
      
      if (mode === 'signup') {
        const r = await fetch('/api/register', { method:'POST', headers:{'Content-Type':'application/json'}, credentials:'include', body: JSON.stringify({ username: uName, password: pw }) });
        const j = await r.json(); 
        if (!j.ok) {
          const errorMsg = j.error || 'Sign up failed';
          console.error('Registration failed:', { status: r.status, response: j });
          throw new Error(errorMsg);
        }
      }
      const r2 = await fetch('/api/login', { method:'POST', headers:{'Content-Type':'application/json'}, credentials:'include', body: JSON.stringify({ username: uName, password: pw }) });
      const j2 = await r2.json(); 
      if (!j2.ok) {
        const errorMsg = j2.error || 'Login failed';
        console.error('Login failed:', { status: r2.status, response: j2 });
        throw new Error(errorMsg);
      }
      // Establish Socket.IO connection with cookie auth and auto-join lobby for messaging
      window.socket = io();
      try {
        window.socket.on('connect', () => {
          try { window.socket.emit('join', { roomId: 'lobby', name: uName }); } catch {}
        });
      } catch {}
      // Minimal user object
      const user = dao.findUserByUsername(uName) || dao.createUser(uName, pw);
      onAuthed(user);
    } catch (e) { setErr(e.message || 'Auth failed'); }
  }
  
  return (
    <div className="min-h-[60vh] flex flex-col items-center justify-center">
      <div className="w-full max-w-md bg-white shadow rounded-2xl p-6">
        <div className="flex gap-2 mb-4">
          <button className={`flex-1 rounded-xl py-2 ${mode==="login"?"bg-black text-white":"bg-gray-100"}`} onClick={()=>setMode("login")}>Login</button>
          <button className={`flex-1 rounded-xl py-2 ${mode==="signup"?"bg-black text-white":"bg-gray-100"}`} onClick={()=>setMode("signup")}>Sign up</button>
        </div>
        <form className="space-y-3" onSubmit={e=>{e.preventDefault(); submit();}}>
          <Input ref={userRef} placeholder="Username (3-64 characters)" value={username} onChange={e=>setUsername(e.target.value)} onKeyDown={e=>{ if(e.key==='Enter'){ e.preventDefault(); passRef.current?.focus(); } }} />
          
          <div className="relative">
            <Input 
              ref={passRef} 
              placeholder="Password (6+ characters)" 
              type={showPassword ? "text" : "password"} 
              value={password} 
              onChange={e=>setPassword(e.target.value)} 
              onKeyDown={e=>{ if(e.key==='Enter'){ e.preventDefault(); mode === 'signup' ? confirmRef.current?.focus() : submit(); } }} 
            />
            <button 
              type="button" 
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-700"
              onClick={() => setShowPassword(!showPassword)}
            >
              {showPassword ? (
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
                  <line x1="1" y1="1" x2="23" y2="23"/>
                </svg>
              ) : (
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                  <circle cx="12" cy="12" r="3"/>
                </svg>
              )}
            </button>
          </div>
          
          {mode === 'signup' && (
            <div className="relative">
              <Input 
                ref={confirmRef}
                placeholder="Confirm Password" 
                type={showConfirmPassword ? "text" : "password"} 
                value={confirmPassword} 
                onChange={e=>setConfirmPassword(e.target.value)} 
                onKeyDown={e=>{ if(e.key==='Enter'){ e.preventDefault(); submit(); } }} 
              />
              <button 
                type="button" 
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-700"
                onClick={() => setShowConfirmPassword(!showConfirmPassword)}
              >
                {showConfirmPassword ? (
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
                    <line x1="1" y1="1" x2="23" y2="23"/>
                  </svg>
                ) : (
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                    <circle cx="12" cy="12" r="3"/>
                  </svg>
                )}
              </button>
            </div>
          )}
          
          {err && <div className="text-red-600 text-sm">{err}</div>}
          <Button className="w-full" type="submit">{mode==="login"?"Log in":"Create account & log in"}</Button>
          <p className="text-xs text-gray-500">Demo only. Try <b>alice</b>/<b>secret123</b> or <b>bob</b>/<b>secret123</b>.</p>
        </form>
      </div>
    </div>
  );
}

function ToolsPane({ me, onLogout, onOpenConversation }) {
  const [searchUsername, setSearchUsername] = useState("");
  const [searchResult, setSearchResult] = useState();
  const [groupOpen, setGroupOpen] = useState(false);
  const [lobbyOpen, setLobbyOpen] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [groupMembers, setGroupMembers] = useState("");
  const [lobbyQuery, setLobbyQuery] = useState("");
  const [lobbySearch, setLobbySearch] = useState([]);

  useEffect(() => {
    const update = () => {
      if (lobbyQuery.trim()) setLobbySearch(dao.searchLobbiesByName(lobbyQuery));
    };
    update();
    window.addEventListener('chatdb:update', update);
    return () => window.removeEventListener('chatdb:update', update);
  }, [me.id, lobbyQuery]);
  function doSearch() { const res = dao.findUserByUsername(searchUsername.trim()); setSearchResult(res ? res : null); }
  function startDM(u) { const convo = dao.ensureDM(me.id, u.username); onOpenConversation(convo.id); setSearchUsername(""); setSearchResult(undefined); }
  function createGroup() { const members = groupMembers.split(",").map(s=>s.trim()).filter(Boolean); const convo = dao.createGroup(me.id, groupName.trim(), members); setGroupName(""); setGroupMembers(""); onOpenConversation(convo.id); }
  function createLobby(name) { const convo = dao.createLobby(me.id, name.trim()); onOpenConversation(convo.id); }
  function requestJoin(name) { try { dao.requestJoinLobbyByName(me.id, name.trim()); alert('Request sent'); } catch(e) { alert(e.message); } }

  return (
    <div className="h-full overflow-y-auto p-3 space-y-4">

      <Section title="Find user (exact)">
        <form className="flex gap-2" onSubmit={e=>{e.preventDefault(); doSearch();}}>
          <Input value={searchUsername} onChange={e=>setSearchUsername(e.target.value)} placeholder="e.g. bob" />
          <Button type="submit">Search</Button>
        </form>
        {searchResult === null ? (
          <div className="text-xs text-gray-500 mt-2">No match.</div>
        ) : searchResult ? (
          <div className="mt-2 p-2 rounded-lg border flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Avatar user={searchResult} size={28} />
              <div className="text-sm">{searchResult.username}</div>
            </div>
            <div className="flex gap-2">
              <Button className="bg-gray-700" onClick={()=>startDM(searchResult)}>Message</Button>
              <button className="p-2 rounded-lg border hover:bg-gray-50" onClick={()=>window.dispatchEvent(new CustomEvent('profile:view',{ detail:{ userId: searchResult.id } }))} aria-label="Info">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"/>
                  <line x1="12" y1="16" x2="12" y2="12"/>
                  <line x1="12" y1="8" x2="12.01" y2="8"/>
                </svg>
              </button>
            </div>
          </div>
        ) : null}
      </Section>
      {/* Create Group - Clear Action */}
      <div className="rounded-xl border">
        <button className="w-full flex items-center justify-between px-3 py-2 hover:bg-gray-50" onClick={()=>setGroupOpen(o=>!o)}>
          <span className="text-sm font-semibold">Create Group</span>
          <span className="text-xs text-gray-500">{groupOpen? 'Hide':'Show'}</span>
        </button>
        {groupOpen && (
          <div className="p-3 border-t">
            <form className="space-y-2" onSubmit={e=>{e.preventDefault(); createGroup();}}>
              <Input value={groupName} onChange={e=>setGroupName(e.target.value)} placeholder="Group name" />
              <Input value={groupMembers} onChange={e=>setGroupMembers(e.target.value)} placeholder="Members (comma‑separated usernames)" />
              <Button type="submit" disabled={!groupName.trim()}>Create Group</Button>
            </form>
          </div>
        )}
      </div>

      {/* Join Room - Clear Action */}
      <div className="rounded-xl border">
        <button className="w-full flex items-center justify-between px-3 py-2 hover:bg-gray-50" onClick={()=>setLobbyOpen(o=>!o)}>
          <span className="text-sm font-semibold">Join Room</span>
          <span className="text-xs text-gray-500">{lobbyOpen? 'Hide':'Show'}</span>
        </button>
        {lobbyOpen && (
          <div className="p-3 border-t">
            <form className="flex gap-2" onSubmit={e=>{e.preventDefault(); setLobbySearch(dao.searchLobbiesByName(lobbyQuery));}}>
              <Input value={lobbyQuery} onChange={e=>setLobbyQuery(e.target.value)} placeholder="Search room name" />
              <Button type="submit">Search</Button>
            </form>
            {lobbyQuery.trim() && (
              <div className="mt-2 space-y-2">
                {lobbySearch.map(l => (
                  <div key={l.id} className="flex items-center justify-between p-2 border rounded-lg">
                    <div className="text-sm">{l.name}</div>
                    <div className="flex gap-2">
                      <Button onClick={()=>requestJoin(l.name)}>Request to Join</Button>
                    </div>
                  </div>
                ))}
                {dao.findLobbyByExactName(lobbyQuery) ? null : (
                  <div className="flex items-center justify-between p-2 border rounded-lg">
                    <div className="text-sm">Room "{lobbyQuery}" not found</div>
                    <Button onClick={()=>createLobby(lobbyQuery)}>Create Instead</Button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ConversationsPane({ me, onOpenConversation, onOpenInfo }) {
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState('ALL');
  const [tick, setTick] = useState(0);
  useEffect(() => { const onUpdate=()=>setTick(x=>x+1); window.addEventListener('chatdb:update', onUpdate); return ()=>window.removeEventListener('chatdb:update', onUpdate); }, []);
  // Removed erroneous listener code from ConversationsPane (listeners live in ConversationPane)
  const convosAll = useMemo(() => dao.listUserConversations(me.id), [me.id, tick]);
  const convosFiltered = useMemo(() => { let list = convosAll; if (filter !== 'ALL') list = list.filter(c => c.type === filter); if (q.trim()) list = list.filter(c => (c.name || labelForDirect(c, me.id)).toLowerCase().includes(q.trim().toLowerCase())); return list; }, [convosAll, filter, q, me.id]);
  const counts = useMemo(() => ({ ALL: convosAll.length, DIRECT: convosAll.filter(c=>c.type==='DIRECT').length, GROUP: convosAll.filter(c=>c.type==='GROUP').length, LOBBY: convosAll.filter(c=>c.type==='LOBBY').length }), [convosAll]);
  return (
    <div className="h-full overflow-y-auto p-3 space-y-3">
      <div className="flex items-center gap-2">
        <Input value={q} onChange={e=>setQ(e.target.value)} placeholder="Search" />
      </div>
      <div className="flex gap-2">
        {['ALL','DIRECT','GROUP','LOBBY'].map(k => (
          <button key={k} onClick={()=>setFilter(k)} className={`px-2 py-1 rounded-full text-xs border ${filter===k? 'bg-black text-white border-black':'bg-white'}`}>
            {k==='ALL'?`All (${counts.ALL})`:k==='DIRECT'?`DMs (${counts.DIRECT})`:k==='GROUP'?`Groups (${counts.GROUP})`:`Lobbies (${counts.LOBBY})`}
          </button>
        ))}
      </div>
      <div className="space-y-1">
        {convosFiltered.map(c => {
          const last = dao.lastMessage(c.id);
          const title = c.name || (c.type==='DIRECT'? labelForDirect(c, me.id) : c.name || `${c.type}`);
          const avatarUser = (c.type==='DIRECT') ? dao.findUserById(dao.listMembers(c.id).map(m=>m.userId).find(id=>id!==me.id)) : null;
          const unreadCount = dao.getUnreadCount(c.id, me.id);
          const hasUnread = unreadCount > 0;
          return (
            <div key={c.id} className={`flex items-center justify-between p-2 rounded-lg border hover:bg-gray-50 cursor-pointer ${hasUnread ? 'bg-blue-50 border-blue-200' : ''}`} onClick={()=>onOpenConversation(c.id)}>
              <div className="flex items-center gap-3 min-w-0">
                {c.type==='DIRECT' ? <Avatar user={avatarUser} /> : <div className={`${c.type==='GROUP'?'bg-blue-100':'bg-green-100'} rounded-full h-8 w-8 flex items-center justify-center text-sm`}>{c.type==='GROUP'?'G':'L'}</div>}
                <div className="min-w-0 flex-1">
                  <div className="text-sm flex items-center gap-2 min-w-0">
                    {c.type==='DIRECT' && <Pill>DM</Pill>}
                    {c.type==='GROUP' && <Pill className="bg-blue-100">Group</Pill>}
                    {c.type==='LOBBY' && <Pill className="bg-green-100">Lobby</Pill>}
                    <span className={`truncate ${hasUnread ? 'font-bold' : 'font-medium'}`}>{title}</span>
                    {hasUnread && (
                      <span className="bg-black text-white text-[10px] px-1.5 py-0.5 rounded-full min-w-[18px] text-center">{unreadCount > 99 ? '99+' : unreadCount}</span>
                    )}
                  </div>
          <div className={`text-xs text-gray-500 truncate block ${hasUnread ? 'font-semibold' : ''}`}>{last ? `${dao.findUserById(last.senderId)?.username}: ${previewText(last.body, 200)}` : 'No messages yet'}</div>
                </div>
              </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        {c.type!=='DIRECT' && (
          <button className="p-2 rounded-lg border hover:bg-gray-50" onClick={(e)=>{ e.stopPropagation(); onOpenInfo(c.id); }} aria-label="Info">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/>
              <line x1="12" y1="16" x2="12" y2="12"/>
              <line x1="12" y1="8" x2="12.01" y2="8"/>
            </svg>
          </button>
        )}
        {c.type==='DIRECT' && avatarUser && (
          <button className="p-2 rounded-lg border hover:bg-gray-50" onClick={(e)=>{ e.stopPropagation(); window.dispatchEvent(new CustomEvent('profile:view',{ detail:{ userId: avatarUser.id } })); }} aria-label="Info">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/>
              <line x1="12" y1="16" x2="12" y2="12"/>
              <line x1="12" y1="8" x2="12.01" y2="8"/>
            </svg>
          </button>
        )}
              </div>
            </div>
          );
        })}
        {convosFiltered.length===0 && <div className="text-xs text-gray-500">No conversations yet.</div>}
      </div>
    </div>
  );
}

function InviteUserPicker({ value, onChange, onPick }) {
  const [matches, setMatches] = useState([]);
  useEffect(() => { if (value.trim()) setMatches(dao.listUsersLike(value).slice(0,5)); else setMatches([]); }, [value]);
  return (
    <div className="relative w-full">
      <Input value={value} onChange={e=>onChange(e.target.value)} placeholder="Invite by username (search)" />
      {matches.length>0 && (
        <div className="absolute z-10 mt-1 w-full bg-white border rounded-xl shadow max-h-40 overflow-y-auto">
          {matches.map(u => (
            <button key={u.id} className="w-full text-left px-3 py-1.5 hover:bg-gray-50" onClick={()=>{ onPick(u.username); }}>
              <div className="flex items-center gap-2"><Avatar user={u} size={20} /><span className="text-sm">{u.username}</span></div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ConversationPane({ me, conversationId, forceInfoId, onConsumeForceInfo }) {
  const [inviteUser, setInviteUser] = useState("");
  const [body, setBody] = useState("");
  const [showEmoji, setShowEmoji] = useState(false);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [theme, setTheme] = useState(()=>localStorage.getItem('theme')||'light');
  const [dragOver, setDragOver] = useState(false);
  const [previews, setPreviews] = useState([]); // [{ name,size,type,dataUrl,id }]
  const [uploadQueue, setUploadQueue] = useState([]); // [{ id, file, name, size, progress, status:'queued'|'uploading'|'done'|'error', controller }]
  const [openInfo, setOpenInfo] = useState(false);
  const [reactFor, setReactFor] = useState(null); // messageId currently showing reaction picker
  const [tick, setTick] = useState(0);
  const [didInitialScroll, setDidInitialScroll] = useState(false);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [isLoadingEarlier, setIsLoadingEarlier] = useState(false);
  const scroller = useRef(null);
  const lastReadSentRef = useRef(null);
  // Join room on mount via Socket.IO
  useEffect(() => {
    if (!window.socket) return;
    const s = window.socket;
    const name = dao.findUserById(me.id)?.username || 'You';
    const tryJoin = () => s.emit('join', { roomId: String(conversationId), name });
    tryJoin();
    const onCreateRes = (res) => {
      if (!res || !res.ok) return;
      if (String(res.roomId) === String(conversationId)) tryJoin();
    };
    const onJoin = (payload) => {
      if (!payload || String(payload.roomId) !== String(conversationId)) return;
      if (!payload.ok) {
        if (payload.error === 'Room does not exist') {
          s.emit('create-room', { roomId: String(conversationId) });
        }
        return;
      }
      // Store initial read state for first-unread jump
      window.__joinReadState = { roomId: payload.roomId, ...(payload.readState||{}) };
      // Replace local history with server messages for this room
      try {
        const serverMsgs = Array.isArray(payload.messages) ? payload.messages : [];
        dao.mutate(db => {
          db.messages = db.messages.filter(m => m.conversationId !== conversationId);
          for (const m of serverMsgs) {
            db.messages.push({
              id: m.id,
              conversationId,
              senderId: m.userId,
              body: m.text,
              metadata: m.meta || {},
              createdAt: Number(m.ts || Date.now()),
            });
          }
          const convo = db.conversations.find(c=>c.id===conversationId);
          if (convo) convo.updatedAt = Date.now();
        });
        
        // Check if there are more messages to load
        setHasMoreMessages(serverMsgs.length >= 50);
      } catch {}
    };
    s.on('create-room-result', onCreateRes);
    s.on('join-result', onJoin);
    return () => { s.off('create-room-result', onCreateRes); s.off('join-result', onJoin); };
  }, [conversationId, me.id]);

  // Sign attachment URL on demand
  const signAttachmentUrl = async (attachmentId) => {
    try {
      const response = await fetch(`/api/attachments/${attachmentId}/sign`);
      if (!response.ok) throw new Error('Failed to sign attachment URL');
      
      const data = await response.json();
      if (data.ok && data.url) {
        return data.url;
      }
    } catch (e) {
      console.error('Failed to sign attachment URL:', e);
    }
    return null;
  };

  // Load earlier messages function
  const loadEarlierMessages = async () => {
    if (isLoadingEarlier || !hasMoreMessages) return;
    
    setIsLoadingEarlier(true);
    try {
      // Get the oldest message timestamp
      const oldestMessage = messages[0];
      if (!oldestMessage) return;
      
      // Request earlier messages from REST API
      const response = await fetch(`/api/rooms/${conversationId}/messages?before=${oldestMessage.createdAt}&limit=50`);
      if (!response.ok) throw new Error('Failed to fetch messages');
      
      const data = await response.json();
      if (data.ok && data.messages) {
        // Add messages to the beginning of the list
        dao.mutate(db => {
          const existingIds = new Set(db.messages.map(m => m.id));
          for (const msg of data.messages) {
            if (!existingIds.has(msg.id)) {
              db.messages.unshift({
                id: msg.id,
                conversationId,
                senderId: msg.userId,
                body: msg.text,
                metadata: msg.meta || {},
                createdAt: Number(msg.ts || Date.now()),
              });
            }
          }
        });
        
        // Update hasMore flag
        setHasMoreMessages(data.hasMore);
      }
    } catch (e) {
      console.error('Failed to load earlier messages:', e);
    } finally {
      setIsLoadingEarlier(false);
    }
  };
  useEffect(() => { const onUpdate=()=>setTick(x=>x+1); window.addEventListener('chatdb:update', onUpdate); return ()=>window.removeEventListener('chatdb:update', onUpdate); }, []);
  const convo = dao.getConversation(conversationId);
  const messages = dao.listMessages(conversationId);
  const isGroup = convo?.type === "GROUP"; const isLobby = convo?.type === "LOBBY";
  const myRole = dao.getRole(conversationId, me.id);
  const isMember = dao.isMember(conversationId, me.id);
  const otherId = convo?.type==='DIRECT' ? dao.listMembers(convo.id).map(m=>m.userId).find(id=>id!==me.id) : undefined;
  // Auto-scroll to first unread message or bottom
  useEffect(() => {
    const el = scroller.current; if (!el) return;
    
    // Check if we have read state from joining
    const joinReadState = window.__joinReadState;
    if (joinReadState && joinReadState.roomId === conversationId && joinReadState.lastReadMessageId) {
      // Find the first unread message
      const firstUnreadIndex = messages.findIndex(m => m.id === joinReadState.lastReadMessageId);
      if (firstUnreadIndex !== -1) {
        // Scroll to the first unread message
        const targetMessage = el.querySelector(`[data-msg-id="${joinReadState.lastReadMessageId}"]`);
        if (targetMessage) {
          targetMessage.scrollIntoView({ behavior: 'smooth', block: 'center' });
          // Clear the read state after scrolling
          delete window.__joinReadState;
          return;
        }
      }
    }
    
    // Fallback: scroll to bottom if near bottom
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [messages.length, conversationId]);
  useEffect(() => {
    const el = scroller.current; if (!el) return;
    function onScroll(){ const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 12; setShowScrollBtn(!atBottom); }
    onScroll(); el.addEventListener('scroll', onScroll); return ()=>el.removeEventListener('scroll', onScroll);
  }, [scroller.current]);
  useEffect(() => { if (forceInfoId && forceInfoId === conversationId) { setOpenInfo(true); onConsumeForceInfo(); } }, [forceInfoId, conversationId, onConsumeForceInfo]);
  useEffect(() => { return () => { try { window['typing_'+conversationId] = []; } catch {} }; }, [conversationId]);
  // Mark messages as read when conversation is opened
  useEffect(() => { dao.markAsRead(conversationId, me.id); }, [conversationId, me.id]);
  
  // Presence heartbeat to keep user status fresh
  useEffect(() => {
    if (!window.socket || !conversationId) return;
    
    const heartbeatInterval = setInterval(() => {
      if (window.socket.connected && conversationId) {
        window.socket.emit('presence:ping');
      }
    }, 30_000); // Send heartbeat every 30 seconds
    
    return () => clearInterval(heartbeatInterval);
  }, [conversationId]);
  // Real-time listeners (backend)
  useEffect(() => {
    if (!window.io || !window.socket) return;
    const s = window.socket;
    const onReact = ({ messageId, emoji, userId }) => { try { dao.reactMessage(conversationId, messageId, emoji, userId); } catch {} };
    const onEdit = ({ messageId, text }) => { try { dao.updateMessage(conversationId, messageId, ()=>({ body: text, __editing:false })); } catch {} };
    const onPin = () => {};
    const onRead = ({ roomId, userId, messageId }) => { if (roomId!==conversationId) return; try { dao.updateMessage(conversationId, messageId, (m)=>{ const meta=m.metadata||{}; const rb=new Set([...(meta.readBy||[])]); rb.add(userId); meta.readBy=Array.from(rb); return { metadata: meta }; }); } catch {} };
    const onMessage = (msg) => {
      try {
        if (!msg || String(msg.roomId) !== String(conversationId)) return;
        // Insert using server IDs so read receipts match
        dao.mutate(db => {
          // Optional: de-dup if same id already exists
          if (db.messages.some(m => String(m.id) === String(msg.id) && m.conversationId === conversationId)) return;
          db.messages.push({
            id: msg.id || db.nextIds.message++,
            conversationId,
            senderId: msg.userId,
            body: msg.text,
            metadata: msg.meta || {},
            createdAt: Number(msg.ts || Date.now()),
          });
          const convo = db.conversations.find(c=>c.id===conversationId);
          if (convo) convo.updatedAt = Date.now();
        });
        // Immediately ACK delivery for accurate delivered ticks
        try { window.socket && window.socket.emit('message:ack', { messageId: msg.id }); } catch {}
      } catch {}
    };
    const onTyping = ({ userId, name, isTyping }) => {
      // Only show typing if this conversation is active
      if (!document.querySelector('[data-conversation-panel]')) return;
      const key = 'typing_'+conversationId;
      const current = new Set((window[key]||[]));
      if (isTyping) { current.add(name||('User '+userId)); } else { current.delete(name||('User '+userId)); }
      window[key] = Array.from(current);
      setTick(x=>x+1);
    };
    s.on('message', onMessage);
    s.on('message:delivered', ({ roomId, messageId, deliveredCount }) => {
      if (String(roomId) !== String(conversationId)) return;
      try {
        dao.updateMessage(conversationId, messageId, (m) => {
          const meta = m.metadata || {};
          meta.deliveredByCount = deliveredCount || 0;
          return { metadata: meta };
        });
      } catch {}
    });
    s.on('message:react', onReact); s.on('message:edit', onEdit); s.on('read:upto', onRead); s.on('typing:state', onTyping);
    return () => { s.off('message', onMessage); s.off('message:delivered'); s.off('message:react', onReact); s.off('message:edit', onEdit); s.off('read:upto', onRead); s.off('typing:state', onTyping); };
  }, [conversationId]);
  if (!convo) return <div className="p-6">Conversation not found.</div>;
  function send() {
    if (!body.trim()) return;
    if (isLobby && !isMember) { alert('Join the lobby to participate.'); return; }
    if (window.socket) {
      window.socket.emit('message', { text: body.trim() });
    } else {
      // Fallback local insert if socket not ready
      dao.postMessage(conversationId, me.id, body.trim());
    }
    setBody("");
  }
  // Initial scroll: jump to first unread message (oldest) or bottom if none
  useEffect(() => { setDidInitialScroll(false); }, [conversationId]);
  useEffect(() => {
    if (didInitialScroll) return;
    const el = scroller.current; if (!el) return;
    // Prefer server-read state if provided on join
    const host = window.__joinReadState;
    let targetId = null;
    if (host && host.roomId===conversationId && host.lastReadMessageId) {
      // Jump to next after last read
      const idx = messages.findIndex(m => String(m.id)===String(host.lastReadMessageId));
      if (idx>=0 && idx<messages.length-1) targetId = messages[idx+1].id;
    }
    if (!targetId) {
      const firstUnread = messages.find(m => m.senderId!==me.id && !(m.metadata?.readBy||[]).includes(me.id));
      targetId = firstUnread?.id;
    }
    if (targetId) {
      const node = el.querySelector(`[data-msg-id="${targetId}"]`);
      if (node) { node.scrollIntoView({ behavior:'auto', block:'center' }); setDidInitialScroll(true); return; }
    }
    el.scrollTop = el.scrollHeight; setDidInitialScroll(true);
  }, [messages.length, didInitialScroll, conversationId]);
  function toggleTheme(){ const next = theme==='light'?'dark':'light'; setTheme(next); localStorage.setItem('theme', next); document.documentElement.classList.toggle('dark', next==='dark'); }
  useEffect(()=>{ document.documentElement.classList.toggle('dark', theme==='dark'); },[]);
  function readFileAsDataURL(file){ return new Promise((res)=>{ const r=new FileReader(); r.onload=()=>res({ name:file.name, size:file.size, type:file.type, dataUrl:r.result, id:`${file.name}-${file.size}-${Date.now()}` }); r.readAsDataURL(file); }); }
  // Emit real typing state with debounce, scoped to active chat
  useEffect(() => {
    if (!window.socket) return; const s = window.socket;
    if (!body) { s.emit('typing:state', false); return; }
    s.emit('typing:state', true);
    const t = setTimeout(()=>{ try { s.emit('typing:state', false); } catch {} }, 1200);
    return ()=>clearTimeout(t);
  }, [body, conversationId]);
  // Viewport-based read receipts using IntersectionObserver (honors privacy toggle)
  useEffect(() => {
    const el = scroller.current; if (!el || !window.socket) return;
    const meUser = dao.findUserById(me.id);
    const allowRR = meUser?.showReadReceipts !== false;
    if (!allowRR) return;
    const inboundIds = new Set(messages.filter(m=>m.senderId!==me.id).map(m=>String(m.id)));
    if (inboundIds.size===0) return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some(e=>e.isIntersecting)) return;
      const lastInbound = [...inboundIds];
      const lastId = lastInbound[lastInbound.length-1];
      if (lastId && lastReadSentRef.current !== lastId) {
        window.socket.emit('read:upto', { roomId: conversationId, messageId: String(lastId) });
        lastReadSentRef.current = lastId;
      }
    }, { root: el, threshold: 0.9 });
    const nodes = el.querySelectorAll('[data-msg-id]');
    nodes.forEach(n => { const id = n.getAttribute('data-msg-id'); if (inboundIds.has(String(id))) observer.observe(n); });
    return () => observer.disconnect();
  }, [messages.length, conversationId, me.id]);
  async function onDrop(e){
    e.preventDefault(); setDragOver(false);
    const items = e.dataTransfer.items || []; const files = [];
    for (const it of items) { if (it.kind === 'file') { const f = it.getAsFile(); if (f) files.push(f); } }
    if (files.length === 0 && e.dataTransfer.files?.length) { for (const f of e.dataTransfer.files) files.push(f); }
    const loaded = [];
    for (const f of files.slice(0,8)) { const p = await readFileAsDataURL(f); p.file = f; loaded.push(p); }
    setPreviews(prev => [...prev, ...loaded].slice(0,12));
    // seed queue
    setUploadQueue(prev => [...prev, ...loaded.map(p=>({ id:p.id, file:p.file, name:p.file.name, size:p.file.size, progress:0, status:'queued', controller:null }))]);
  }
  function onDrag(e){ e.preventDefault(); if (e.type==='dragover') setDragOver(true); if (e.type==='dragleave') setDragOver(false); }
  function inviteGroup() { try { dao.inviteToGroup(conversationId, me.id, inviteUser.trim()); setInviteUser(""); } catch (e) { alert(e.message); } }
  function inviteLobby() { try { dao.inviteToLobby(conversationId, me.id, inviteUser.trim()); setInviteUser(""); } catch (e) { alert(e.message); } }
  const title = convo.name || (convo.type === "DIRECT" ? labelForDirect(convo, me.id) : (convo.type));
  function removeFromQueue(id){ setUploadQueue(prev=>prev.filter(x=>x.id!==id)); setPreviews(prev=>prev.filter(p=>p.id!==id)); }
  async function uploadOne(item){
    if (item.size > 50*1024*1024) { item.status='error'; setUploadQueue(prev=>prev.map(x=>x.id===item.id?{...item}:x)); return; }
    try {
      const initRes = await fetch('/api/upload/init', { method:'POST', headers:{ 'Content-Type':'application/json' }, credentials:'include', body: JSON.stringify({ roomId: conversationId, mime: item.file.type||'application/octet-stream', bytes: item.size }) });
      const init = await initRes.json(); if (!init.ok) throw new Error('init failed');
      const form = new FormData(); Object.entries(init.fields||{}).forEach(([k,v])=>form.append(k,v)); form.append('Content-Type', item.file.type||'application/octet-stream'); form.append('file', item.file);
      const controller = new AbortController(); item.controller = controller; item.status='uploading'; setUploadQueue(prev=>prev.map(x=>x.id===item.id?{...item}:x));
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', init.url, true);
        xhr.upload.onprogress = (e) => { if (e.lengthComputable) { const pct = Math.round((e.loaded / e.total) * 100); item.progress = pct; setUploadQueue(prev=>prev.map(x=>x.id===item.id?{...item}:x)); } };
        xhr.onerror = () => reject(new Error('upload failed'));
        xhr.onload = () => { if (xhr.status>=200 && xhr.status<300) resolve(); else reject(new Error('upload failed')); };
        xhr.send(form);
        item.controller = { abort: () => { try { xhr.abort(); } catch {} } };
      });
      item.progress = 100; item.status='done'; setUploadQueue(prev=>prev.map(x=>x.id===item.id?{...item}:x));
      // Request compression
      let compMeta = { keyCompressed:null, bytesCompressed:null, compression:null, sha256:null };
      try {
        const jc = await fetch('/jobs/compress', { method:'POST', headers:{ 'Content-Type':'application/json' }, credentials:'include', body: JSON.stringify({ roomId: conversationId, keyOriginal: init.fields.key, mime: item.file.type||'application/octet-stream' }) });
        const j = await jc.json(); if (j && j.ok) compMeta = { keyCompressed:j.keyCompressed||null, bytesCompressed:j.bytesCompressed||null, compression:j.compression||null, sha256:j.sha256||null };
      } catch {}
      await fetch('/api/upload/complete', { method:'POST', headers:{ 'Content-Type':'application/json' }, credentials:'include', body: JSON.stringify({ roomId: conversationId, key: init.fields.key, mime: item.file.type||'application/octet-stream', bytes: item.size, ...compMeta }) });
    } catch (e) {
      item.status='error'; setUploadQueue(prev=>prev.map(x=>x.id===item.id?{...item}:x));
    }
  }
  async function startUploads(){ for (const it of uploadQueue.filter(i=>i.status==='queued')) await uploadOne(it); }
  async function retryUpload(id){ const it = uploadQueue.find(x=>x.id===id); if (it){ it.status='queued'; it.progress=0; setUploadQueue(prev=>prev.map(x=>x.id===id?{...it}:x)); await uploadOne(it); } }
  return (
    <div className="flex flex-col h-full">
      <div className="p-4 border-b flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          {convo.type === "DIRECT" && <Pill>DM</Pill>}
          {isGroup && <Pill className="bg-blue-100">Group</Pill>}
          {isLobby && <Pill className="bg-green-100">Lobby</Pill>}
          <h2 className="text-lg font-semibold truncate">{title}</h2>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {(isGroup || isLobby) && (
            <button className="p-2 rounded-lg border hover:bg-gray-50" onClick={()=>setOpenInfo(true)} aria-label="Info">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="16" x2="12" y2="12"/>
                <line x1="12" y1="8" x2="12.01" y2="8"/>
              </svg>
            </button>
          )}
          {/* Pins feature disabled for now */}
          {/* Removed internal conversation id from UI */}
          {/* Online Status */}
          <div className="hidden sm:flex items-center gap-2">
            <div className="flex items-center gap-1 px-2 py-1 rounded-full bg-green-50 border border-green-200 text-xs text-green-700">
              <span className="w-2 h-2 rounded-full bg-green-500"></span>
              <span>Online</span>
            </div>
          </div>
        </div>
      </div>
      {(isGroup || isLobby) && (myRole==='OWNER' || myRole==='ADMIN') && (
        <div className="p-3 border-b flex items-center gap-2">
          <form className="flex gap-2 w-full" onSubmit={e=>{e.preventDefault(); isGroup ? inviteGroup() : inviteLobby();}}>
            <InviteUserPicker value={inviteUser} onChange={setInviteUser} onPick={(username)=>setInviteUser(username)} />
            <Button type="submit" disabled={!inviteUser.trim()}>Invite</Button>
          </form>
        </div>
      )}
      <div ref={scroller} className="relative flex-1 overflow-y-auto p-4 space-y-2 bg-white scrollbar-thin" data-conversation-panel>
        {/* Load Earlier Messages Button */}
        {hasMoreMessages && (
          <div className="flex justify-center py-2">
            <button
              onClick={loadEarlierMessages}
              disabled={isLoadingEarlier}
              className="px-4 py-2 rounded-lg border bg-white hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium transition-colors"
            >
              {isLoadingEarlier ? 'Loading...' : 'Load Earlier Messages'}
            </button>
          </div>
        )}
        
        {/* Unread Messages Divider */}
        {window.__joinReadState && window.__joinReadState.roomId === conversationId && (
          <div className="flex items-center justify-center py-2">
            <div className="flex items-center gap-2">
              <div className="h-px bg-gray-300 flex-1 w-16"></div>
              <span className="text-xs font-medium text-gray-500 bg-white px-2">New Messages</span>
              <div className="h-px bg-gray-300 flex-1 w-16"></div>
            </div>
          </div>
        )}
        
        {messages.map(m => (
          <div key={m.id} data-msg-id={m.id} className={`group max-w-xl ${m.senderId===me.id?"ml-auto":""} bubble-in`}>
            <div className={`relative rounded-2xl px-3 py-2 ${m.senderId===me.id?"bg-black text-white bubble-me":"bg-white border bubble-other"}`}>
              <div className="flex items-center gap-2 text-xs opacity-70 mb-0.5">
                <button onClick={()=>window.dispatchEvent(new CustomEvent('profile:view',{ detail:{ userId: m.senderId } }))}><Avatar user={dao.findUserById(m.senderId)} size={18} /></button>
                <span>{dao.findUserById(m.senderId)?.username}</span>
                <span>· {new Date(m.createdAt).toLocaleTimeString()}</span>
              </div>
              {/* Status ticks inside bubble (final) */}
              {m.senderId===me.id && (
                <div className="mt-1 flex justify-end text-[10px]">
                  {(() => {
                    const readCount = Array.isArray(m.metadata?.readBy) ? m.metadata.readBy.length : 0;
                    const isRead = readCount > 0;
                    const isDelivered = Number(m.metadata?.deliveredByCount||0) > 0;
                    const cls = isRead ? 'text-black font-bold' : 'text-gray-400';
                    const text = isRead ? '✓✓' : (isDelivered ? '✓✓' : '✓');
                    return <span className={cls}>{text}</span>;
                  })()}
                </div>
              )}
              {m.__editing ? (
                <div className="flex items-center gap-2">
                  <input autoFocus defaultValue={m.body} className={`w-full px-2 py-1 rounded-md border ${m.senderId===me.id?"bg-black/20 border-white/30":"bg-white border-gray-300"}`} onKeyDown={(e)=>{
                    if(e.key==='Enter'){ const val=e.currentTarget.value; dao.updateMessage(conversationId, m.id, ()=>({ body: val.slice(0,2000), __editing: false })); }
                    if(e.key==='Escape'){ dao.updateMessage(conversationId, m.id, ()=>({ __editing:false })); }
                  }} />
                  <button className="text-xs underline" onClick={()=>dao.updateMessage(conversationId, m.id, ()=>({ __editing:false }))}>Cancel</button>
                </div>
              ) : (
                <div className="whitespace-pre-wrap text-sm pr-7 break-words">{renderText(m.body)}</div>
              )}
              {/* Avatar cluster remains unchanged below if needed */}
              <div className="absolute top-2 right-2 flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                <button title="Copy" onClick={()=>navigator.clipboard.writeText(m.body)} className={`text-xs ${m.senderId===me.id?"text-white/80 hover:text-white":"text-gray-500 hover:text-black"}`}>Copy</button>
                <button title="Add reaction" onClick={()=>setReactFor(reactFor===m.id?null:m.id)} className={`text-xs ${m.senderId===me.id?"text-white/80 hover:text-white":"text-gray-500 hover:text-black"}`}>＋</button>
                {(m.senderId===me.id && (now()-m.createdAt)<(5*60*1000)) && (
                  <button title="Edit" onClick={()=>dao.updateMessage(conversationId, m.id, ()=>({ __editing:true }))} className={`text-xs ${m.senderId===me.id?"text-white/80 hover:text-white":"text-gray-500 hover:text-black"}`}>Edit</button>
                )}
              </div>
              {reactFor===m.id && (
                <div className={`absolute top-8 right-2 z-10 border rounded-xl bg-white shadow p-2`}
                     onMouseLeave={()=>setReactFor(null)} onKeyDown={(e)=>{ if(e.key==='Escape'){ setReactFor(null);} if((e.key==='Enter' && (e.metaKey||e.ctrlKey))){ setReactFor(null);} }} tabIndex={0}>
                  <div className="flex gap-1">
                    {EMOJIS.slice(0,12).map(e=> (
                      <button key={e.ch} className="text-lg hover:scale-110" onClick={()=>{ dao.reactMessage(conversationId, m.id, e.ch, me.id); }}>{e.ch}</button>
                    ))}
                  </div>
                  <div className="mt-2 text-[10px] text-gray-500">Tip: Click multiple, press Esc to close.</div>
                </div>
              )}
              {m.metadata?.reactions && (
                <div className={`mt-1 flex gap-1 ${m.senderId===me.id?"justify-end":""}`}>
                  {Object.entries(m.metadata.reactions).map(([emoji, users]) => (
                    <span key={emoji} className={`px-1.5 py-0.5 rounded-full text-xs border ${m.senderId===me.id?"border-white/30":"border-gray-300"}`}>{emoji} {users.length}</span>
                  ))}
                </div>
              )}
              {m.metadata?.readBy && m.senderId===me.id && (
                <div className="mt-1 flex justify-end gap-1">
                  {m.metadata.readBy.slice(0,5).map(uid => <Avatar key={uid} user={dao.findUserById(uid)} size={14} />)}
                </div>
              )}
              {m.metadata?.pinned && <div className="text-[10px] opacity-60 mt-1">Pinned</div>}
            </div>
          </div>
        ))}
        {messages.length===0 && <div className="text-xs text-gray-500">No messages yet.</div>}
        {showScrollBtn && (
          <button
            onClick={()=>{ const el=scroller.current; if(el) el.scrollTop = el.scrollHeight; }}
            className="btn-transitions card-hover absolute bottom-3 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-full bg-black text-white text-xs shadow"
            aria-label="Jump to latest"
            title="Jump to latest"
          >
            ↓
          </button>
        )}
      </div>
      {/* Pins drawer removed */}
      <div className="p-3 border-t flex gap-2 items-end relative" onDragOver={onDrag} onDragLeave={onDrag} onDrop={onDrop}>
        <div className="flex-1">
          <Textarea value={body} onChange={e=>setBody(e.target.value.slice(0,2000))} disabled={isLobby && !isMember} placeholder={isLobby && !isMember?"Join the lobby to send messages":"Write a message… (Enter = send, Shift+Enter = newline)"} onKeyDown={e=>{ if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); send(); } }} />
          <div className="text-[10px] text-gray-500 mt-1">{body.length}/2000</div>
          
          {/* Animated Typing Indicator */}
          {(window['typing_'+conversationId] && window['typing_'+conversationId].length > 0) && (
            <div className="flex items-center gap-2 mt-2 text-xs text-gray-600">
              {/* Animated dots */}
              <div className="flex items-center gap-1">
                <div className="w-1.5 h-1.5 bg-gray-400 rounded-full typing-dot-1"></div>
                <div className="w-1.5 h-1.5 bg-gray-400 rounded-full typing-dot-2"></div>
                <div className="w-1.5 h-1.5 bg-gray-400 rounded-full typing-dot-3"></div>
              </div>
              
              {/* Participant names */}
              <span className="text-gray-500">
                {(() => {
                  const typingUsers = window['typing_'+conversationId] || [];
                  if (typingUsers.length === 1) {
                    return `${typingUsers[0]} is typing`;
                  } else if (typingUsers.length === 2) {
                    return `${typingUsers[0]} and ${typingUsers[1]} are typing`;
                  } else if (typingUsers.length > 2) {
                    return `${typingUsers[0]}, ${typingUsers[1]} and ${typingUsers.length - 2} more are typing`;
                  }
                  return '';
                })()}
              </span>
            </div>
          )}
          {/* Allow adding multiple emojis inline without closing picker */}
          {showEmoji && (
            <div className="absolute bottom-20 left-3 bubble-in"><EmojiPicker onPick={(e)=>{ setBody(b=>b + e); /* keep open */ }} /></div>
          )}
          {dragOver && <div className="absolute inset-0 bg-black/5 border-2 border-dashed border-black/20 rounded-2xl flex items-center justify-center text-sm">Drop files/folders to attach</div>}
          {previews.length>0 && (
            <div className="absolute -top-32 left-3 right-3 bg-white border rounded-2xl p-2 shadow card-hover flex items-center gap-3 overflow-x-auto">
              {uploadQueue.map(item => (
                <div key={item.id} className="flex items-center gap-2 bubble-in">
                  <img src={previews.find(p=>p.id===item.id)?.dataUrl} alt="preview" className="w-12 h-12 object-cover rounded-xl" />
                  <div className="text-[10px]">
                    <div className="font-medium truncate max-w-[140px]">{item.name}</div>
                    <div className="text-gray-500">{Math.round(item.size/1024)} KB</div>
                    <div className="w-32 h-1.5 bg-gray-200 rounded-full mt-1 overflow-hidden"><div className="h-full bg-black" style={{ width: `${item.progress||0}%` }}/></div>
                    <div className="mt-1 flex gap-2">
                      {item.status==='uploading' ? (
                        <button className="underline" onClick={()=>{ item.controller?.abort(); }}>Cancel</button>
                      ) : item.status==='error' ? (
                        <button className="underline" onClick={()=>retryUpload(item.id)}>Retry</button>
                      ) : (
                        <button className="underline" onClick={()=>removeFromQueue(item.id)}>Remove</button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
              <button className="ml-2 text-xs px-3 py-2 rounded-xl bg-black text-white btn-transitions" onClick={startUploads}>Upload</button>
            </div>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <Button onClick={()=>setShowEmoji(s=>!s)} className="bg-gray-700" aria-label="Toggle emoji picker">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/>
              <path d="M8 14s1.5 2 4 2 4-2 4-2"/>
              <line x1="9" y1="9" x2="9.01" y2="9"/>
              <line x1="15" y1="9" x2="15.01" y2="9"/>
            </svg>
          </Button>
          <Button onClick={()=>document.getElementById('filePicker')?.click()} className="bg-gray-700" aria-label="Upload files">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="17 8 12 3 7 8"/>
              <line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
          </Button>
          <Button onClick={send} disabled={isLobby && !isMember} className="card-hover">Send</Button>
          {isLobby && !isMember && <Button className="bg-gray-700 card-hover" onClick={()=>dao.joinLobby(me.id, conversationId)}>Join lobby</Button>}
        </div>
        <input id="filePicker" type="file" multiple className="hidden" onChange={async (e)=>{
          const files = Array.from(e.target.files||[]);
          const loaded = [];
          for (const f of files.slice(0,8)) { const p = await readFileAsDataURL(f); p.file = f; loaded.push(p); }
          setPreviews(prev => [...prev, ...loaded].slice(0,12));
          setUploadQueue(prev => [...prev, ...loaded.map(p=>({ id:p.id, file:p.file, name:p.file.name, size:p.file.size, progress:0, status:'queued', controller:null }))]);
          e.target.value = '';
        }} />
      </div>
      <Modal open={openInfo} onClose={()=>setOpenInfo(false)} title={isGroup?"Group Info":"Lobby Info"}>
        {isGroup ? (
          <GroupInfo me={me} convo={convo} onClose={()=>setOpenInfo(false)} onSaved={()=>{}} />
        ) : (
          <LobbyInfo me={me} convo={convo} onClose={()=>setOpenInfo(false)} onSaved={()=>{}} />
        )}
      </Modal>
    </div>
  );
}

function App() {
  const [me, setMe] = useState(null);
  const [activeId, setActiveId] = useState(null);
  const [wL, setWL] = useState(280);
  const [wM, setWM] = useState(360);
  const [showProfileView, setShowProfileView] = useState(false);
  const [profileUserId, setProfileUserId] = useState(null);
  const [showProfileEdit, setShowProfileEdit] = useState(false);
  const [forceInfoId, setForceInfoId] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [leftPanelOpen, setLeftPanelOpen] = useState(false);
  const helpRef = useRef(false);
  useEffect(() => { const sess = sessionStorage.getItem("chat_demo_user"); if (sess) setMe(JSON.parse(sess)); const onView = (e) => { setProfileUserId(e.detail.userId); setShowProfileView(true); }; window.addEventListener('profile:view', onView); return () => window.removeEventListener('profile:view', onView); }, []);
  useEffect(() => { if (me) sessionStorage.setItem("chat_demo_user", JSON.stringify(me)); else sessionStorage.removeItem("chat_demo_user"); }, [me]);
  useEffect(() => { if (!me) return; const id = setInterval(()=>dao.touchUser(me.id), 30*1000); return ()=>clearInterval(id); }, [me?.id]);
  useEffect(() => { const onAny = ()=>setActiveId(a=>a); window.addEventListener('chatdb:update', onAny); window.addEventListener('chat:new', onAny); window.addEventListener('presence:update', onAny); return ()=>{ window.removeEventListener('chatdb:update', onAny); window.removeEventListener('chat:new', onAny); window.removeEventListener('presence:update', onAny); }; }, []);
  
  // Global presence heartbeat to maintain online status
  useEffect(() => {
    if (!me || !window.socket) return;
    
    const heartbeatInterval = setInterval(() => {
      if (window.socket.connected) {
        // Send heartbeat even when not in a conversation to maintain global presence
        window.socket.emit('presence:ping');
      }
    }, 30_000); // Send heartbeat every 30 seconds
    
    return () => clearInterval(heartbeatInterval);
  }, [me]);
  useEffect(() => {
    function isMod(e){
      const isMac = navigator.platform.toUpperCase().includes('MAC');
      return isMac ? e.metaKey : e.ctrlKey;
    }
    function onKey(e){
      if (!isMod(e)) return;
      if (e.key==='j') { e.preventDefault(); const convos = dao.listUserConversations(me.id); const idx = Math.max(0, convos.findIndex(c=>c.id===activeId)); const next = convos[Math.min(convos.length-1, idx+1)]; if (next) setActiveId(next.id); }
      if (e.key==='k') { e.preventDefault(); const convos = dao.listUserConversations(me.id); const idx = Math.max(0, convos.findIndex(c=>c.id===activeId)); const prev = convos[Math.max(0, idx-1)]; if (prev) setActiveId(prev.id); }
      if (e.key==='/' && e.shiftKey) { e.preventDefault(); alert('Shortcuts (Cmd/Ctrl + key):\n j: next conversation\n k: previous conversation\n g then i: open info\n Enter: send\n Enter: open next link (with Cmd/Ctrl)'); }
      if (e.key==='g') { helpRef.current = true; setTimeout(()=>helpRef.current=false, 600); }
      if (e.key==='i' && helpRef.current) { e.preventDefault(); if (activeId) setForceInfoId(activeId); helpRef.current=false; }
      if (e.key==='Enter') {
        e.preventDefault();
        // Cmd/Ctrl+Enter: open next link in current conversation
        const container = document.querySelector('[data-conversation-panel]');
        if (!container) return;
        const anchors = Array.from(container.querySelectorAll('a'));
        if (anchors.length===0) return;
        const key = 'link_idx_'+activeId;
        let idx = 0; try { idx = Number(sessionStorage.getItem(key)||'0'); } catch {}
        if (e.shiftKey) idx = (idx-1+anchors.length)%anchors.length; else idx = (idx+1)%anchors.length;
        try { sessionStorage.setItem(key, String(idx)); } catch {}
        const a = anchors[idx]; if (a && a.href) window.open(a.href, '_blank', 'noopener');
      }
    }
    window.addEventListener('keydown', onKey);
    return ()=>window.removeEventListener('keydown', onKey);
  }, [me, activeId]);
  function onAuthed(u) { setMe(u); const convos = dao.listUserConversations(u.id); setActiveId(convos[0]?.id ?? null); }
  function logout() { if (me) dao.setOffline(me.id); setMe(null); setActiveId(null); }
  function onDragLeft(dx) { setWL(v => Math.min(Math.max(v + dx, 220), 500)); }
  function onDragMid(dx) { setWM(v => Math.min(Math.max(v + dx, 260), 600)); }
  function openInfo(convoId) { setActiveId(convoId); setForceInfoId(convoId); }
  function consumeForceInfo() { setForceInfoId(null); }
  
  // Test Dashboard Password Protection
  function promptTestDashboardPassword() {
    const password = prompt('Enter password to access Test Dashboard:');
    if (password === 'testdashboard') {
      window.open('/test.html', '_blank');
    } else if (password !== null) {
      alert('Incorrect password. Access denied.');
    }
  }
  
  return (
    <div className="min-h-screen bg-white text-gray-900">
      <div className="max-w-7xl mx-auto p-4">
        {/* Persistent Header */}
        <header className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <a href="/" className="flex items-center gap-3 hover:opacity-80 transition-opacity">
              <div className="w-8 h-8 rounded-lg bg-gray-900 text-white flex items-center justify-center">S</div>
              <h1 className="text-2xl font-bold">Secure chat</h1>
            </a>
          </div>
          <div className="flex items-center gap-2">
            {!me && (
              <nav className="text-sm flex items-center gap-3">
                <a className="link-underline" href="/about.html">About</a>
                <a className="link-underline" href="mailto:akcorp2000@gmail.com">Contact</a>
                <a className="link-underline" href="#" onClick={(e) => { e.preventDefault(); promptTestDashboardPassword(); }}>Test dashboard</a>
              </nav>
            )}
            {me && <NotificationBell open={notifOpen} onOpenChange={(o)=>{ setNotifOpen(o); if (o) setProfileOpen(false); }} me={me} activeConversationId={activeId} onOpenConversation={setActiveId} />}
            {me && <ProfileMenuEnhanced open={profileOpen} onOpenChange={(o)=>{ setProfileOpen(o); if (o) setNotifOpen(false); }} me={me} onLogout={logout} onEdit={()=>setShowProfileEdit(true)} onOpenSettings={()=>setShowSettings(true)} />}
          </div>
        </header>
        
        {!me ? (
          <AuthView onAuthed={onAuthed} />
        ) : (
          <>
            <div className="h-[72vh] rounded-3xl border bg-gradient-to-br from-white to-gray-50 overflow-hidden relative card-hover">
                <div className="h-full flex">
                {leftPanelOpen && (
                  <>
                    <div style={{width:wL}} className="h-full border-r min-w-[200px] max-w-[40vw] bg-white/70 fade-in-up">
                      <ToolsPane me={me} onLogout={logout} onOpenConversation={setActiveId} />
                    </div>
                    <DragHandle onDrag={onDragLeft} />
                  </>
                )}
                <div style={{width:leftPanelOpen ? wM : wL}} className="h-full border-r min-w-[260px] max-w-[50vw] bg-white/70 fade-in-up" data-delay=".04s">
                  <div className="h-full flex flex-col">
                    <div className="flex items-center justify-between p-2 border-b">
                      <div className="flex items-center gap-2">
                        <button 
                          onClick={() => setLeftPanelOpen(!leftPanelOpen)}
                          className="p-1 rounded hover:bg-gray-100 text-gray-500 hover:text-gray-700"
                          title={leftPanelOpen ? "Hide tools panel" : "Show tools panel"}
                        >
                          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M1 2.5h12M1 7h12M1 11.5h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                          </svg>
                        </button>
                        <h2 className="font-semibold">Conversations</h2>
                      </div>
                    </div>
                    <div className="flex-1">
                      <ConversationsPane me={me} onOpenConversation={setActiveId} onOpenInfo={openInfo} />
                    </div>
                  </div>
                </div>
                {leftPanelOpen && <DragHandle onDrag={onDragMid} />}
                <div className="flex-1 min-w-0 fade-in-up" data-delay=".08s">
                  {activeId ? <ConversationPane me={me} conversationId={activeId} forceInfoId={forceInfoId} onConsumeForceInfo={consumeForceInfo} /> : <div className="h-full flex items-center justify-center text-sm text-gray-500">Pick or create a conversation from the left.</div>}
                </div>
              </div>
            </div>
            <ToastCenter me={me} activeConversationId={activeId} />
            <Modal open={showProfileView} onClose={()=>setShowProfileView(false)} title="Profile">
              <ProfileView user={dao.findUserById(profileUserId)} />
            </Modal>
            <Modal open={showProfileEdit} onClose={()=>setShowProfileEdit(false)} title="Edit Profile">
              <ProfileEdit me={dao.findUserById(me.id)} onClose={()=>setShowProfileEdit(false)} onSaved={()=>setMe({...dao.findUserById(me.id)})} />
            </Modal>
            <Modal open={showSettings} onClose={()=>setShowSettings(false)} title="Settings">
              <SettingsView />
            </Modal>
          </>
        )}
        
        {/* Persistent Footer */}
        <div className="mt-6 text-xs text-gray-500 flex items-center justify-between">
          <div>© All rights reserved · <a className="underline" href="/terms.html">Terms of Service</a></div>
          <div className="space-x-4"><a className="underline" href="mailto:akcorp2000@gmail.com">Contact us</a><a className="underline" href="/about.html">About us</a></div>
        </div>
      </div>
    </div>
  );
}

function DragHandle({ onDrag }) {
  const ref = useRef(null);
  useEffect(() => {
    function onDown(e){ e.preventDefault(); window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp); document.body.style.cursor='col-resize'; document.body.style.userSelect='none'; }
    function onMove(e){ onDrag(e.movementX); }
    function onUp(){ window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); document.body.style.cursor=''; document.body.style.userSelect=''; }
    const el = ref.current; if (!el) return; el.addEventListener('mousedown', onDown); return ()=>{ if (el) el.removeEventListener('mousedown', onDown); };
  }, [onDrag]);
  return <div ref={ref} className="w-2 bg-gray-100 hover:bg-gray-200 cursor-col-resize" title="Drag to resize" />;
}

function ProfileMenuEnhanced({ me, onLogout, onEdit, onOpenSettings, open, onOpenChange }) {
  const ref = useRef(null);
  useEffect(() => {
    function onDoc(e){ if (!ref.current) return; if (!ref.current.contains(e.target)) onOpenChange(false); }
    if (open) { document.addEventListener('mousedown', onDoc); return ()=>document.removeEventListener('mousedown', onDoc); }
  }, [open, onOpenChange]);
  return (
    <div className="relative" ref={ref}>
      <button className="flex items-center gap-2" onClick={()=>onOpenChange(!open)}>
        <Avatar user={me} />
        <span className="text-sm">{me.username}</span>
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-64 bg-white border rounded-2xl shadow p-2 z-20">
          <div className="flex items-center gap-2 p-2">
            <Avatar user={me} />
            <div>
              <div className="text-sm font-medium">{me.username}</div>
              <div className="text-xs text-gray-500">User #{me.id}</div>
            </div>
          </div>
          <button className="w-full text-left text-sm px-3 py-2 rounded-lg hover:bg-gray-50" onClick={()=>window.dispatchEvent(new CustomEvent('profile:view',{ detail:{ userId: me.id } }))}>View profile</button>
          <button className="w-full text-left text-sm px-3 py-2 rounded-lg hover:bg-gray-50" onClick={()=>{ onOpenChange(false); onEdit(); }}>Edit profile</button>
          <button className="w-full text-left text-sm px-3 py-2 rounded-lg hover:bg-gray-50" onClick={()=>{ onOpenChange(false); onOpenSettings(); }}>Settings</button>
          <button className="w-full text-left text-sm px-3 py-2 rounded-lg hover:bg-gray-50 text-red-600" onClick={onLogout}>Logout</button>
        </div>
      )}
    </div>
  );
}

function SettingsView() {
  const [theme, setTheme] = useState(()=>localStorage.getItem('theme')||'light');
  const me = (()=>{ try{ const u=JSON.parse(sessionStorage.getItem('chat_demo_user')||'null'); return u; }catch{return null;} })();
  const [showRR, setShowRR] = useState(()=>dao.findUserById(me?.id)?.showReadReceipts !== false);
  useEffect(()=>{ document.documentElement.classList.toggle('dark', theme==='dark'); localStorage.setItem('theme', theme); },[theme]);
  function persistRR(v){ if (!me) return; try { dao.updateUser(me.id, { showReadReceipts: v }); } catch(e){} setShowRR(v); }
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between p-3 border rounded-xl">
        <div>
          <h4 className="text-sm font-semibold mb-0.5">Appearance</h4>
          <div className="text-xs text-gray-500">Choose light or dark mode. Your preference is saved.</div>
        </div>
        <Toggle checked={theme==='dark'} onChange={(v)=>setTheme(v?'dark':'light')} label="Dark mode" />
      </div>
      <div className="flex items-center justify-between p-3 border rounded-xl">
        <div>
          <h4 className="text-sm font-semibold mb-0.5">Privacy</h4>
          <div className="text-xs text-gray-500">Send read receipts to others (when viewing a chat).</div>
        </div>
        <Toggle checked={showRR} onChange={(v)=>persistRR(v)} label="Read receipts" />
      </div>
      <div>
        <h4 className="text-sm font-semibold mb-1">Profile</h4>
        <div className="text-xs text-gray-500">Manage your profile and presence from Edit Profile.</div>
      </div>
    </div>
  );
}

// Mount app
const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);


