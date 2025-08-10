// Using React from CDN globals
const { useEffect, useMemo, useRef, useState, forwardRef } = React;

const DB_KEY = "chatdb_v5";
function now() { return Date.now(); }
function obf(pw) { return Array.from(pw).map(c => String.fromCharCode(c.charCodeAt(0) ^ 23)).join(""); }
function normalizeDB(db) {
  if (!db.nextIds) db.nextIds = { user: 1, conversation: 1, message: 1, invite: 1 };
  if (db.nextIds && db.nextIds.invite == null) db.nextIds.invite = 1;
  if (!db.invites) db.invites = [];
  if (!db.version || db.version < 5) db.version = 5;
  // Backfill showActive
  if (db.users) db.users.forEach(u => { if (typeof u.showActive !== 'boolean') u.showActive = true; });
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
function saveDB(db) { localStorage.setItem(DB_KEY, JSON.stringify(db)); window.dispatchEvent(new CustomEvent("chatdb:update")); }
function seedDB() {
  const db = { users: [], conversations: [], members: [], messages: [], invites: [], nextIds: { user: 1, conversation: 1, message: 1, invite: 1 }, version: 5 };
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
  createUser(username, password) { return this.mutate(db => { if (db.users.some(u => u.username === username)) throw new Error("Username already taken"); const user = { id: db.nextIds.user++, username, password: obf(password), createdAt: now(), updatedAt: now(), avatar: undefined, bio: "", lastSeen: now(), showActive: true }; db.users.push(user); }).users.find(u => u.username === username); },
  login(username, password) { const u = this.findUserByUsername(username); if (!u || u.password !== obf(password)) throw new Error("Invalid credentials"); this.mutate(db => { const uu = db.users.find(x => x.id === u.id); if (uu) uu.lastSeen = now(); }); return u; },
  updateUser(userId, { username, password, bio, avatar, showActive }) { this.mutate(db => { const u = db.users.find(x => x.id === userId); if (!u) throw new Error("User not found"); if (username && username !== u.username) { if (db.users.some(us => us.username === username)) throw new Error("Username already taken"); u.username = username; } if (typeof bio === 'string') u.bio = bio; if (typeof avatar === 'string') u.avatar = avatar; if (typeof showActive === 'boolean') u.showActive = showActive; if (password) u.password = obf(password); u.updatedAt = now(); }); },
  touchUser(userId) { this.mutate(db => { const u = db.users.find(x=>x.id===userId); if (u) u.lastSeen = now(); }); },
  listUserConversations(userId) { const db = loadDB(); const convos = db.conversations.filter(c => db.members.some(m => m.userId === userId && m.conversationId === c.id)); return convos.sort((a,b) => b.updatedAt - a.updatedAt); },
  listUserMemberships(userId) { const db = loadDB(); return db.members.filter(m => m.userId === userId); },
  listLobbies() { const db = loadDB(); return db.conversations.filter(c => c.type === "LOBBY" && c.isPublic); },
  getConversation(id) { const db = loadDB(); return db.conversations.find(c => c.id === id) || null; },
  listMembers(conversationId) { const db = loadDB(); return db.members.filter(m => m.conversationId === conversationId); },
  isMember(conversationId, userId) { const db = loadDB(); return !!db.members.find(m=>m.conversationId===conversationId && m.userId===userId); },
  getRole(conversationId, userId) { const db = loadDB(); return (db.members.find(m => m.conversationId===conversationId && m.userId===userId)?.role) || null; },
  removeMember(conversationId, actorId, targetUserId) { this.mutate(db => { const actor = db.members.find(m=>m.conversationId===conversationId && m.userId===actorId); if (!actor || (actor.role!=='OWNER' && actor.role!=='ADMIN')) throw new Error('Not allowed'); const idx = db.members.findIndex(m=>m.conversationId===conversationId && m.userId===targetUserId); if (idx<0) throw new Error('User not a member'); db.members.splice(idx,1); }); },
  ensureDM(userId, otherUsername) { const other = this.findUserByUsername(otherUsername); if (!other) throw new Error("User not found"); if (other.id === userId) throw new Error("Cannot DM yourself"); const db = loadDB(); const existing = db.conversations.find(c => c.type === "DIRECT" && db.members.some(m => m.userId === userId && m.conversationId === c.id) && db.members.some(m => m.userId === other.id && m.conversationId === c.id)); if (existing) return existing; return this.mutate(db => { const convo = { id: db.nextIds.conversation++, type: "DIRECT", name: undefined, description: undefined, isPublic: false, ownerId: undefined, createdAt: now(), updatedAt: now() }; db.conversations.push(convo); db.members.push({ userId, conversationId: convo.id, role: "OWNER", joinedAt: now() }); db.members.push({ userId: other.id, conversationId: convo.id, role: "MEMBER", joinedAt: now() }); }).conversations.at(-1); },
  createGroup(ownerId, name, memberUsernames) { const users = memberUsernames.map(u => this.findUserByUsername(u)).filter(Boolean); return this.mutate(db => { const convo = { id: db.nextIds.conversation++, type: "GROUP", name, description: "", isPublic: false, ownerId, createdAt: now(), updatedAt: now() }; db.conversations.push(convo); db.members.push({ userId: ownerId, conversationId: convo.id, role: "OWNER", joinedAt: now() }); for (const u of users) if (u && u.id !== ownerId) db.members.push({ userId: u.id, conversationId: convo.id, role: "MEMBER", invitedById: ownerId, joinedAt: now() }); window.dispatchEvent(new CustomEvent('chat:membership', { detail: { kind: 'group-created', conversationId: convo.id, ownerId } })); }).conversations.at(-1); },
  inviteToGroup(conversationId, inviterId, username) { const user = this.findUserByUsername(username); if (!user) throw new Error("User not found"); this.mutate(db => { const convo = db.conversations.find(c => c.id === conversationId && c.type === "GROUP"); if (!convo) throw new Error("Group not found"); const inviter = db.members.find(m => m.conversationId === conversationId && m.userId === inviterId); if (!inviter || (inviter.role !== "OWNER" && inviter.role !== "ADMIN")) throw new Error("Not allowed"); const already = db.members.find(m => m.conversationId === conversationId && m.userId === user.id); if (!already) { db.members.push({ userId: user.id, conversationId, role: "MEMBER", invitedById: inviterId, joinedAt: now() }); window.dispatchEvent(new CustomEvent('chat:membership', { detail: { kind: 'group-invite', conversationId, inviterId, invitedUserId: user.id } })); } }); },
  setMemberRole(conversationId, actorId, targetUserId, role) { this.mutate(db => { const actor = db.members.find(m => m.conversationId===conversationId && m.userId===actorId); if (!actor || actor.role === 'MEMBER') throw new Error('Only owner/admin can change roles'); if (role === 'OWNER') throw new Error('Cannot assign owner'); const member = db.members.find(m => m.conversationId===conversationId && m.userId===targetUserId); if (!member) throw new Error('User not in conversation'); member.role = role; }); },
  updateGroup(conversationId, actorId, { name, description }) { this.mutate(db => { const convo = db.conversations.find(c => c.id === conversationId); if (!convo || convo.type !== 'GROUP') throw new Error('Group not found'); const actor = db.members.find(m => m.conversationId===conversationId && m.userId===actorId); if (!actor || (actor.role!=='OWNER' && actor.role!=='ADMIN')) throw new Error('Only admins/owner can edit'); if (typeof name === 'string' && name.trim()) convo.name = name.trim(); if (typeof description === 'string') convo.description = description; convo.updatedAt = now(); }); },
  createLobby(ownerId, name) { return this.mutate(db => { const existing = db.conversations.find(c => c.type==='LOBBY' && (c.name||'').toLowerCase()===name.toLowerCase()); if (existing) throw new Error('Lobby name already exists'); const convo = { id: db.nextIds.conversation++, type: "LOBBY", name, description: "", isPublic: true, ownerId, createdAt: now(), updatedAt: now(), avatar: undefined }; db.conversations.push(convo); db.members.push({ userId: ownerId, conversationId: convo.id, role: "OWNER", joinedAt: now() }); window.dispatchEvent(new CustomEvent('chat:membership', { detail: { kind: 'lobby-created', conversationId: convo.id, ownerId } })); }).conversations.at(-1); },
  joinLobby(userId, conversationId) { this.mutate(db => { const convo = db.conversations.find(c => c.id === conversationId && c.type === "LOBBY" && c.isPublic); if (!convo) throw new Error("Lobby not found"); const exists = db.members.find(m => m.userId === userId && m.conversationId === conversationId); if (!exists) { db.members.push({ userId, conversationId, role: "MEMBER", joinedAt: now() }); window.dispatchEvent(new CustomEvent('chat:membership', { detail: { kind: 'lobby-joined', conversationId, userId } })); } }); },
  // Lobby search and invites/requests
  findLobbyByExactName(name) { const db = loadDB(); return db.conversations.find(c => c.type==='LOBBY' && (c.name||'').toLowerCase() === name.trim().toLowerCase()) || null; },
  searchLobbiesByName(q) { const db = loadDB(); const s = q.trim().toLowerCase(); if (!s) return []; return db.conversations.filter(c => c.type==='LOBBY' && (c.name||'').toLowerCase().includes(s)); },
  inviteToLobby(lobbyId, inviterId, username) { const user = this.findUserByUsername(username); if (!user) throw new Error('User not found'); this.mutate(db => { const convo = db.conversations.find(c => c.id===lobbyId && c.type==='LOBBY'); if (!convo) throw new Error('Lobby not found'); const inviter = db.members.find(m => m.conversationId===lobbyId && m.userId===inviterId); if (!inviter || (inviter.role!=='OWNER' && inviter.role!=='ADMIN')) throw new Error('Not allowed'); const already = db.members.find(m => m.conversationId===lobbyId && m.userId===user.id); if (already) throw new Error('Already a member'); const invite = { id: db.nextIds.invite++, kind: 'INVITE', lobbyId, fromUserId: inviterId, toUserId: user.id, status: 'PENDING', createdAt: now() }; db.invites.push(invite); window.dispatchEvent(new CustomEvent('lobby:invite:new',{ detail:{ inviteId: invite.id, toUserId: user.id, lobbyId } })); }); },
  listUserInvites(userId) { const db = loadDB(); return db.invites.filter(i => i.toUserId===userId && i.kind==='INVITE' && i.status==='PENDING'); },
  acceptLobbyInvite(inviteId, actingUserId) { this.mutate(db => { const inv = db.invites.find(i=>i.id===inviteId && i.kind==='INVITE'); if (!inv) throw new Error('Invite not found'); if (inv.toUserId !== actingUserId) throw new Error('Not allowed'); inv.status='ACCEPTED'; const exists = db.members.find(m=>m.userId===actingUserId && m.conversationId===inv.lobbyId); if (!exists) db.members.push({ userId: actingUserId, conversationId: inv.lobbyId, role: 'MEMBER', joinedAt: now(), invitedById: inv.fromUserId }); window.dispatchEvent(new CustomEvent('chat:membership', { detail: { kind: 'lobby-joined', conversationId: inv.lobbyId, userId: actingUserId } })); }); },
  declineLobbyInvite(inviteId, actingUserId) { this.mutate(db => { const inv = db.invites.find(i=>i.id===inviteId && i.kind==='INVITE'); if (!inv) throw new Error('Invite not found'); if (inv.toUserId !== actingUserId) throw new Error('Not allowed'); inv.status='REJECTED'; window.dispatchEvent(new CustomEvent('lobby:invite:declined', { detail:{ toUserId: actingUserId, lobbyId: inv.lobbyId } })); }); },
  requestJoinLobbyByName(userId, lobbyName) { this.mutate(db => { const lobby = db.conversations.find(c=>c.type==='LOBBY' && (c.name||'').toLowerCase()===lobbyName.trim().toLowerCase()); if (!lobby) throw new Error('Lobby not found'); const exists = db.members.find(m=>m.userId===userId && m.conversationId===lobby.id); if (exists) throw new Error('Already a member'); const alreadyReq = db.invites.find(i=>i.kind==='REQUEST' && i.lobbyId===lobby.id && i.fromUserId===userId && i.status==='PENDING'); if (alreadyReq) throw new Error('Request already pending'); const req = { id: db.nextIds.invite++, kind: 'REQUEST', lobbyId: lobby.id, fromUserId: userId, toUserId: null, status: 'PENDING', createdAt: now() }; db.invites.push(req); window.dispatchEvent(new CustomEvent('lobby:request:new', { detail:{ fromUserId: userId, lobbyId: lobby.id } })); }); },
  listLobbyRequestsForUser(userId) { const db = loadDB(); const myAdminOf = db.conversations.filter(c=>c.type==='LOBBY' && db.members.some(m=>m.conversationId===c.id && m.userId===userId && (m.role==='OWNER'||m.role==='ADMIN'))).map(c=>c.id); return db.invites.filter(i=>i.kind==='REQUEST' && i.status==='PENDING' && myAdminOf.includes(i.lobbyId)); },
  approveLobbyRequest(inviteId, actorId) { this.mutate(db => { const inv = db.invites.find(i=>i.id===inviteId && i.kind==='REQUEST'); if (!inv) throw new Error('Request not found'); const admin = db.members.find(m=>m.conversationId===inv.lobbyId && m.userId===actorId); if (!admin || (admin.role!=='OWNER' && admin.role!=='ADMIN')) throw new Error('Not allowed'); inv.status='ACCEPTED'; const exists = db.members.find(m=>m.userId===inv.fromUserId && m.conversationId===inv.lobbyId); if (!exists) db.members.push({ userId: inv.fromUserId, conversationId: inv.lobbyId, role: 'MEMBER', joinedAt: now(), invitedById: actorId }); window.dispatchEvent(new CustomEvent('chat:membership', { detail: { kind: 'lobby-joined', conversationId: inv.lobbyId, userId: inv.fromUserId } })); }); },
  rejectLobbyRequest(inviteId, actorId) { this.mutate(db => { const inv = db.invites.find(i=>i.id===inviteId && i.kind==='REQUEST'); if (!inv) throw new Error('Request not found'); const admin = db.members.find(m=>m.conversationId===inv.lobbyId && m.userId===actorId); if (!admin || (admin.role!=='OWNER' && admin.role!=='ADMIN')) throw new Error('Not allowed'); inv.status='REJECTED'; window.dispatchEvent(new CustomEvent('lobby:request:rejected', { detail:{ fromUserId: inv.fromUserId, lobbyId: inv.lobbyId } })); }); },
  updateLobby(conversationId, actorId, { name, description, avatar }) { this.mutate(db => { const convo = db.conversations.find(c => c.id === conversationId); if (!convo || convo.type !== 'LOBBY') throw new Error('Lobby not found'); const actor = db.members.find(m => m.conversationId===conversationId && m.userId===actorId); if (!actor || (actor.role!=='OWNER' && actor.role!=='ADMIN')) throw new Error('Only admins/owner can edit'); if (typeof name === 'string' && name.trim()) convo.name = name.trim(); if (typeof description === 'string') convo.description = description; if (typeof avatar === 'string') convo.avatar = avatar; convo.updatedAt = now(); }); },
  listMessages(conversationId, limit=200) { const db = loadDB(); return db.messages.filter(m => m.conversationId === conversationId).sort((a,b) => a.id - b.id).slice(-limit); },
  lastMessage(conversationId) { const msgs = this.listMessages(conversationId, 1e9); return msgs[msgs.length-1] || null; },
  postMessage(conversationId, senderId, body, metadata) { this.mutate(db => { const msg = { id: db.nextIds.message++, conversationId, senderId, body, metadata, createdAt: now() }; db.messages.push(msg); const convo = db.conversations.find(c => c.id === conversationId); if (convo) convo.updatedAt = now(); const sender = db.users.find(u=>u.id===senderId); if (sender) sender.lastSeen = now(); window.dispatchEvent(new CustomEvent('chat:new', { detail: { msg } })); }); },
};

function presenceFor(user) {
  const ms = now() - (user?.lastSeen||0);
  if (ms < 2*60*1000) return 'ONLINE';
  if (ms < 10*60*1000) return 'AWAY';
  return 'OFFLINE';
}

const EMOJIS = [
  { ch:"😀", name:"grinning" }, { ch:"😁", name:"beaming" }, { ch:"😂", name:"joy" }, { ch:"🤣", name:"rofl" },
  { ch:"😊", name:"smile" }, { ch:"😍", name:"heart eyes" }, { ch:"😘", name:"kiss" }, { ch:"😎", name:"cool" },
  { ch:"🤔", name:"thinking" }, { ch:"😴", name:"sleep" }, { ch:"🙌", name:"raised hands" }, { ch:"👏", name:"clap" },
  { ch:"👍", name:"thumbs up" }, { ch:"🙏", name:"pray" }, { ch:"🔥", name:"fire" }, { ch:"🎉", name:"tada" },
  { ch:"✨", name:"sparkles" }, { ch:"❤️", name:"red heart" }, { ch:"💙", name:"blue heart" }, { ch:"💯", name:"100" },
  { ch:"🧠", name:"brain" }, { ch:"🛠️", name:"tools" }, { ch:"🎧", name:"headphones" }, { ch:"🍕", name:"pizza" },
  { ch:"☕", name:"coffee" }, { ch:"🚀", name:"rocket" }, { ch:"🪄", name:"magic" }, { ch:"📎", name:"paperclip" }
];

function EmojiPicker({ onPick }) {
  const [q, setQ] = useState("");
  const filtered = useMemo(() => { const s = q.trim().toLowerCase(); return !s ? EMOJIS : EMOJIS.filter(e => e.name.includes(s)); }, [q]);
  return (
    <div className="border rounded-2xl p-3 bg-white shadow-sm w-64">
      <input value={q} onChange={e=>setQ(e.target.value)} placeholder="Search emojis…" className="w-full px-2 py-1 text-sm border rounded-lg" />
      <div className="grid grid-cols-8 gap-2 max-h-40 overflow-y-auto">
        {filtered.map(e => (
          <button key={e.ch+e.name} onClick={()=>onPick(e.ch)} className="text-xl leading-none hover:scale-110">{e.ch}</button>
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
function Button({ children, onClick, className="", disabled, type="button" }) { return <button type={type} onClick={onClick} disabled={disabled} className={`px-3 py-2 rounded-lg bg-black text-white text-sm disabled:opacity-50 ${className}`}>{children}</button> }
function Textarea(props) { return <textarea {...props} className={`w-full px-3 py-2 rounded-lg border border-gray-300 focus:outline-none focus:ring h-24 ${props.className||''}`} /> }
function formatTime(ts) { const d = new Date(ts); return d.toLocaleString(); }
function Avatar({ user, size=32 }) { const style = { width: size, height: size };
  const status = user?.showActive ? presenceFor(user) : null;
  const ring = status==='ONLINE'? 'ring-2 ring-green-500' : status==='AWAY'? 'ring-2 ring-yellow-400' : status==='OFFLINE'? 'ring-2 ring-gray-400' : '';
  if (user?.avatar) return <img src={user.avatar} alt={user.username} className={`rounded-full object-cover ${ring}`} style={style} />;
  return <div className={`rounded-full bg-gray-900 text-white flex items-center justify-center uppercase ${ring}`} style={style}>{user?.username?.slice(0,1)}</div>;
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
    const onNew = (e) => { const { msg } = e.detail; if (msg.senderId !== me.id && msg.conversationId !== activeConversationId) pushToast(msg.conversationId, msg.senderId); };
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

function NotificationBell({ me, activeConversationId }) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const onNew = (e) => { const { msg } = e.detail; if (msg.senderId !== me.id && msg.conversationId !== activeConversationId) setCount(c => c + 1); };
    const onAny = () => setCount(c => c + 1);
    window.addEventListener('chat:new', onNew);
    window.addEventListener('chat:membership', onAny);
    window.addEventListener('lobby:request:rejected', onAny);
    window.addEventListener('lobby:invite:new', onAny);
    return () => { window.removeEventListener('chat:new', onNew); window.removeEventListener('chat:membership', onAny); window.removeEventListener('lobby:request:rejected', onAny); window.removeEventListener('lobby:invite:new', onAny); };
  }, [me.id, activeConversationId]);
  return (
    <button className="relative px-3 py-2 rounded-lg border hover:bg-gray-50" onClick={() => setCount(0)} title="Notifications">
      <span role="img" aria-label="bell">🔔</span>
      {count > 0 && (
        <span className="absolute -top-1 -right-1 bg-red-600 text-white text-[10px] px-1.5 py-0.5 rounded-full">{count}</span>
      )}
    </button>
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
  if (!user) return null;
  const memberships = dao.listUserMemberships(user.id);
  const convos = memberships.map(m => dao.getConversation(m.conversationId)).filter(Boolean);
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <Avatar user={user} size={56} />
        <div>
          <div className="text-lg font-semibold">{user.username}</div>
          {user.bio && <div className="text-sm text-gray-600">{user.bio}</div>}
        </div>
      </div>
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
            <MemberRow key={m.userId} me={me} convo={convo} member={m} canManage={myRole==='OWNER'} onChanged={onSaved} />
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
            <MemberRow key={m.userId} me={me} convo={convo} member={m} canManage={myRole==='OWNER'} onChanged={onSaved} />
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
  const [mode, setMode] = useState("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const userRef = useRef(null); const passRef = useRef(null);
  function submit() { setErr(""); try { if (mode === "signup") dao.createUser(username.trim(), password); const u = dao.login(username.trim(), password); onAuthed(u); } catch (e) { setErr(e.message); } }
  return (
    <div className="min-h-[70vh] flex flex-col items-center justify-center">
      <div className="w-full max-w-2xl flex items-center justify-between mb-6 px-2">
        <div className="text-xl font-bold">Secure chat</div>
        <div className="text-xs text-gray-500">Minimal, fast, simple</div>
      </div>
      <div className="w-full max-w-md bg-white shadow rounded-2xl p-6">
        <div className="flex gap-2 mb-4">
          <button className={`flex-1 rounded-xl py-2 ${mode==="login"?"bg-black text-white":"bg-gray-100"}`} onClick={()=>setMode("login")}>Login</button>
          <button className={`flex-1 rounded-xl py-2 ${mode==="signup"?"bg-black text-white":"bg-gray-100"}`} onClick={()=>setMode("signup")}>Sign up</button>
        </div>
        <form className="space-y-3" onSubmit={e=>{e.preventDefault(); submit();}}>
          <Input ref={userRef} placeholder="Username" value={username} onChange={e=>setUsername(e.target.value)} onKeyDown={e=>{ if(e.key==='Enter'){ e.preventDefault(); passRef.current?.focus(); } }} />
          <Input ref={passRef} placeholder="Password" type="password" value={password} onChange={e=>setPassword(e.target.value)} onKeyDown={e=>{ if(e.key==='Enter'){ e.preventDefault(); submit(); } }} />
          {err && <div className="text-red-600 text-sm">{err}</div>}
          <Button className="w-full" type="submit">{mode==="login"?"Log in":"Create account & log in"}</Button>
          <p className="text-xs text-gray-500">Demo only. Try <b>alice</b>/<b>secret123</b> or <b>bob</b>/<b>secret123</b>.</p>
        </form>
      </div>
      <div className="w-full max-w-2xl mt-6 text-xs text-gray-500 flex items-center justify-between px-2">
        <div>© All rights reserved · <a className="underline" href="#" onclick="return false;">Terms & Conditions</a></div>
        <div className="space-x-4"><a className="underline" href="mailto:akcorp2000@gmail.com">Contact us</a><a className="underline" href="#" onclick="return false;">About us</a></div>
      </div>
    </div>
  );
}

function ToolsPane({ me, onLogout, onOpenConversation }) {
  const [searchUsername, setSearchUsername] = useState("");
  const [searchResult, setSearchResult] = useState();
  const [groupName, setGroupName] = useState("");
  const [groupMembers, setGroupMembers] = useState("");
  const [lobbyQuery, setLobbyQuery] = useState("");
  const [lobbySearch, setLobbySearch] = useState([]);
  const [invites, setInvites] = useState([]);
  const [requestsToApprove, setRequestsToApprove] = useState([]);
  useEffect(() => {
    const update = () => {
      setInvites(dao.listUserInvites(me.id));
      setRequestsToApprove(dao.listLobbyRequestsForUser(me.id));
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
  function acceptInvite(id) { try { dao.acceptLobbyInvite(id, me.id); } catch(e) { alert(e.message);} }
  function declineInvite(id) { try { dao.declineLobbyInvite(id, me.id); } catch(e) { alert(e.message);} }
  function approveRequest(id) { try { dao.approveLobbyRequest(id, me.id); } catch(e) { alert(e.message);} }
  function rejectRequest(id) { try { dao.rejectLobbyRequest(id, me.id); } catch(e) { alert(e.message);} }
  return (
    <div className="h-full overflow-y-auto p-3 space-y-4">
      <Section title="You" right={<Button className="bg-gray-800" onClick={onLogout}>Logout</Button>}>
        <div className="flex items-center gap-2 mb-2">
          <Avatar user={me} size={36} />
          <div>
            <div className="font-medium">{me.username}</div>
            <div className="text-xs text-gray-500">User #{me.id}</div>
          </div>
        </div>
        <div className="space-y-2">
          <div>
            <div className="text-xs font-semibold mb-1">Your Invites</div>
            {invites.length===0 && <div className="text-xs text-gray-500">No invites.</div>}
            {invites.map(inv => { const l = dao.getConversation(inv.lobbyId); return (
              <div key={inv.id} className="flex items-center justify-between p-2 border rounded-lg">
                <div className="text-sm">Lobby: <b>{l?.name}</b></div>
                <div className="flex gap-2">
                  <Button className="bg-gray-700" onClick={()=>acceptInvite(inv.id)}>Accept</Button>
                  <Button onClick={()=>declineInvite(inv.id)}>Decline</Button>
                </div>
              </div>
            ); })}
          </div>
          <div>
            <div className="text-xs font-semibold mb-1">Requests to Approve</div>
            {requestsToApprove.length===0 && <div className="text-xs text-gray-500">No pending requests.</div>}
            {requestsToApprove.map(req => { const l = dao.getConversation(req.lobbyId); const u = dao.findUserById(req.fromUserId); return (
              <div key={req.id} className="flex items-center justify-between p-2 border rounded-lg">
                <div className="text-sm">{u?.username} → <b>{l?.name}</b></div>
                <div className="flex gap-2">
                  <Button className="bg-gray-700" onClick={()=>approveRequest(req.id)}>Approve</Button>
                  <Button onClick={()=>rejectRequest(req.id)}>Reject</Button>
                </div>
              </div>
            ); })}
          </div>
        </div>
      </Section>
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
              <Button onClick={()=>window.dispatchEvent(new CustomEvent('profile:view',{ detail:{ userId: searchResult.id } }))}>View</Button>
            </div>
          </div>
        ) : null}
      </Section>
      <Section title="Create group">
        <form className="space-y-2" onSubmit={e=>{e.preventDefault(); createGroup();}}>
          <Input value={groupName} onChange={e=>setGroupName(e.target.value)} placeholder="Group name" />
          <Input value={groupMembers} onChange={e=>setGroupMembers(e.target.value)} placeholder="Members (comma‑separated usernames)" />
          <Button type="submit" disabled={!groupName.trim()}>Create</Button>
        </form>
      </Section>
      <Section title="Lobby">
        <form className="flex gap-2" onSubmit={e=>{e.preventDefault(); setLobbySearch(dao.searchLobbiesByName(lobbyQuery));}}>
          <Input value={lobbyQuery} onChange={e=>setLobbyQuery(e.target.value)} placeholder="Search" />
          <Button type="submit">Search</Button>
        </form>
        {lobbyQuery.trim() && (
          <div className="mt-2 space-y-2">
            {lobbySearch.map(l => (
              <div key={l.id} className="flex items-center justify-between p-2 border rounded-lg">
                <div className="text-sm">{l.name}</div>
                <div className="flex gap-2">
                  <Button onClick={()=>requestJoin(l.name)}>Request to join</Button>
                  <Button className="bg-gray-700" onClick={()=>onOpenConversation(l.id)}>Open</Button>
                </div>
              </div>
            ))}
            {dao.findLobbyByExactName(lobbyQuery) ? null : (
              <div className="flex items-center justify-between p-2 border rounded-lg">
                <div className="text-sm">Create lobby "{lobbyQuery}" (available)</div>
                <Button onClick={()=>createLobby(lobbyQuery)}>Create</Button>
              </div>
            )}
          </div>
        )}
      </Section>
    </div>
  );
}

function ConversationsPane({ me, onOpenConversation, onOpenInfo }) {
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState('ALL');
  const [tick, setTick] = useState(0);
  useEffect(() => { const onUpdate=()=>setTick(x=>x+1); window.addEventListener('chatdb:update', onUpdate); return ()=>window.removeEventListener('chatdb:update', onUpdate); }, []);
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
          return (
            <div key={c.id} className="flex items-center justify-between p-2 rounded-lg border hover:bg-gray-50">
              <div className="flex items-center gap-3 min-w-0">
                {c.type==='DIRECT' ? <Avatar user={avatarUser} /> : <div className={`${c.type==='GROUP'?'bg-blue-100':'bg-green-100'} rounded-full h-8 w-8 flex items-center justify-center text-sm`}>{c.type==='GROUP'?'G':'L'}</div>}
                <div className="min-w-0">
                  <div className="text-sm font-medium flex items-center gap-2 min-w-0">
                    {c.type==='DIRECT' && <Pill>DM</Pill>}
                    {c.type==='GROUP' && <Pill className="bg-blue-100">Group</Pill>}
                    {c.type==='LOBBY' && <Pill className="bg-green-100">Lobby</Pill>}
                    <span className="truncate">{title}</span>
                  </div>
                  <div className="text-xs text-gray-500 truncate w-64">{last ? `${dao.findUserById(last.senderId)?.username}: ${last.body}` : 'No messages yet'}</div>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                {c.type!=='DIRECT' && <Button className="bg-gray-700" onClick={()=>onOpenInfo(c.id)}>Info</Button>}
                {c.type==='DIRECT' && avatarUser && <Button className="bg-gray-700" onClick={()=>window.dispatchEvent(new CustomEvent('profile:view',{ detail:{ userId: avatarUser.id } }))}>View</Button>}
                <Button onClick={()=>onOpenConversation(c.id)}>Open</Button>
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
  const [openInfo, setOpenInfo] = useState(false);
  const [tick, setTick] = useState(0);
  const scroller = useRef(null);
  useEffect(() => { const onUpdate=()=>setTick(x=>x+1); window.addEventListener('chatdb:update', onUpdate); return ()=>window.removeEventListener('chatdb:update', onUpdate); }, []);
  const convo = dao.getConversation(conversationId);
  const messages = dao.listMessages(conversationId);
  const isGroup = convo?.type === "GROUP"; const isLobby = convo?.type === "LOBBY";
  const myRole = dao.getRole(conversationId, me.id);
  const isMember = dao.isMember(conversationId, me.id);
  const otherId = convo?.type==='DIRECT' ? dao.listMembers(convo.id).map(m=>m.userId).find(id=>id!==me.id) : undefined;
  useEffect(() => { if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; }, [messages.length, conversationId]);
  useEffect(() => { if (forceInfoId && forceInfoId === conversationId) { setOpenInfo(true); onConsumeForceInfo(); } }, [forceInfoId, conversationId, onConsumeForceInfo]);
  if (!convo) return <div className="p-6">Conversation not found.</div>;
  function send() { if (!body.trim()) return; if (isLobby && !isMember) { alert('Join the lobby to participate.'); return; } dao.postMessage(conversationId, me.id, body.trim()); setBody(""); }
  function inviteGroup() { try { dao.inviteToGroup(conversationId, me.id, inviteUser.trim()); setInviteUser(""); } catch (e) { alert(e.message); } }
  function inviteLobby() { try { dao.inviteToLobby(conversationId, me.id, inviteUser.trim()); setInviteUser(""); } catch (e) { alert(e.message); } }
  const title = convo.name || (convo.type === "DIRECT" ? labelForDirect(convo, me.id) : (convo.type));
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
          {(isGroup || isLobby) && <Button className="bg-gray-700" onClick={()=>setOpenInfo(true)}>{isGroup? 'Group Info':'Lobby Info'}</Button>}
          {convo.type==='DIRECT' && otherId && <Button className="bg-gray-700" onClick={()=>window.dispatchEvent(new CustomEvent('profile:view',{ detail:{ userId: otherId } }))}>View Profile</Button>}
          <div className="text-xs text-gray-500">Convo #{convo.id}</div>
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
      <div ref={scroller} className="flex-1 overflow-y-auto p-4 space-y-2 bg-gray-50">
        {messages.map(m => (
          <div key={m.id} className={`max-w-xl ${m.senderId===me.id?"ml-auto":""}`}>
            <div className={`rounded-2xl px-3 py-2 ${m.senderId===me.id?"bg-black text-white":"bg-white border"}`}>
              <div className="flex items-center gap-2 text-xs opacity-70 mb-0.5">
                <button onClick={()=>window.dispatchEvent(new CustomEvent('profile:view',{ detail:{ userId: m.senderId } }))}><Avatar user={dao.findUserById(m.senderId)} size={18} /></button>
                <span>{dao.findUserById(m.senderId)?.username}</span>
                <span>· {new Date(m.createdAt).toLocaleTimeString()}</span>
              </div>
              <div className="whitespace-pre-wrap text-sm">{m.body}</div>
            </div>
          </div>
        ))}
        {messages.length===0 && <div className="text-xs text-gray-500">No messages yet.</div>}
      </div>
      <div className="p-3 border-t flex gap-2 items-end relative">
        <div className="flex-1">
          <Textarea value={body} onChange={e=>setBody(e.target.value)} disabled={isLobby && !isMember} placeholder={isLobby && !isMember?"Join the lobby to send messages":"Write a message… (Enter = send, Shift+Enter = newline)"} onKeyDown={e=>{ if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); send(); } }} />
          {showEmoji && (<div className="absolute bottom-20 left-3"><EmojiPicker onPick={(e)=>{ setBody(b=>b + e); setShowEmoji(false); }} /></div>)}
        </div>
        <div className="flex flex-col gap-2">
          <Button onClick={()=>setShowEmoji(s=>!s)} className="bg-gray-700" aria-label="Toggle emoji picker">😀</Button>
          <Button onClick={send} disabled={isLobby && !isMember}>Send</Button>
          {isLobby && !isMember && <Button className="bg-gray-700" onClick={()=>dao.joinLobby(me.id, conversationId)}>Join lobby</Button>}
        </div>
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
  useEffect(() => { const sess = sessionStorage.getItem("chat_demo_user"); if (sess) setMe(JSON.parse(sess)); const onView = (e) => { setProfileUserId(e.detail.userId); setShowProfileView(true); }; window.addEventListener('profile:view', onView); return () => window.removeEventListener('profile:view', onView); }, []);
  useEffect(() => { if (me) sessionStorage.setItem("chat_demo_user", JSON.stringify(me)); else sessionStorage.removeItem("chat_demo_user"); }, [me]);
  // Presence ticker
  useEffect(() => { if (!me) return; const id = setInterval(()=>dao.touchUser(me.id), 30*1000); return ()=>clearInterval(id); }, [me?.id]);
  function onAuthed(u) { setMe(u); const convos = dao.listUserConversations(u.id); setActiveId(convos[0]?.id ?? null); }
  function logout() { setMe(null); setActiveId(null); }
  function onDragLeft(dx) { setWL(v => Math.min(Math.max(v + dx, 220), 500)); }
  function onDragMid(dx) { setWM(v => Math.min(Math.max(v + dx, 260), 600)); }
  function openInfo(convoId) { setActiveId(convoId); setForceInfoId(convoId); }
  function consumeForceInfo() { setForceInfoId(null); }
  useEffect(() => { function onVis(){ if (me) dao.touchUser(me.id); } window.addEventListener('visibilitychange', onVis); window.addEventListener('focus', onVis); return ()=>{ window.removeEventListener('visibilitychange', onVis); window.removeEventListener('focus', onVis); }; }, [me?.id]);
  if (!me) return <AuthView onAuthed={onAuthed} />;
  return (
    <div className="min-h-screen bg-white text-gray-900">
      <div className="max-w-7xl mx-auto p-4">
        <header className="mb-4 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Secure chat</h1>
          </div>
          <div className="flex items-center gap-2">
            {me && <NotificationBell me={me} activeConversationId={activeId} />}
            {me && <ProfileMenuEnhanced me={me} onLogout={logout} onEdit={()=>setShowProfileEdit(true)} onOpenSettings={()=>setShowSettings(true)} />}
          </div>
        </header>
        <div className="h-[72vh] rounded-2xl border bg-white overflow-hidden relative">
          <div className="h-full flex">
            <div style={{width:wL}} className="h-full border-r min-w-[200px] max-w-[40vw]">
              <ToolsPane me={me} onLogout={logout} onOpenConversation={setActiveId} />
            </div>
            <DragHandle onDrag={onDragLeft} />
            <div style={{width:wM}} className="h-full border-r min-w-[260px] max-w-[50vw]">
              <ConversationsPane me={me} onOpenConversation={setActiveId} onOpenInfo={openInfo} />
            </div>
            <DragHandle onDrag={onDragMid} />
            <div className="flex-1 min-w-0">
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
        <div className="mt-6 text-xs text-gray-500 flex items-center justify-between">
          <div>© All rights reserved · <a className="underline" href="#" onclick="return false;">Terms & Conditions</a></div>
          <div className="space-x-4"><a className="underline" href="mailto:akcorp2000@gmail.com">Contact us</a><a className="underline" href="#" onclick="return false;">About us</a></div>
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

function ProfileMenuEnhanced({ me, onLogout, onEdit, onOpenSettings }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button className="flex items-center gap-2" onClick={()=>setOpen(o=>!o)}>
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
          <button className="w-full text-left text-sm px-3 py-2 rounded-lg hover:bg-gray-50" onClick={()=>{ setOpen(false); onEdit(); }}>Edit profile</button>
          <button className="w-full text-left text-sm px-3 py-2 rounded-lg hover:bg-gray-50" onClick={()=>{ setOpen(false); onOpenSettings(); }}>Settings</button>
          <button className="w-full text-left text-sm px-3 py-2 rounded-lg hover:bg-gray-50 text-red-600" onClick={onLogout}>Logout</button>
        </div>
      )}
    </div>
  );
}

function SettingsView() {
  return (
    <div className="space-y-4">
      <div>
        <h4 className="text-sm font-semibold mb-1">General</h4>
        <div className="text-xs text-gray-500">More settings coming soon.</div>
      </div>
      <div>
        <h4 className="text-sm font-semibold mb-1">Privacy</h4>
        <div className="text-xs text-gray-500">Manage your profile and presence from Edit Profile.</div>
      </div>
    </div>
  );
}

// Mount app
const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);


