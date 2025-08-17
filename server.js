const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { nanoid } = require('nanoid');
// Prisma replaces SQLite
const { PrismaClient } = require('@prisma/client');
const dotenv = require('dotenv');
const pino = require('pino');
const pinoHttp = require('pino-http');
const z = require('zod');
const cookieParser = require('cookie-parser');
const { hashPassword, verifyPassword, signJwt, verifyJwt } = require('./auth');
const { createRedis } = require('./redis');
const { createAdapter } = require('@socket.io/redis-adapter');
const { createPresignedPost, getSignedGetUrl } = require('./media');
const promClient = require('prom-client');
const { track } = require('./analytics/emitter');
const { generateUlid } = require('./utils/ulids');
// S3 client for media proxy
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const R2_ENDPOINT = process.env.R2_ENDPOINT || 'https://example.r2.cloudflarestorage.com';
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || '';
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || '';
const R2_BUCKET = process.env.R2_BUCKET || '';
const s3 = new S3Client({ region:'auto', endpoint:R2_ENDPOINT, credentials:{ accessKeyId:R2_ACCESS_KEY_ID, secretAccessKey:R2_SECRET_ACCESS_KEY } });

// Load environment variables from .env if present
dotenv.config();

const app = express();
const server = http.createServer(app);

// Environment configuration
const PORT = Number(process.env.PORT) || 3000;

function parseAllowedOrigins(input) {
  const defaultOrigins = [
    'http://localhost:3000',
  ];
  if (!input) return defaultOrigins;
  try {
    const parsed = JSON.parse(input);
    if (Array.isArray(parsed) && parsed.every((v) => typeof v === 'string')) return parsed;
  } catch (err) {
    // fall through to comma list parsing
  }
  const parts = String(input)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : defaultOrigins;
}

const ALLOWED_ORIGINS = parseAllowedOrigins(process.env.ALLOWED_ORIGINS);
// Enable CORS for REST API (credentials allowed). For same-origin this is benign.
const cors = require('cors');
app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }));

// Socket allow-list parsed directly per spec (fallback to ["*"])
const SOCKET_ALLOWED_ORIGINS = (() => {
  try {
    return JSON.parse(process.env.ALLOWED_ORIGINS || '["*"]');
  } catch (_) {
    return ['*'];
  }
})();

// Structured logger (pino) with request IDs
const baseLogger = pino({ level: process.env.LOG_LEVEL || 'info' });
const httpLogger = pinoHttp({
  logger: baseLogger,
  genReqId: () => nanoid(12),
});
app.use(httpLogger);
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());

// Healthcheck
app.get('/healthz', (_req, res) => res.status(200).send('ok'));
// DB health
app.get('/health/db', async (_req, res) => {
  try {
    const users = await prisma.user.count();
    const rooms = await prisma.room.count();
    return res.json({ ok: true, users, rooms });
  } catch (e) {
    baseLogger.error({ err: e }, 'db health failed');
    return res.status(500).json({ ok: false });
  }
});

// Session inspect (decode JWT from cookie)
app.get('/api/session', (req, res) => {
  try {
    const cookieHeader = req.headers.cookie||'';
    const cookies = Object.fromEntries(cookieHeader.split(';').map(p=>{ const i=p.indexOf('='); return [p.slice(0,i).trim(), decodeURIComponent(p.slice(i+1).trim())]; }));
    const token = cookies.sid;
    if (!token) return res.status(401).json({ ok:false, error:'no-session' });
    const claims = verifyJwt(token);
    const crossSite = String(process.env.CROSS_SITE||'false') === 'true';
    const expected = { sameSite: crossSite? 'none':'lax', secure: crossSite? true : (process.env.NODE_ENV==='production') };
    return res.json({ ok:true, claims, expectedCookie: expected });
  } catch (e) {
    return res.status(401).json({ ok:false, error:'invalid-session' });
  }
});

// Test logging endpoints
app.post('/api/testlog', async (req, res) => {
  try {
    const { runId, section, level, message, meta } = req.body || {};
    if (!runId || !section || !level || !message) return res.status(400).json({ ok:false, error:'bad-request' });
    const id = nanoid(16);
    await prisma.$executeRawUnsafe(`INSERT INTO "TestLog" (id, run_id, section, level, message, meta) VALUES ($1,$2,$3,$4,$5,$6)`, id, String(runId), String(section), String(level), String(message), meta? JSON.stringify(meta): '{}');
    return res.json({ ok:true, id });
  } catch (e) {
    baseLogger.error({ err:e }, 'testlog insert failed');
    return res.status(500).json({ ok:false });
  }
});
app.get('/api/testlog', async (req, res) => {
  try {
    const runId = String(req.query.runId||'').trim();
    const level = String(req.query.level||'').trim();
    const section = String(req.query.section||'').trim();
    let where = '1=1'; const params = [];
    if (runId) { params.push(runId); where += ` AND run_id=$${params.length}`; }
    if (level) { params.push(level); where += ` AND level=$${params.length}`; }
    if (section) { params.push(section); where += ` AND section=$${params.length}`; }
    const rows = await prisma.$queryRawUnsafe(`SELECT id, run_id as "runId", section, level, message, meta, created_at as "createdAt" FROM "TestLog" WHERE ${where} ORDER BY created_at DESC LIMIT 500`, ...params);
    return res.json({ ok:true, logs: rows });
  } catch (e) {
    baseLogger.error({ err:e }, 'testlog list failed');
    return res.status(500).json({ ok:false });
  }
});

// Test run and metric endpoints
app.post('/api/testrun', async (req, res) => {
  try {
    const id = String(req.body?.runId || '') || nanoid(16);
    const meta = req.body?.meta || {};
    await prisma.$executeRawUnsafe(`INSERT INTO "TestRun" (id, meta) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET meta=$2`, id, JSON.stringify(meta));
    return res.json({ ok:true, runId: id });
  } catch (e) { baseLogger.error({ err:e }, 'testrun failed'); return res.status(500).json({ ok:false }); }
});

// Test helpers (dev utility): issue tokens, rooms, memberships
app.post('/api/test/issue-token', async (req, res) => {
  try {
    const { username } = req.body || {};
    if (!username || typeof username !== 'string' || username.trim().length < 3) return res.status(400).json({ ok:false, error:'bad-username' });
    let user = await prisma.user.findUnique({ where: { username } });
    if (!user) {
      user = await prisma.user.create({ data: { id: nanoid(12), username, passwordHash: hashPassword('secret123') } });
    }
    const token = signJwt({ id: user.id, name: user.username });
    return res.json({ ok:true, token, userId: user.id });
  } catch (e) { baseLogger.error({ err:e }, 'issue-token failed'); return res.status(500).json({ ok:false }); }
});
app.post('/api/test/room', async (req, res) => {
  try { const { roomId } = req.body || {}; if (!roomId) return res.status(400).json({ ok:false, error:'bad-room' }); await prisma.room.upsert({ where:{ id:String(roomId) }, create:{ id:String(roomId) }, update:{} }); return res.json({ ok:true }); } catch (e) { baseLogger.error({ err:e }, 'test room failed'); return res.status(500).json({ ok:false }); }
});
app.post('/api/test/add-member', async (req, res) => {
  try {
    const { roomId, username } = req.body || {};
    if (!roomId || !username) return res.status(400).json({ ok:false, error:'bad-request' });
    const user = await prisma.user.findUnique({ where: { username:String(username) } });
    if (!user) return res.status(404).json({ ok:false, error:'user-not-found' });
    await prisma.roomMember.upsert({
      where: { roomId_userId: { roomId: String(roomId), userId: user.id } },
      create: { id: nanoid(12), roomId: String(roomId), userId: user.id },
      update: {},
    });
    return res.json({ ok:true });
  } catch (e) { baseLogger.error({ err:e }, 'add-member failed'); return res.status(500).json({ ok:false }); }
});
app.post('/api/testmetric', async (req, res) => {
  try {
    const { runId, name, value, unit, meta } = req.body||{};
    if (!runId || !name || typeof value !== 'number') return res.status(400).json({ ok:false, error:'bad-request' });
    const id = nanoid(16);
    await prisma.$executeRawUnsafe(`INSERT INTO "TestMetric" (id, run_id, name, value, unit, meta) VALUES ($1,$2,$3,$4,$5,$6)`, id, String(runId), String(name), value, unit? String(unit): null, meta? JSON.stringify(meta): '{}');
    return res.json({ ok:true, id });
  } catch (e) { baseLogger.error({ err:e }, 'testmetric failed'); return res.status(500).json({ ok:false }); }
});

// Metrics
const metricsRegistry = new promClient.Registry();
promClient.collectDefaultMetrics({ register: metricsRegistry });
const wsConnects = new promClient.Counter({ name: 'ws_connects_total', help: 'Total WebSocket connects' });
const wsMessages = new promClient.Counter({ name: 'ws_messages_total', help: 'Total WebSocket messages' });
const wsThrottled = new promClient.Counter({ name: 'ws_throttled_total', help: 'Total throttled WS events' });
const wsMessageBytes = new promClient.Histogram({ name: 'ws_message_bytes', help: 'WS message size in bytes', buckets: [64,256,1024,4096,16384,65536,262144] });
const wsJoinLatency = new promClient.Histogram({ name: 'ws_join_latency_ms', help: 'Join latency in ms', buckets: [10,25,50,100,200,400,800,1600] });
const unreadGauge = new promClient.Gauge({ name: 'chat_unread_estimate', help: 'Estimated unread messages (room_read_state delta)', labelNames: ['roomId','userId'] });
const outboxLagGauge = new promClient.Gauge({ name: 'outbox_unprocessed', help: 'Count of unprocessed outbox rows' });
// HTTP auth metrics
const httpAuthLogin = new promClient.Counter({ name: 'http_auth_login_total', help: 'Login attempts by status code', labelNames: ['code'] });
const httpAuthRegister = new promClient.Counter({ name: 'http_auth_register_total', help: 'Register attempts by status code', labelNames: ['code'] });
const httpAuthLoginLatency = new promClient.Histogram({ name: 'http_auth_login_latency_ms', help: 'Login latency ms', buckets: [5,10,20,50,100,200,400,800] });
const httpAuthRegisterLatency = new promClient.Histogram({ name: 'http_auth_register_latency_ms', help: 'Register latency ms', buckets: [5,10,20,50,100,200,400,800] });
// HTTP message/search metrics
const httpMessages = new promClient.Counter({ name: 'http_messages_total', help: 'Messages endpoint hits by status', labelNames: ['code'] });
const httpMessagesLatency = new promClient.Histogram({ name: 'http_messages_latency_ms', help: 'Messages endpoint latency', buckets: [5,10,20,50,100,200,400,800,1600] });
const httpSearch = new promClient.Counter({ name: 'http_search_total', help: 'Search endpoint hits by status', labelNames: ['code'] });
const httpSearchLatency = new promClient.Histogram({ name: 'http_search_latency_ms', help: 'Search endpoint latency', buckets: [5,10,20,50,100,200,400,800,1600] });
metricsRegistry.registerMetric(wsConnects);
metricsRegistry.registerMetric(wsMessages);
metricsRegistry.registerMetric(wsThrottled);
metricsRegistry.registerMetric(wsMessageBytes);
metricsRegistry.registerMetric(wsJoinLatency);
metricsRegistry.registerMetric(unreadGauge);
metricsRegistry.registerMetric(outboxLagGauge);
metricsRegistry.registerMetric(httpAuthLogin);
metricsRegistry.registerMetric(httpAuthRegister);
metricsRegistry.registerMetric(httpAuthLoginLatency);
metricsRegistry.registerMetric(httpAuthRegisterLatency);
metricsRegistry.registerMetric(httpMessages);
metricsRegistry.registerMetric(httpMessagesLatency);
metricsRegistry.registerMetric(httpSearch);
metricsRegistry.registerMetric(httpSearchLatency);

app.get('/metrics', async (req, res) => {
  const user = process.env.METRICS_USER;
  const pass = process.env.METRICS_PASS;
  if (user && pass) {
    const hdr = req.headers.authorization || '';
    const expected = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
    if (hdr !== expected) return res.status(401).set('WWW-Authenticate', 'Basic realm="metrics"').end('Unauthorized');
  }
  res.set('Content-Type', metricsRegistry.contentType);
  res.end(await metricsRegistry.metrics());
});

// Search (Postgres FTS) — simple driver behind a flag
app.get('/search', async (req, res) => {
  const t0 = Date.now();
  try {
    if ((process.env.SEARCH_DRIVER||'pg_fts') !== 'pg_fts') return res.status(501).json({ ok:false, error:'search-driver-not-supported' });
    const roomId = String(req.query.roomId||'').trim();
    const q = String(req.query.q||'').trim();
    if (!roomId || !q) { httpSearch.inc({ code: '400' }); httpSearchLatency.observe(Date.now()-t0); return res.status(400).json({ ok:false, error:'bad-request' }); }
    // Membership gate
    const cookieHeader = req.headers.cookie||'';
    const cookies = Object.fromEntries(cookieHeader.split(';').map(p=>{ const i=p.indexOf('='); return [p.slice(0,i).trim(), decodeURIComponent(p.slice(i+1).trim())]; }));
    const token = cookies.sid; const user = token? verifyJwt(token): null;
    if (!user) { httpSearch.inc({ code: '401' }); httpSearchLatency.observe(Date.now()-t0); return res.status(401).json({ ok:false, error:'unauthorized' }); }
    const member = await prisma.roomMember.findFirst({ where: { roomId, userId: user.id }, select: { id:true } });
    if (!member) { httpSearch.inc({ code: '403' }); httpSearchLatency.observe(Date.now()-t0); return res.status(403).json({ ok:false, error:'forbidden' }); }
    // Query via Prisma raw
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, userId, name, text, ts FROM "Message" WHERE "roomId"=$1 AND text_fts @@ plainto_tsquery($2) ORDER BY ts DESC LIMIT 50`,
      roomId, q
    );
    httpSearch.inc({ code: '200' }); httpSearchLatency.observe(Date.now()-t0);
    return res.json({ ok:true, results: rows.map(r=>({ id:r.id, userId:r.userid||r.userId, name:r.name, text:r.text, ts: typeof r.ts === 'bigint'? Number(r.ts): r.ts })) });
  } catch (e) {
    baseLogger.error({ err:e }, 'search failed');
    httpSearch.inc({ code: '500' }); httpSearchLatency.observe(Date.now()-t0); return res.status(500).json({ ok:false, error:'server-error' });
  }
});

// Media download proxy via query param to avoid path-to-regexp wildcard issues
app.get('/media', async (req, res, next) => {
  try {
    const key = String(req.query.key||'');
    if (!key) return res.status(400).send('missing key');
    const cmd = new GetObjectCommand({ Bucket: R2_BUCKET, Key: key });
    const obj = await s3.send(cmd);
    const mime = obj.ContentType || 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    let bytesOut = 0;
    obj.Body.on('data', (chunk) => { bytesOut += chunk.length; });
    obj.Body.on('end', () => {
      try { track({ type:'media_downloaded', ts: Date.now(), mime, bytes_out: bytesOut }); } catch {}
    });
    obj.Body.on('error', () => {});
    obj.Body.pipe(res);
  } catch (e) {
    next(e);
  }
});

// Compression jobs (stub for demo). In production, enqueue to a worker.
app.post('/jobs/compress', async (req, res) => {
  try {
    const { roomId, keyOriginal, mime } = req.body || {};
    if (!roomId || !keyOriginal || !mime) return res.status(400).json({ ok: false, error: 'invalid' });
    // Download original to temp
    const srcCmd = new GetObjectCommand({ Bucket: R2_BUCKET, Key: keyOriginal });
    const obj = await s3.send(srcCmd);
    const tmpIn = os.tmpdir() + '/' + nanoid(8);
    const tmpOut = os.tmpdir() + '/' + nanoid(8);
    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(tmpIn);
      obj.Body.pipe(ws);
      ws.on('finish', resolve); ws.on('error', reject);
    });
    // Compute sha256 of original
    const sha256 = await new Promise((resolve, reject) => {
      const h = crypto.createHash('sha256');
      const rs = fs.createReadStream(tmpIn);
      rs.on('data', (chunk) => h.update(chunk));
      rs.on('end', () => resolve(h.digest('hex')));
      rs.on('error', reject);
    });
    let outPath = null; let outMime = null;
    let width = null, height = null, durationMs = null, codecs = null; let thumbnailKey = null;
    if (mime.startsWith('image/')) {
      const sharp = require('sharp');
      outPath = tmpOut + '.webp';
      const meta = await sharp(tmpIn).metadata(); width = meta.width||null; height = meta.height||null;
      await sharp(tmpIn).rotate().webp({ quality: 80 }).toFile(outPath);
      outMime = 'image/webp';
    } else if (mime === 'video/mp4') {
      const ffmpeg = require('fluent-ffmpeg');
      const ffmpegPath = require('ffmpeg-static');
      if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);
      outPath = tmpOut + '.mp4';
      // Probe original
      const probe = await new Promise((resolve) => { try { ffmpeg.ffprobe(tmpIn, (err, data)=> resolve({ err, data })); } catch(e){ resolve({ err:e }); } });
      if (probe && probe.data) {
        const v = (probe.data.streams||[]).find(s=>s.codec_type==='video');
        width = v?.width||null; height = v?.height||null; durationMs = Math.round((probe.data.format?.duration||0)*1000)||null; codecs = v?.codec_name||null;
      }
      await new Promise((resolve, reject) => {
        ffmpeg(tmpIn)
          .outputOptions([
            '-vcodec libx264',
            '-preset veryfast',
            '-crf 28',
            '-movflags +faststart',
            '-acodec aac',
            '-b:a 128k',
            '-vf scale=' + "'min(1280,iw)':-2",
          ])
          .on('end', resolve)
          .on('error', reject)
          .save(outPath);
      });
      outMime = 'video/mp4';
    } else {
      // Unsupported type for demo; return original
      try { fs.unlinkSync(tmpIn); } catch {}
      return res.json({ ok: true, keyCompressed: null, bytesCompressed: null, compression: null, sha256, width, height, durationMs, codecs, thumbnailKey });
    }
    const stat = fs.statSync(outPath);
    const compressedKey = keyOriginal + '.optimized' + (outMime === 'image/webp' ? '.webp' : '.mp4');
    const body = fs.createReadStream(outPath);
    await s3.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: compressedKey, Body: body, ContentType: outMime }));
    try { fs.unlinkSync(tmpIn); } catch {}
    try { fs.unlinkSync(outPath); } catch {}
    return res.json({ ok: true, keyCompressed: compressedKey, bytesCompressed: stat.size, compression: outMime === 'image/webp' ? 'webp' : 'mp4', sha256, width, height, durationMs, codecs, thumbnailKey });
  } catch (e) {
    baseLogger.error({ err: e }, 'compress job failed');
    return res.status(500).json({ ok: false });
  }
});

// Auth routes
app.post('/api/register', (req, res) => {
  const t0 = Date.now();
  const parsed = Credentials.safeParse(req.body || {});
  if (!parsed.success) {
    baseLogger.warn({ body: req.body, errors: parsed.error.issues }, 'register validation failed');
    const issues = parsed.error.issues;
    let errorMsg = 'Invalid username/password';
    if (issues.some(i => i.path[0] === 'username' && i.code === 'too_small')) {
      errorMsg = 'Username must be at least 3 characters';
    } else if (issues.some(i => i.path[0] === 'password' && i.code === 'too_small')) {
      errorMsg = 'Password must be at least 6 characters';
    } else if (issues.some(i => i.path[0] === 'username' && i.code === 'too_big')) {
      errorMsg = 'Username must be no more than 64 characters';
    } else if (issues.some(i => i.path[0] === 'password' && i.code === 'too_big')) {
      errorMsg = 'Password must be no more than 200 characters';
    }
    return res.status(400).json({ ok: false, error: errorMsg });
  }
  const { username, password } = parsed.data;
  (async () => {
    const exists = await prisma.user.findUnique({ where: { username }, select: { id: true } });
    if (exists) { httpAuthRegister.inc({ code: '409' }); httpAuthRegisterLatency.observe(Date.now()-t0); return res.status(409).json({ ok: false, error: 'username-taken' }); }
    const id = nanoid(12);
    const passwordHash = hashPassword(password);
    await prisma.user.create({ data: { id, username, passwordHash } });
    httpAuthRegister.inc({ code: '201' }); httpAuthRegisterLatency.observe(Date.now()-t0);
    return res.status(201).json({ ok: true });
  })().catch((e) => {
    baseLogger.error({ err: e }, 'register failed');
    httpAuthRegister.inc({ code: '500' }); httpAuthRegisterLatency.observe(Date.now()-t0);
    return res.status(500).json({ ok: false, error: 'server-error' });
  });
});

app.post('/api/login', (req, res) => {
  const t0 = Date.now();
  const parsed = Credentials.safeParse(req.body || {});
  if (!parsed.success) { 
    baseLogger.warn({ body: req.body, errors: parsed.error.issues }, 'login validation failed');
    httpAuthLogin.inc({ code: '400' }); httpAuthLoginLatency.observe(Date.now()-t0); 
    const issues = parsed.error.issues;
    let errorMsg = 'Invalid username/password';
    if (issues.some(i => i.path[0] === 'username' && i.code === 'too_small')) {
      errorMsg = 'Username must be at least 3 characters';
    } else if (issues.some(i => i.path[0] === 'password' && i.code === 'too_small')) {
      errorMsg = 'Password must be at least 6 characters';
    }
    return res.status(400).json({ ok: false, error: errorMsg }); 
  }
  const { username, password } = parsed.data;
  (async () => {
    const user = await findUserByUsername(username);
    if (!user) { httpAuthLogin.inc({ code: '401' }); httpAuthLoginLatency.observe(Date.now()-t0); return res.status(401).json({ ok: false, error: 'invalid-credentials' }); }
    if (!verifyPassword(password, user.passwordHash)) { httpAuthLogin.inc({ code: '401' }); httpAuthLoginLatency.observe(Date.now()-t0); return res.status(401).json({ ok: false, error: 'invalid-credentials' }); }
    const token = signJwt({ id: user.id, name: user.username });
    const crossSite = String(process.env.CROSS_SITE||'false') === 'true';
    res.cookie('sid', token, {
      httpOnly: true,
      sameSite: crossSite ? 'none' : 'lax',
      secure: crossSite ? true : (process.env.NODE_ENV === 'production'),
      maxAge: 24 * 60 * 60 * 1000,
      path: '/',
    });
    httpAuthLogin.inc({ code: '200' }); httpAuthLoginLatency.observe(Date.now()-t0);
    return res.json({ ok: true });
  })().catch((e) => {
    baseLogger.error({ err: e }, 'login failed');
    httpAuthLogin.inc({ code: '500' }); httpAuthLoginLatency.observe(Date.now()-t0);
    return res.status(500).json({ ok: false, error: 'server-error' });
  });
});

app.post('/api/logout', (_req, res) => {
  res.clearCookie('sid', { path: '/' });
  return res.json({ ok: true });
});

// Upload init: returns presigned POST
app.post('/api/upload/init', async (req, res) => {
  try {
    const { roomId, mime, bytes } = req.body || {};
    if (!req.headers.cookie) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const cookies = Object.fromEntries((req.headers.cookie||'').split(';').map(p=>{const i=p.indexOf('=');return [p.slice(0,i).trim(), decodeURIComponent(p.slice(i+1).trim())];}));
    const token = cookies.sid;
    const user = token ? verifyJwt(token) : null;
    if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });
    if (!roomId || typeof roomId !== 'string') return res.status(400).json({ ok: false, error: 'invalid-room' });
    if (!AllowedMime.has(mime)) return res.status(400).json({ ok: false, error: 'invalid-mime' });
    const nbytes = Number(bytes);
    if (!Number.isFinite(nbytes) || nbytes <= 0 || nbytes > MAX_BYTES) return res.status(400).json({ ok: false, error: 'invalid-size' });
    const key = `${roomId}/${user.id}/${nanoid(16)}`;
    const { url, fields } = await createPresignedPost({ key, contentType: mime, maxBytes: MAX_BYTES });
    return res.json({ ok: true, url, fields, key });
  } catch (e) {
    baseLogger.error({ err: e }, 'upload init failed');
    return res.status(500).json({ ok: false, error: 'server-error' });
  }
});

// Upload complete: record attachment with compression metadata
app.post('/api/upload/complete', async (req, res) => {
  try {
    const { roomId, key, mime, bytes, sha256, keyCompressed, bytesCompressed, compression } = req.body || {};
    if (!req.headers.cookie) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const cookies = Object.fromEntries((req.headers.cookie||'').split(';').map(p=>{const i=p.indexOf('=');return [p.slice(0,i).trim(), decodeURIComponent(p.slice(i+1).trim())];}));
    const token = cookies.sid;
    const user = token ? verifyJwt(token) : null;
    if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });
    if (!roomId || typeof roomId !== 'string') return res.status(400).json({ ok: false, error: 'invalid-room' });
    if (!AllowedMime.has(mime)) return res.status(400).json({ ok: false, error: 'invalid-mime' });
    const nbytes = Number(bytes);
    if (!Number.isFinite(nbytes) || nbytes <= 0 || nbytes > MAX_BYTES) return res.status(400).json({ ok: false, error: 'invalid-size' });
    const id = nanoid(16);
    const ts = Date.now();
    await prisma.attachment.create({ data: {
      id,
      roomId,
      userId: user.id,
      key,
      keyOriginal: key,
      keyCompressed: keyCompressed || null,
      compression: compression || null,
      bytesOriginal: nbytes,
      bytesCompressed: bytesCompressed ? Number(bytesCompressed) : null,
      sha256: sha256 || null,
      contentHash: sha256 || key, // fallback to key if hash missing
      width: req.body.width ? Number(req.body.width) : null,
      height: req.body.height ? Number(req.body.height) : null,
      durationMs: req.body.durationMs ? Number(req.body.durationMs) : null,
      codecs: req.body.codecs || null,
      thumbnailKey: req.body.thumbnailKey || null,
      status: 'READY',
      mime,
      ts: BigInt(ts)
    } });
    const downloadKey = keyCompressed || key;
    const url = await getSignedGetUrl(downloadKey);
    track({ type:'media_uploaded', ts: ts, userId: user.id, roomId, mime, bytes_in: nbytes });
    return res.json({ ok: true, id, url, downloadKey, compression: compression || null });
  } catch (e) {
    baseLogger.error({ err: e }, 'upload complete failed');
    return res.status(500).json({ ok: false, error: 'server-error' });
  }
});

// REST endpoint for cursor pagination of messages
app.get('/messages', async (req, res) => {
  const t0 = Date.now();
  const roomId = String(req.query.roomId || '').trim();
  if (!roomId) { httpMessages.inc({ code: '400' }); httpMessagesLatency.observe(Date.now()-t0); return res.status(400).json({ ok: false, error: 'roomId-required' }); }
  // Authn + membership gate
  try {
    const cookies = Object.fromEntries((req.headers.cookie||'').split(';').map(p=>{const i=p.indexOf('=');return [p.slice(0,i).trim(), decodeURIComponent(p.slice(i+1).trim())];}));
    const token = cookies.sid;
    const user = token ? verifyJwt(token) : null;
    if (!user) { httpMessages.inc({ code: '401' }); httpMessagesLatency.observe(Date.now()-t0); return res.status(401).json({ ok: false, error: 'unauthorized' }); }
    const member = await prisma.roomMember.findFirst({ where: { roomId, userId: user.id }, select: { id: true } });
    if (!member) { httpMessages.inc({ code: '403' }); httpMessagesLatency.observe(Date.now()-t0); return res.status(403).json({ ok: false, error: 'forbidden' }); }
  } catch {
    httpMessages.inc({ code: '401' }); httpMessagesLatency.observe(Date.now()-t0); return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const beforeTs = req.query.beforeTs ? Number(req.query.beforeTs) : undefined;
  const limit = req.query.limit ? Number(req.query.limit) : 500;
  try {
    const messages = await listMessagesAsc({ roomId, limit, beforeTs });
    httpMessages.inc({ code: '200' }); httpMessagesLatency.observe(Date.now()-t0); return res.json({ ok: true, messages });
  } catch (e) {
    baseLogger.error({ err: e }, 'list messages failed');
    httpMessages.inc({ code: '500' }); httpMessagesLatency.observe(Date.now()-t0); return res.status(500).json({ ok: false, error: 'server-error' });
  }
});

// Socket.IO with payload size cap and CORS allow-list
const io = new Server(server, {
  maxHttpBufferSize: 1e5, // ~100KB
  cors: { origin: SOCKET_ALLOWED_ORIGINS },
});

// Redis pub/sub adapter for horizontal scaling
const pub = createRedis();
const sub = createRedis();
io.adapter(createAdapter(pub, sub));

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Prisma setup
const prisma = new PrismaClient();
// Ensure auxiliary tables for test logging exist
async function ensureTestTables() {
  try {
    const statements = [
      `CREATE TABLE IF NOT EXISTS "TestLog" (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        section TEXT NOT NULL,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        meta JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_testlog_run ON "TestLog"(run_id, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_testlog_level ON "TestLog"(level)`,
      `CREATE INDEX IF NOT EXISTS idx_testlog_section ON "TestLog"(section)`,
      `CREATE TABLE IF NOT EXISTS "TestRun" (
        id TEXT PRIMARY KEY,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ended_at TIMESTAMPTZ,
        meta JSONB DEFAULT '{}'::jsonb
      )`,
      `CREATE TABLE IF NOT EXISTS "TestMetric" (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        name TEXT NOT NULL,
        value DOUBLE PRECISION NOT NULL,
        unit TEXT,
        meta JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_testmetric_run ON "TestMetric"(run_id, created_at DESC)`,
    ];
    for (const sql of statements) {
      try { await prisma.$executeRawUnsafe(sql); } catch (e) { baseLogger.warn({ err:e, sql }, 'ensureTestTables statement failed'); }
    }
  } catch (e) {
    baseLogger.warn({ err: e }, 'ensureTestTables failed');
  }
}
// Seed default data if DB is empty (dev convenience)
async function seedDefaults() {
  try {
    const count = await prisma.user.count();
    if (count > 0) return;
    const aliceId = nanoid(12);
    const bobId = nanoid(12);
    await prisma.user.create({ data: { id: aliceId, username: 'alice', passwordHash: hashPassword('secret123') } });
    await prisma.user.create({ data: { id: bobId, username: 'bob', passwordHash: hashPassword('secret123') } });
    await prisma.room.upsert({ where: { id: 'lobby' }, create: { id: 'lobby' }, update: {} });
    await prisma.roomMember.create({ data: { id: nanoid(12), roomId: 'lobby', userId: aliceId } });
    await prisma.roomMember.create({ data: { id: nanoid(12), roomId: 'lobby', userId: bobId } });
    const welcomeTs = Date.now();
    try {
      await createMessage({ id: process.env.USE_ULID === 'true' ? generateUlid() : nanoid(10), roomId: 'lobby', userId: aliceId, name: 'alice', text: 'Welcome to General!', ts: welcomeTs });
    } catch {}
    baseLogger.info('Seeded default users (alice/bob) and lobby room');
  } catch (e) {
    baseLogger.warn({ err: e }, 'seedDefaults failed');
  }
}
// Background jobs: outbox and receipt cleanup
const cron = require('node-cron');
const RECEIPT_TTL_DAYS = Number(process.env.RECEIPT_TTL_DAYS || '14');
cron.schedule('*/1 * * * *', async () => {
  try {
    // Outbox lag metric
    const cnt = await prisma.messageOutbox.count({ where: { processedAt: null } });
    outboxLagGauge.set(cnt);
  } catch {}
});
cron.schedule('0 3 * * *', async () => {
  try {
    const cutoff = BigInt(Date.now() - RECEIPT_TTL_DAYS*24*60*60*1000);
    await prisma.readReceipt.deleteMany({ where: { ts: { lt: cutoff } } });
  } catch (e) { baseLogger.warn({ err:e }, 'receipt cleanup failed'); }
});

// Presence in Redis
function presenceKey(roomId) {
  return `presence:room:${roomId}`;
}

async function presenceAdd(roomId, socketId, payload) {
  await pub.hset(presenceKey(roomId), socketId, JSON.stringify({ ...payload, ts: Date.now() }));
}

async function presenceRemove(roomId, socketId) {
  await pub.hdel(presenceKey(roomId), socketId);
}

async function presenceList(roomId) {
  const all = await pub.hgetall(presenceKey(roomId));
  return Object.values(all).map((v) => {
    try { return JSON.parse(v); } catch { return null; }
  }).filter(Boolean);
}

async function presencePrune(roomId, maxAgeMs = 5 * 60 * 1000) {
  const now = Date.now();
  const all = await pub.hgetall(presenceKey(roomId));
  const toDelete = [];
  for (const [sid, json] of Object.entries(all)) {
    try {
      const obj = JSON.parse(json);
      if (!obj.ts || now - obj.ts > maxAgeMs) toDelete.push(sid);
    } catch {
      toDelete.push(sid);
    }
  }
  if (toDelete.length) await pub.hdel(presenceKey(roomId), ...toDelete);
}

// DB helpers (Prisma)
async function createRoomIfNotExists(roomId) {
  await prisma.room.upsert({ where: { id: roomId }, create: { id: roomId }, update: {} });
}

async function roomExists(roomId) {
  const r = await prisma.room.findUnique({ where: { id: roomId }, select: { id: true } });
  return !!r;
}

async function createMessage({ id, roomId, userId, name, text, ts, attachmentId }) {
  await prisma.message.create({ data: { id, roomId, userId, name, text, ts: BigInt(ts), createdAt: new Date(ts), editCount: 0, meta: {}, attachmentId: attachmentId || null } });
}

async function listMessagesAsc({ roomId, limit, beforeTs }) {
  // Cursor-based: fetch <=limit messages before ts, then sort ASC for UI
  const where = beforeTs ? { roomId, ts: { lt: BigInt(beforeTs) } } : { roomId };
  const rows = await prisma.message.findMany({
    where,
    orderBy: [{ ts: 'desc' }],
    take: Math.min(Math.max(Number(limit) || 500, 1), 500),
    select: { id: true, userId: true, name: true, text: true, ts: true, meta: true, attachment: { select: { id: true, keyOriginal: true, keyCompressed: true, mime: true, bytesOriginal: true, bytesCompressed: true } } },
  });
  const asc = rows.reverse();
  const out = await Promise.all(asc.map(async (m) => {
    let attachment = null;
    if (m.attachment) {
      const key = m.attachment.keyCompressed || m.attachment.keyOriginal;
      const url = await getSignedGetUrl(key);
      const bytes = m.attachment.bytesCompressed || m.attachment.bytesOriginal || null;
      attachment = { id: m.attachment.id, mime: m.attachment.mime, bytes, url };
    }
    return { id: m.id, userId: m.userId, name: m.name, text: m.text, ts: Number(m.ts), meta: m.meta || {}, attachment };
  }));
  return out;
}

async function findUserByUsername(username) {
  return prisma.user.findUnique({ where: { username }, select: { id: true, username: true, passwordHash: true } });
}

async function insertUserRecord({ id, username, passwordHash, createdAt }) {
  await prisma.user.create({ data: { id, username, passwordHash, createdAt: new Date(createdAt) } });
}

// Validation schemas
const RoomId = z.string().trim().min(1).max(64).regex(/^[\w\-:.]+$/);
const Name = z.string().trim().min(1).max(64);
const Text = z.string().trim().min(1).max(2000);
const CreateRoomSchema = z.object({ roomId: RoomId });
const JoinSchema = z.object({ roomId: RoomId, name: Name.optional() });
const MessageSchema = z.object({ text: Text.optional(), attachmentId: z.string().optional() })
  .refine((v) => (v.text && v.text.trim().length > 0) || v.attachmentId, { message: 'text-or-attachment-required' });

const AllowedMime = new Set(['image/jpeg','image/png','image/webp','image/gif','video/mp4']);
const MAX_BYTES = 50 * 1024 * 1024;
const Credentials = z.object({ username: z.string().trim().min(3).max(64), password: z.string().min(6).max(200) });

// Redis-backed token-bucket (per socket)
const RATE_LIMIT = { burst: 10, perSec: 5 };
async function okRate(socketId) {
  const key = `ratelimit:${socketId}`;
  const ttl = 1; // seconds window for perSec refill approximation
  const cnt = await pub.incr(key);
  if (cnt === 1) await pub.expire(key, ttl);
  // Allow up to burst within ttl window; additionally cap rate perSec
  if (cnt > Math.max(RATE_LIMIT.perSec, RATE_LIMIT.burst)) return false;
  return true;
}

// Socket auth guard
io.use((socket, next) => {
  const tokenFromAuth = socket.handshake?.auth?.token;
  let tokenFromCookie = null;
  const cookieHeader = socket.handshake?.headers?.cookie || socket.request?.headers?.cookie;
  if (cookieHeader) {
    try {
      const cookies = Object.fromEntries(cookieHeader.split(';').map((c) => {
        const idx = c.indexOf('=');
        if (idx === -1) return [c.trim(), ''];
        const k = c.slice(0, idx).trim();
        const v = decodeURIComponent(c.slice(idx + 1).trim());
        return [k, v];
      }));
      tokenFromCookie = cookies.sid;
    } catch {}
  }
  const token = tokenFromAuth || tokenFromCookie;
  try {
    if (!token) return next(new Error('unauthorized'));
    socket.user = verifyJwt(token);
    return next();
  } catch (e) {
    return next(new Error('unauthorized'));
  }
});

async function ensureFirstMember(roomId, userId) {
  const count = await prisma.roomMember.count({ where: { roomId } });
  if (count === 0) {
    await prisma.roomMember.create({ data: { id: nanoid(12), roomId, userId } });
    return true;
  }
  return false;
}

async function isRoomMember(roomId, userId) {
  const m = await prisma.roomMember.findFirst({ where: { roomId, userId }, select: { id: true } });
  return !!m;
}

io.on('connection', (socket) => {
  wsConnects.inc();
  let currentRoomId = null;
  const authedUserId = socket.user?.id;
  const authedName = socket.user?.name;
  const sessionId = socket.id;
  track({ type:'user_connected', ts: Date.now(), userId: authedUserId||'anon', sessionId, platform: 'web' });

  // Create lobby explicitly
  socket.on('create-room', async (payload) => {
    const parsed = CreateRoomSchema.safeParse(payload || {});
    if (!parsed.success) {
      return socket.emit('create-room-result', { ok: false, error: 'Invalid roomId' });
    }
    const roomId = parsed.data.roomId;
    const exists = await roomExists(roomId);
    if (exists) return socket.emit('create-room-result', { ok: false, error: 'Room already exists' });
    await createRoomIfNotExists(roomId);
    // creator becomes first member
    if (socket.user?.id) {
      try { await prisma.roomMember.create({ data: { id: nanoid(12), roomId, userId: socket.user.id } }); } catch {}
    }
    socket.emit('create-room-result', { ok: true, roomId });
  });

  // Join room (auto-create if missing; auto-allow 'lobby')
  socket.on('join', async (payload) => {
    const t0 = Date.now();
    if (!socket.user) {
      return socket.emit('join-result', { ok: false, error: 'auth-required' });
    }
    const result = JoinSchema.safeParse(payload || {});
    if (!result.success) {
      return socket.emit('join-result', { ok: false, error: 'Invalid join payload' });
    }
    const roomId = result.data.roomId;
    const displayName = (result.data.name && String(result.data.name).trim()) || authedName || 'You';
    // Ensure room exists. Previously required pre-create; revert to auto-create behavior for smoother UX
    await createRoomIfNotExists(roomId);
    // Membership gate: if no members yet, first joiner becomes a member; else require membership
    const becameFirst = await ensureFirstMember(roomId, authedUserId);
    if (!becameFirst) {
      let allowed = await isRoomMember(roomId, authedUserId);
      if (!allowed) {
        // Public lobby convenience: auto-add joiner if room is 'lobby'
        if (roomId === 'lobby') {
          try {
            await prisma.roomMember.upsert({
              where: { roomId_userId: { roomId, userId: authedUserId } },
              create: { id: nanoid(12), roomId, userId: authedUserId },
              update: {},
            });
            allowed = true;
          } catch {}
        }
      }
      if (!allowed) return socket.emit('join-result', { ok: false, error: 'not-member' });
    }
    currentRoomId = roomId;
    await presenceAdd(roomId, socket.id, { id: authedUserId, name: displayName });
    socket.join(roomId);
    const members = (await presenceList(roomId)).length;
    // Fetch caller read state to help client jump to first unread
    let myReadState = null;
    try {
      const rs = await prisma.roomReadState.findUnique({ where: { roomId_userId: { roomId, userId: authedUserId } } });
      if (rs) myReadState = { lastReadTs: Number(rs.lastReadTs), lastReadMessageId: rs.lastReadMessageId || null };
    } catch {}
    track({ type:'room_joined', ts: Date.now(), userId: authedUserId||'anon', roomId, members });

    // Send current state to the new user (only after success)
    const messages = await listMessagesAsc({ roomId, limit: 500 });
    const users = await presenceList(roomId);
    socket.emit('join-result', {
      ok: true,
      roomId,
      userId: authedUserId,
      users,
      messages,
      readState: myReadState,
    });
    wsJoinLatency.observe(Date.now() - t0);

    // Notify others
    socket.to(roomId).emit('user-joined', { id: authedUserId, name: displayName });
  });

  socket.on('message', async (payload) => {
    if (!(await okRate(socket.id))) { wsThrottled.inc(); track({ type:'throttle_hit', ts: Date.now(), userId: authedUserId||'anon', sessionId, rule_id:'socket_rate_message' }); return; } // throttle
    if (!currentRoomId) return;
    // Double-check membership before accepting message
    const allowed = await isRoomMember(currentRoomId, authedUserId);
    if (!allowed) return;
    // Back-compat: client may send string
    const msgObj = typeof payload === 'string' ? { text: payload } : (payload || {});
    const parsed = MessageSchema.safeParse(msgObj);
    if (!parsed.success) {
      baseLogger.warn({ err: parsed.error.flatten() }, 'Invalid message payload');
      return;
    }
    const tStart = Date.now();
    const serverTs = Date.now();
    const msg = {
      id: process.env.USE_ULID === 'true' ? generateUlid() : nanoid(10),
      userId: authedUserId,
      name: authedName || 'You',
      text: parsed.data.text || '',
      ts: serverTs,
    };
    let attachment = null;
    if (parsed.data.attachmentId) {
      const att = await prisma.attachment.findUnique({ where: { id: parsed.data.attachmentId } });
      if (att && att.roomId === currentRoomId && att.userId === authedUserId) {
        await createMessage({ id: msg.id, roomId: currentRoomId, userId: msg.userId, name: msg.name, text: msg.text, ts: msg.ts, attachmentId: att.id });
        const key = att.keyCompressed || att.keyOriginal || att.key;
        const url = await getSignedGetUrl(key);
        const bytes = att.bytesCompressed || att.bytesOriginal || null;
        attachment = { id: att.id, mime: att.mime, bytes, url };
      } else {
        return; // invalid attachment
      }
    } else {
      await createMessage({ id: msg.id, roomId: currentRoomId, userId: msg.userId, name: msg.name, text: msg.text, ts: msg.ts });
    }
    const out = attachment ? { ...msg, attachment } : msg;
    // Include roomId to allow clients to filter correctly
    io.to(currentRoomId).emit('message', { roomId: currentRoomId, ...out, meta: {} });
    io.to(currentRoomId).emit('message:persisted', { roomId: currentRoomId, messageId: msg.id, ts: serverTs, userId: authedUserId });
    wsMessages.inc();
    wsMessageBytes.observe(Buffer.byteLength(msg.text || '', 'utf8'));
    const bytesIn = Buffer.byteLength(JSON.stringify(out), 'utf8');
    const roomSockets = await io.in(currentRoomId).fetchSockets();
    const recipients = Math.max(0, roomSockets.length - 1);
    const serverProcMs = Date.now() - tStart;
    track({ type:'message_sent', ts: Date.now(), userId: authedUserId||'anon', roomId: currentRoomId, kind: attachment? (attachment.mime.startsWith('image/')?'image': attachment.mime.includes('gif')?'gif': 'audio') : 'text', bytes_in: bytesIn, recipients, server_proc_ms: serverProcMs });
    track({ type:'message_delivered', ts: Date.now(), roomId: currentRoomId, delivered_to: recipients, bytes_out: recipients * bytesIn });

    // Outbox enqueue
    try {
      await prisma.messageOutbox.create({ data: { id: process.env.USE_ULID === 'true' ? generateUlid() : nanoid(12), kind: 'message_sent', payload: { messageId: msg.id, roomId: currentRoomId, userId: authedUserId, ts: serverTs } } });
    } catch {}
  });

  // Real typing events (explicit channel)
  socket.on('typing:state', (isTyping) => {
    if (!currentRoomId) return;
    socket.to(currentRoomId).emit('typing:state', { userId: authedUserId, name: authedName, isTyping: !!isTyping });
  });

  // Reactions
  socket.on('message:react', async ({ messageId, emoji }) => {
    if (!currentRoomId || !emoji || !messageId) return;
    try {
      await prisma.reaction.create({ data: { id: `${messageId}:${authedUserId}:${emoji}`, messageId, userId: authedUserId, emoji } });
      io.to(currentRoomId).emit('message:react', { messageId, emoji, userId: authedUserId });
      // Update reaction_counts in Message.meta
      try {
        await prisma.$executeRawUnsafe(
          `UPDATE "Message" SET meta = jsonb_set(coalesce(meta,'{}'::jsonb), '{reaction_counts,${emoji}}', coalesce(((meta->'reaction_counts'->>'${emoji}')::int + 1)::text,'1')::jsonb, true) WHERE id=$1`,
          messageId
        );
      } catch {}
    } catch (e) {
      // likely duplicate; ignore
    }
  });

  // Edit message
  socket.on('message:edit', async ({ messageId, text }) => {
    if (!currentRoomId || !messageId || typeof text !== 'string') return;
    const existing = await prisma.message.findUnique({ where: { id: messageId } });
    if (!existing || existing.userId !== authedUserId) return;
    if (Date.now() - Number(existing.ts) > 5 * 60 * 1000) return;
    await prisma.message.update({ where: { id: messageId }, data: { text, edited: true } });
    io.to(currentRoomId).emit('message:edit', { messageId, text });
  });

  // Pins feature disabled for now

  // Read receipts
  socket.on('read:upto', async ({ roomId, messageId }) => {
    if (!roomId || !messageId) return;
    try {
      await prisma.readReceipt.create({ data: { id: `${roomId}:${authedUserId}:${messageId}`, roomId, userId: authedUserId, messageId, ts: BigInt(Date.now()) } });
      // Upsert read state (room-level)
      try {
        const last = await prisma.message.findUnique({ where: { id: messageId }, select: { ts: true } });
        if (last) {
          await prisma.roomReadState.upsert({
            where: { roomId_userId: { roomId, userId: authedUserId } },
            update: { lastReadTs: last.ts, lastReadMessageId: messageId, updatedAt: new Date() },
            create: { roomId, userId: authedUserId, lastReadTs: last.ts, lastReadMessageId: messageId },
          });
        }
      } catch {}
      io.to(roomId).emit('read:upto', { roomId, userId: authedUserId, messageId });
    } catch {}
  });

  // Delivery acknowledgements
  socket.on('message:ack', async ({ messageId }) => {
    if (!currentRoomId || !messageId) return;
    try {
      // Atomically add user to delivered_by set in Message.meta
      await prisma.$executeRawUnsafe(
        `UPDATE "Message" SET meta = coalesce(meta,'{}'::jsonb) || jsonb_build_object('delivered_by', (
            SELECT jsonb_agg(DISTINCT x) FROM (
              SELECT jsonb_array_elements_text(coalesce(meta->'delivered_by','[]'::jsonb)) AS x
              UNION SELECT $2::text
            ) s
        )) WHERE id=$1`,
        messageId, authedUserId
      );
      // Read back counts for broadcast
      const row = await prisma.message.findUnique({ where: { id: messageId }, select: { meta: true } });
      const deliveredBy = Array.isArray(row?.meta?.delivered_by) ? row.meta.delivered_by : [];
      io.to(currentRoomId).emit('message:delivered', { roomId: currentRoomId, messageId, deliveredCount: deliveredBy.length });
    } catch {}
  });

  // Test echo for RTT measurements
  socket.on('test:echo', (payload) => {
    try {
      socket.emit('test:echo:reply', { t0: Number(payload?.t0)||Date.now(), t1: Date.now() });
    } catch {}
  });

  socket.on('typing', async (isTyping) => {
    if (!(await okRate(socket.id))) { wsThrottled.inc(); track({ type:'throttle_hit', ts: Date.now(), userId: authedUserId||'anon', sessionId, rule_id:'socket_rate_typing' }); return; } // throttle
    if (!currentRoomId) return;
    socket.to(currentRoomId).emit('typing', { userId: authedUserId, name: authedName, isTyping: !!isTyping });
  });

  socket.on('disconnect', async () => {
    if (!currentRoomId) return;
    await presenceRemove(currentRoomId, socket.id);
    socket.to(currentRoomId).emit('user-left', { id: authedUserId, name: authedName });
    track({ type:'user_disconnected', ts: Date.now(), userId: authedUserId||'anon', sessionId, duration_ms: 0 });
  });
});

// Bootstrap: ensure auxiliary tables and seed defaults BEFORE accepting traffic
(async () => {
  try {
    await ensureTestTables();
    await seedDefaults();
  } catch (e) {
    baseLogger.warn({ err: e }, 'bootstrap init failed');
  }
  server.listen(PORT, () => {
    baseLogger.info({ port: PORT }, `Server listening on http://localhost:${PORT}`);
  });
})();

// Graceful shutdown
async function shutdown() {
  try {
    baseLogger.info('Shutting down...');
    await new Promise((resolve) => server.close(resolve));
    try { io.close(); } catch {}
    try { await prisma.$disconnect(); } catch {}
    try { pub.disconnect(); sub.disconnect(); } catch {}
  } finally {
    process.exit(0);
  }
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Error handler (analytics + safe json)
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  try { track({ type:'error_occurred', ts: Date.now(), op: req.path || 'unknown', code: String(err.code||500) }); } catch {}
  baseLogger.error({ err }, 'Unhandled error');
  res.status(500).json({ ok:false, error:'server-error' });
});


