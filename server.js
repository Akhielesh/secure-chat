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
const { createPresignedPost, getSignedGetUrl, validateUploadRequest } = require('./media');
const promClient = require('prom-client');
const { track } = require('./analytics/emitter');
const { generateUlid } = require('./utils/ulids');
// S3 client for media proxy
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');

// Import origins configuration
const { parseOrigins, isOriginAllowed } = require('./config/origins.js');

// Import emoji utility for safe validation
const { isSafeEmoji } = require('./src/utils/emoji.js');
const R2_ENDPOINT = process.env.R2_ENDPOINT || 'https://example.r2.cloudflarestorage.com';
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || '';
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || '';
const R2_BUCKET = process.env.R2_BUCKET || '';
const s3 = new S3Client({ region:'auto', endpoint:R2_ENDPOINT, credentials:{ accessKeyId:R2_ACCESS_KEY_ID, secretAccessKey:R2_SECRET_ACCESS_KEY } });

// Load environment variables from .env if present
dotenv.config();

const app = express();
const server = http.createServer(app);

// Parse allowed origins from environment variables
const ALLOWED = parseOrigins(process.env.ALLOWED_ORIGINS, []);
const SOCKET_ALLOWED = parseOrigins(process.env.SOCKET_ALLOWED_ORIGINS, ALLOWED);

// Security middleware
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { RateLimiterMemory } = require('rate-limiter-flexible');

// Trust proxy for HTTPS redirects
app.enable('trust proxy');

// Enhanced security headers with comprehensive protection
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "img-src": ["'self'", "data:", process.env.R2_ENDPOINT || ""],
      "media-src": ["'self'", process.env.R2_ENDPOINT || ""],
      "connect-src": ["'self'", ...ALLOWED, ...SOCKET_ALLOWED.map(o => o.replace(/^https:/, 'wss:'))],
      "script-src": ["'self'"],
      "style-src": ["'self'", "'unsafe-inline'"],
      "frame-ancestors": ["'none'"], // Prevent clickjacking
      "base-uri": ["'self'"], // Restrict base URI
      "form-action": ["'self'"], // Restrict form submissions
      "upgrade-insecure-requests": [] // Force HTTPS
    }
  },
  hsts: { 
    maxAge: 31536000, // 1 year
    includeSubDomains: true, 
    preload: true 
  },
  referrerPolicy: { policy: "no-referrer" },
  xssFilter: true, // Enable XSS protection
  noSniff: true, // Prevent MIME type sniffing
  frameguard: { action: 'deny' }, // Prevent clickjacking
  hidePoweredBy: true, // Hide X-Powered-By header
  ieNoOpen: true, // Prevent IE from executing downloads
  permittedCrossDomainPolicies: { permittedPolicies: "none" } // Block cross-domain policies
}));

// Force HTTPS (behind proxy)
app.use((req, res, next) => {
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') return next();
  if (process.env.NODE_ENV === 'production') return res.redirect(301, `https://${req.headers.host}${req.url}`);
  next();
});
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    next();
  });
}

// Rate limiting for security
const globalLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120, // 120 requests per minute per IP
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Stricter rate limiting for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 auth attempts per 15 minutes per IP
  message: 'Too many authentication attempts, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Socket.IO rate limiting
const socketRateLimiter = new RateLimiterMemory({
  points: 20, // 20 events
  duration: 10, // per 10 seconds
});

app.use(globalLimiter);

// Environment configuration
const PORT = Number(process.env.PORT) || 3000;



// CORS configuration with origin validation
const cors = require('cors');
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (isOriginAllowed(origin, ALLOWED)) return cb(null, true);
    cb(new Error("CORS blocked"));
  },
  credentials: true
}));

// Structured logger (pino) with request IDs
const baseLogger = pino({ level: process.env.LOG_LEVEL || 'info' });
const httpLogger = pinoHttp({
  logger: baseLogger,
  genReqId: () => nanoid(12),
});
app.use(httpLogger);

// Body & cookie parsing
app.use(express.json({ limit: '200kb' }));
app.use(cookieParser());

// HTTP rate limit
app.use(rateLimit({ windowMs: 60_000, max: 120 })); // 120 req/min/IP

// Socket.IO rate limiters for hot events
const rlByIp = new RateLimiterMemory({ points: 20, duration: 10 });
const rlByUser = new RateLimiterMemory({ points: 30, duration: 10 });

// Development-only middleware
function requireDev(req, res, next) {
  if (process.env.NODE_ENV === 'production') return res.status(404).end();
  next();
}

// Health endpoint
app.get("/health", (req,res)=>res.status(200).json({ ok:true }));

// Message pagination endpoint
app.get("/api/rooms/:id/messages", async (req, res, next) => {
  try {
    const roomId = req.params.id;
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 100);
    const before = req.query.before ? new Date(Number(req.query.before)) : new Date();

    // Check if user is authenticated
    const cookieHeader = req.headers.cookie || '';
    const cookies = Object.fromEntries(cookieHeader.split(';').map(p => { 
      const i = p.indexOf('='); 
      return [p.slice(0, i).trim(), decodeURIComponent(p.slice(i + 1).trim())]; 
    }));
    const token = cookies.sid;
    if (!token) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const user = verifyJwt(token);
    if (!user) {
      return res.status(401).json({ ok: false, error: 'invalid-token' });
    }

    // Check if user is member of the room
    const isMember = await isRoomMember(roomId, user.id);
    if (!isMember) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }

    // Fetch messages with pagination
    const messages = await listMessagesAsc({ 
      roomId, 
      limit, 
      beforeTs: before.getTime() 
    });

    res.json({ 
      ok: true, 
      messages, 
      hasMore: messages.length === limit,
      nextCursor: messages.length > 0 ? messages[messages.length - 1].ts : null
    });
  } catch (e) {
    baseLogger.error({ err: e }, 'Message pagination failed');
    res.status(500).json({ ok: false, error: 'server-error' });
  }
});

// Attachment URL signing endpoint (on-demand)
app.get("/api/attachments/:id/sign", async (req, res, next) => {
  try {
    const attachmentId = req.params.id;
    
    // Check if user is authenticated
    const cookieHeader = req.headers.cookie || '';
    const cookies = Object.fromEntries(cookieHeader.split(';').map(p => { 
      const i = p.indexOf('='); 
      return [p.slice(0, i).trim(), decodeURIComponent(p.slice(i + 1).trim())]; 
    }));
    const token = cookies.sid;
    if (!token) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const user = verifyJwt(token);
    if (!user) {
      return res.status(401).json({ ok: false, error: 'invalid-token' });
    }

    // Get attachment details
    const attachment = await prisma.attachment.findUnique({
      where: { id: attachmentId },
      select: { id: true, roomId: true, userId: true, keyOriginal: true, keyCompressed: true, mime: true }
    });

    if (!attachment) {
      return res.status(404).json({ ok: false, error: 'attachment-not-found' });
    }

    // Check if user is member of the room
    const isMember = await isRoomMember(attachment.roomId, user.id);
    if (!isMember) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }

    // Sign the URL for the requested key (prefer compressed if available)
    const key = attachment.keyCompressed || attachment.keyOriginal;
    const signedUrl = await getSignedGetUrl(key);

    res.json({ 
      ok: true, 
      url: signedUrl,
      mime: attachment.mime,
      key: key
    });
  } catch (e) {
    baseLogger.error({ err: e }, 'Attachment signing failed');
    res.status(500).json({ ok: false, error: 'server-error' });
  }
});
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
app.post('/api/testlog', requireDev, async (req, res) => {
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
app.get('/api/testlog', requireDev, async (req, res) => {
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
app.post('/api/testrun', requireDev, async (req, res) => {
  try {
    const id = String(req.body?.runId || '') || nanoid(16);
    const meta = req.body?.meta || {};
    await prisma.$executeRawUnsafe(`INSERT INTO "TestRun" (id, meta) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET meta=$2`, id, JSON.stringify(meta));
    return res.json({ ok:true, runId: id });
  } catch (e) { baseLogger.error({ err:e }, 'testrun failed'); return res.status(500).json({ ok:false }); }
});

// Test helpers (dev utility): issue tokens, rooms, memberships
app.post('/api/test/issue-token', requireDev, async (req, res) => {
  try {
    const { username, password = 'secret123' } = req.body || {};
    if (!username || typeof username !== 'string' || username.trim().length < 3) {
      return res.status(400).json({ ok: false, error: 'Username must be at least 3 characters' });
    }
    
    let user = await prisma.user.findUnique({ where: { username: username.trim() } });
    if (!user) {
      user = await prisma.user.create({ 
        data: { 
          id: nanoid(12), 
          username: username.trim(), 
          passwordHash: hashPassword(password),
          createdAt: new Date(),
          updatedAt: new Date()
        } 
      });
      baseLogger.info({ userId: user.id, username: user.username }, 'Test user created');
    }
    
    const token = signJwt({ id: user.id, name: user.username });
    return res.json({ ok: true, token, userId: user.id, username: user.username });
  } catch (e) { 
    baseLogger.error({ err: e }, 'issue-token failed'); 
    return res.status(500).json({ ok: false, error: 'Server error' }); 
  }
});
app.post('/api/test/room', requireDev, async (req, res) => {
  try { 
    const { roomId, name } = req.body || {}; 
    if (!roomId) return res.status(400).json({ ok: false, error: 'Room ID required' }); 
    
    const room = await prisma.room.upsert({ 
      where: { id: String(roomId) }, 
      create: { 
        id: String(roomId),
        name: name || `Test Room ${roomId}`,
        createdAt: new Date(),
        updatedAt: new Date()
      }, 
      update: {
        name: name || undefined,
        updatedAt: new Date()
      }
    }); 
    
    baseLogger.info({ roomId: room.id, name: room.name }, 'Test room created/updated');
    return res.json({ ok: true, room: { id: room.id, name: room.name } }); 
  } catch (e) { 
    baseLogger.error({ err: e }, 'test room failed'); 
    return res.status(500).json({ ok: false, error: 'Server error' }); 
  }
});

// Lazy signing endpoint for full-size image attachments
app.post('/api/attachment/sign', async (req, res) => {
  try {
    const { key } = req.body || {};
    if (!key || typeof key !== 'string') {
      return res.status(400).json({ ok: false, error: 'Attachment key required' });
    }
    
    // Validate the key format (basic security check)
    if (!/^[\w\-/]+$/.test(key)) {
      return res.status(400).json({ ok: false, error: 'Invalid attachment key format' });
    }
    
    const signedUrl = await getSignedGetUrl(key);
    return res.json({ ok: true, url: signedUrl });
  } catch (e) {
    baseLogger.error({ err: e, key: req.body?.key }, 'Attachment signing failed');
    return res.status(500).json({ ok: false, error: 'Failed to sign attachment URL' });
  }
});
app.post('/api/test/add-member', requireDev, async (req, res) => {
  try {
    const { roomId, username, role = 'MEMBER' } = req.body || {};
    if (!roomId || !username) {
      return res.status(400).json({ ok: false, error: 'Room ID and username required' });
    }
    
    const user = await prisma.user.findUnique({ where: { username: String(username) } });
    if (!user) return res.status(404).json({ ok: false, error: 'User not found' });
    
    const room = await prisma.room.findUnique({ where: { id: String(roomId) } });
    if (!room) return res.status(404).json({ ok: false, error: 'Room not found' });
    
    const member = await prisma.roomMember.upsert({
      where: { roomId_userId: { roomId: String(roomId), userId: user.id } },
      create: { 
        id: nanoid(12), 
        roomId: String(roomId), 
        userId: user.id,
        role: role,
        joinedAt: new Date()
      },
      update: { role: role },
    });
    
    baseLogger.info({ roomId, userId: user.id, username, role }, 'Test member added');
    return res.json({ ok: true, member: { userId: user.id, username, role } });
  } catch (e) { 
    baseLogger.error({ err: e }, 'add-member failed'); 
    return res.status(500).json({ ok: false, error: 'Server error' }); 
  }
});
// Additional test endpoints
app.get('/api/test/users', requireDev, async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      select: { id: true, username: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 50
    });
    return res.json({ ok: true, users });
  } catch (e) {
    baseLogger.error({ err: e }, 'test users failed');
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

app.get('/api/test/rooms', requireDev, async (req, res) => {
  try {
    const rooms = await prisma.room.findMany({
      select: { id: true, name: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 50
    });
    return res.json({ ok: true, rooms });
  } catch (e) {
    baseLogger.error({ err: e }, 'test rooms failed');
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

app.delete('/api/test/cleanup', requireDev, async (req, res) => {
  try {
    const { type = 'all' } = req.body || {};
    
    if (type === 'all' || type === 'messages') {
      await prisma.message.deleteMany({
        where: { body: { contains: 'test' } }
      });
    }
    
    if (type === 'all' || type === 'users') {
      await prisma.user.deleteMany({
        where: { username: { startsWith: 'test' } }
      });
    }
    
    if (type === 'all' || type === 'rooms') {
      await prisma.room.deleteMany({
        where: { name: { contains: 'Test' } }
      });
    }
    
    baseLogger.info({ type }, 'Test cleanup completed');
    return res.json({ ok: true, message: `Cleaned up ${type} test data` });
  } catch (e) {
    baseLogger.error({ err: e }, 'test cleanup failed');
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

app.post('/api/testmetric', requireDev, async (req, res) => {
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
app.post('/jobs/compress', requireDev, async (req, res) => {
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
app.post('/api/register', authLimiter, (req, res) => {
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

app.post('/api/login', authLimiter, (req, res) => {
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

// Upload init: returns presigned POST with enhanced validation
app.post('/api/upload/init', async (req, res) => {
  try {
    const { roomId, mime, bytes } = req.body || {};
    
    // Authentication check
    if (!req.headers.cookie) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const cookies = Object.fromEntries((req.headers.cookie||'').split(';').map(p=>{const i=p.indexOf('=');return [p.slice(0,i).trim(), decodeURIComponent(p.slice(i+1).trim())];}));
    const token = cookies.sid;
    const user = token ? verifyJwt(token) : null;
    if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });
    
    // Enhanced validation using the new validation function
    const validation = validateUploadRequest({ 
      mimeType: mime, 
      bytes: Number(bytes), 
      userId: user.id, 
      roomId, 
      maxBytes: MAX_BYTES 
    });
    
    if (!validation.isValid) {
      return res.status(400).json({ 
        ok: false, 
        error: 'validation-failed', 
        details: validation.errors 
      });
    }
    
    // Additional room membership check
    const member = await prisma.roomMember.findFirst({ 
      where: { roomId, userId: user.id }, 
      select: { id: true } 
    });
    if (!member) return res.status(403).json({ ok: false, error: 'not-room-member' });
    
    const key = `${roomId}/${user.id}/${nanoid(16)}`;
    const { url, fields } = await createPresignedPost({ 
      key, 
      contentType: mime, 
      maxBytes: MAX_BYTES,
      userId: user.id,
      roomId
    });
    
    track({ type: 'upload_initiated', ts: Date.now(), userId: user.id, roomId, mime, bytes: Number(bytes) });
    return res.json({ ok: true, url, fields, key });
  } catch (e) {
    baseLogger.error({ err: e }, 'upload init failed');
    return res.status(500).json({ ok: false, error: 'server-error' });
  }
});

// Upload complete: record attachment with enhanced validation
app.post('/api/upload/complete', async (req, res) => {
  try {
    const { roomId, key, mime, bytes, sha256, keyCompressed, bytesCompressed, compression } = req.body || {};
    
    // Authentication check
    if (!req.headers.cookie) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const cookies = Object.fromEntries((req.headers.cookie||'').split(';').map(p=>{const i=p.indexOf('=');return [p.slice(0,i).trim(), decodeURIComponent(p.slice(i+1).trim())];}));
    const token = cookies.sid;
    const user = token ? verifyJwt(token) : null;
    if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });
    
    // Enhanced validation using the new validation function
    const validation = validateUploadRequest({ 
      mimeType: mime, 
      bytes: Number(bytes), 
      userId: user.id, 
      roomId, 
      maxBytes: MAX_BYTES 
    });
    
    if (!validation.isValid) {
      return res.status(400).json({ 
        ok: false, 
        error: 'validation-failed', 
        details: validation.errors 
      });
    }
    
    // Enhanced security: Validate key format and ownership
    if (!key || typeof key !== 'string') return res.status(400).json({ ok: false, error: 'invalid-key' });
    if (!key.startsWith(`${roomId}/${user.id}/`)) return res.status(400).json({ ok: false, error: 'key-ownership-mismatch' });
    
    // Additional room membership check
    const member = await prisma.roomMember.findFirst({ 
      where: { roomId, userId: user.id }, 
      select: { id: true } 
    });
    if (!member) return res.status(403).json({ ok: false, error: 'not-room-member' });
    
    const nbytes = Number(bytes);
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

// Upload validation endpoint for client-side pre-validation
app.post('/api/upload/validate', async (req, res) => {
  try {
    const { roomId, mime, bytes } = req.body || {};
    
    // Authentication check
    if (!req.headers.cookie) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const cookies = Object.fromEntries((req.headers.cookie||'').split(';').map(p=>{const i=p.indexOf('=');return [p.slice(0,i).trim(), decodeURIComponent(p.slice(i+1).trim())];}));
    const token = cookies.sid;
    const user = token ? verifyJwt(token) : null;
    if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });
    
    // Enhanced validation using the new validation function
    const validation = validateUploadRequest({ 
      mimeType: mime, 
      bytes: Number(bytes), 
      userId: user.id, 
      roomId, 
      maxBytes: MAX_BYTES 
    });
    
    if (!validation.isValid) {
      return res.status(400).json({ 
        ok: false, 
        error: 'validation-failed', 
        details: validation.errors 
      });
    }
    
    // Room membership check
    const member = await prisma.roomMember.findFirst({ 
      where: { roomId, userId: user.id }, 
      select: { id: true } 
    });
    if (!member) return res.status(403).json({ ok: false, error: 'not-room-member' });
    
    return res.json({ 
      ok: true, 
      message: 'Upload validation passed',
      maxSize: MAX_BYTES,
      allowedTypes: Array.from(AllowedMime)
    });
  } catch (e) {
    baseLogger.error({ err: e }, 'upload validation failed');
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

// API endpoint to ensure room membership for DMs and groups
app.post('/api/room/ensure-membership', async (req, res) => {
  try {
    const cookies = Object.fromEntries((req.headers.cookie||'').split(';').map(p=>{const i=p.indexOf('=');return [p.slice(0,i).trim(), decodeURIComponent(p.slice(i+1).trim())];}));
    const token = cookies.sid;
    const user = token ? verifyJwt(token) : null;
    if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });
    
    const { roomId, usernames } = req.body || {};
    if (!roomId || !Array.isArray(usernames)) {
      return res.status(400).json({ ok: false, error: 'roomId and usernames array required' });
    }
    
    // Ensure room exists
    await createRoomIfNotExists(roomId);
    
    // Get user IDs from usernames
    const userIds = [user.id]; // Always include the requesting user
    for (const username of usernames) {
      const otherUser = await findUserByUsername(username);
      if (otherUser && !userIds.includes(otherUser.id)) {
        userIds.push(otherUser.id);
      }
    }
    
    // Ensure all users are members
    await ensureRoomMembership(roomId, userIds);
    
    res.json({ ok: true, roomId, memberCount: userIds.length });
  } catch (e) {
    baseLogger.error({ err: e }, 'ensure room membership failed');
    res.status(500).json({ ok: false, error: 'server-error' });
  }
});

// Socket.IO with comprehensive configuration
const io = new Server(server, {
  pingInterval: 20000,
  pingTimeout: 30000,
  maxHttpBufferSize: 1e5, // ~100KB
  cors: { origin: ALLOWED, credentials: true }
});

// Socket auth (JWT via auth.token or cookie `sid`)
io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token
      || (socket.handshake.headers.cookie?.match(/(?:^|;\s*)sid=([^;]+)/)?.[1]);
    if (!token) throw new Error("no token");
    const payload = verifyJwt(token);
    socket.user = { id: payload.sub, roles: payload.roles || [] };
    return next();
  } catch (e) {
    return next(new Error("unauthorized"));
  }
});

// Redis pub/sub adapter for horizontal scaling
const pub = createRedis();
const sub = createRedis();
io.adapter(createAdapter(pub, sub));

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Prisma setup with production optimizations
const prisma = new PrismaClient({
  datasources: {
    db: {
      url: process.env.DATABASE_URL,
    },
  },
  // Production optimizations for free-tier databases
  ...(process.env.NODE_ENV === 'production' && {
    log: ['error', 'warn'],
    errorFormat: 'minimal',
  }),
});
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

// Presence in Redis with heartbeat and pruning
function presenceKey(roomId) {
  return `presence:room:${roomId}`;
}

function presenceUserKey(userId) {
  return `presence:user:${userId}`;
}

async function presenceAdd(roomId, socketId, payload) {
  const now = Date.now();
  const presenceData = { ...payload, ts: now, lastHeartbeat: now };
  
  // Add to room presence with TTL for automatic cleanup
  await pub.hset(presenceKey(roomId), socketId, JSON.stringify(presenceData));
  await pub.expire(presenceKey(roomId), 120); // 2 minutes TTL for room presence
  
  // Track user's active socket for cleanup with TTL
  if (payload.id) {
    await pub.hset(presenceUserKey(payload.id), socketId, JSON.stringify({ roomId, ts: now }));
    await pub.expire(presenceUserKey(payload.id), 180); // 3 minutes TTL for user presence
  }
}

async function presenceRemove(roomId, socketId) {
  await pub.hdel(presenceKey(roomId), socketId);
}

async function presenceHeartbeat(roomId, socketId) {
  try {
    const existing = await pub.hget(presenceKey(roomId), socketId);
    if (existing) {
      const data = JSON.parse(existing);
      data.lastHeartbeat = Date.now();
      await pub.hset(presenceKey(roomId), socketId, JSON.stringify(data));
      
      // Refresh TTL on heartbeat to keep active users online
      await pub.expire(presenceKey(roomId), 120); // 2 minutes TTL
    }
  } catch (e) {
    baseLogger.warn({ err: e, roomId, socketId }, 'Failed to update presence heartbeat');
  }
}

async function presenceList(roomId) {
  // Prune stale presence before returning list
  await presencePrune(roomId);
  
  const all = await pub.hgetall(presenceKey(roomId));
  return Object.values(all).map((v) => {
    try { return JSON.parse(v); } catch { return null; }
  }).filter(Boolean);
}

async function presencePrune(roomId, maxAgeMs = 90_000) { // 90 seconds for more responsive cleanup
  const now = Date.now();
  const all = await pub.hgetall(presenceKey(roomId));
  const toDelete = [];
  
  for (const [sid, json] of Object.entries(all)) {
    try {
      const obj = JSON.parse(json);
      // Check both ts (join time) and lastHeartbeat (activity time)
      const lastActivity = Math.max(obj.ts || 0, obj.lastHeartbeat || 0);
      if (now - lastActivity > maxAgeMs) {
        toDelete.push(sid);
      }
    } catch {
      toDelete.push(sid);
    }
  }
  
  if (toDelete.length) {
    await pub.hdel(presenceKey(roomId), ...toDelete);
    baseLogger.info({ roomId, prunedCount: toDelete.length }, 'Pruned stale presence entries');
  }
}

// Global presence cleanup job
async function cleanupStalePresence() {
  try {
    // Get all room keys
    const roomKeys = await pub.keys('presence:room:*');
    for (const key of roomKeys) {
      const roomId = key.replace('presence:room:', '');
      await presencePrune(roomId);
    }
    
    // Clean up user presence tracking
    const userKeys = await pub.keys('presence:user:*');
    for (const key of userKeys) {
      const userId = key.replace('presence:user:', '');
      const userPresence = await pub.hgetall(key);
      const now = Date.now();
      const toDelete = [];
      
      for (const [socketId, json] of Object.entries(userPresence)) {
        try {
          const data = JSON.parse(json);
          if (now - data.ts > 3 * 60 * 1000) { // 3min for user presence (reduced from 5min)
            toDelete.push(socketId);
          }
        } catch {
          toDelete.push(socketId);
        }
      }
      
      if (toDelete.length) {
        await pub.hdel(key, ...toDelete);
      }
    }
  } catch (e) {
    baseLogger.error({ err: e }, 'Failed to cleanup stale presence');
  }
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
    take: Math.min(Math.max(Number(limit) || 50, 1), 100), // Reduced from 500 to 50 default, max 100
    select: { id: true, userId: true, name: true, text: true, ts: true, meta: true, attachment: { select: { id: true, keyOriginal: true, keyCompressed: true, mime: true, bytesOriginal: true, bytesCompressed: true } } },
  });
  const asc = rows.reverse();
  const out = await Promise.all(asc.map(async (m) => {
    let attachment = null;
    if (m.attachment) {
      // Lazy signing: only sign thumbnail URLs, defer full-size signing until needed
      const key = m.attachment.keyCompressed || m.attachment.keyOriginal;
      const isThumbnail = m.attachment.keyCompressed; // compressed = thumbnail
      
      // Only sign thumbnail URLs immediately for performance
      let url = null;
      if (isThumbnail) {
        url = await getSignedGetUrl(key);
      } else {
        // For full-size images, just provide the key - client will request signed URL when needed
        url = null; // Client will request signed URL via separate endpoint
      }
      
      const bytes = m.attachment.bytesCompressed || m.attachment.bytesOriginal || null;
      attachment = { 
        id: m.attachment.id, 
        mime: m.attachment.mime, 
        bytes, 
        url,
        key: isThumbnail ? null : key, // Provide key for full-size images
        needsSigning: !isThumbnail // Flag for client to request signed URL
      };
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

// Multi-layer rate limiting: per-socket, per-IP, and per-user
const RATE_LIMIT = { 
  socket: { burst: 10, perSec: 5 },
  ip: { burst: 50, perSec: 20 },
  user: { burst: 100, perSec: 30 }
};

async function okRate(socketId, ipAddress, userId) {
  const now = Date.now();
  const ttl = 1; // seconds window
  
  // Per-socket rate limiting (existing behavior)
  const socketKey = `ratelimit:socket:${socketId}`;
  const socketCnt = await pub.incr(socketKey);
  if (socketCnt === 1) await pub.expire(socketKey, ttl);
  if (socketCnt > Math.max(RATE_LIMIT.socket.perSec, RATE_LIMIT.socket.burst)) {
    return { allowed: false, reason: 'socket_rate_limit' };
  }
  
  // Per-IP rate limiting (persistent across reconnects)
  if (ipAddress) {
    const ipKey = `ratelimit:ip:${ipAddress}`;
    const ipCnt = await pub.incr(ipKey);
    if (ipCnt === 1) await pub.expire(ipKey, ttl);
    if (ipCnt > Math.max(RATE_LIMIT.ip.perSec, RATE_LIMIT.ip.burst)) {
      return { allowed: false, reason: 'ip_rate_limit' };
    }
  }
  
  // Per-user rate limiting (persistent across reconnects)
  if (userId) {
    const userKey = `ratelimit:user:${userId}`;
    const userCnt = await pub.incr(userKey);
    if (userCnt === 1) await pub.expire(userKey, ttl);
    if (userCnt > Math.max(RATE_LIMIT.user.perSec, RATE_LIMIT.user.burst)) {
      return { allowed: false, reason: 'user_rate_limit' };
    }
  }
  
  return { allowed: true };
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

async function ensureRoomMembership(roomId, userIds) {
  // Ensure multiple users are members of a room (for DMs and groups)
  for (const userId of userIds) {
    const isMember = await isRoomMember(roomId, userId);
    if (!isMember) {
      try {
        await prisma.roomMember.upsert({
          where: { roomId_userId: { roomId, userId } },
          create: { id: nanoid(12), roomId, userId },
          update: {},
        });
        baseLogger.info({ roomId, userId }, 'Auto-granted membership for multi-user room');
      } catch (e) {
        baseLogger.warn({ err: e, roomId, userId }, 'Failed to auto-grant membership');
      }
    }
  }
}

io.on('connection', (socket) => {
  wsConnects.inc();
  let currentRoomId = null;
  const authedUserId = socket.user?.id;
  const authedName = socket.user?.name;
  const sessionId = socket.id;
  track({ type:'user_connected', ts: Date.now(), userId: authedUserId||'anon', sessionId, platform: 'web' });

  // Presence heartbeat (every 30s from client)
  socket.on('presence:ping', async () => {
    if (currentRoomId && authedUserId) {
      await presenceHeartbeat(currentRoomId, socket.id, authedUserId);
    }
  });

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
    
    // Check if this is a DM or group room (numeric IDs from React client)
    const isNumericRoom = /^\d+$/.test(roomId);
    if (isNumericRoom) {
      // For numeric room IDs (DMs/groups from React client), auto-grant membership
      // This allows the React client's local conversations to work with the server
      const isMember = await isRoomMember(roomId, authedUserId);
      if (!isMember) {
        try {
          await prisma.roomMember.upsert({
            where: { roomId_userId: { roomId, userId: authedUserId } },
            create: { id: nanoid(12), roomId, userId: authedUserId },
            update: {},
          });
          baseLogger.info({ roomId, userId: authedUserId }, 'Auto-granted membership for numeric room (DM/group)');
        } catch (e) {
          baseLogger.warn({ err: e, roomId, userId: authedUserId }, 'Failed to auto-grant membership');
        }
      }
    } else {
      // For named rooms, use existing membership logic
      const becameFirst = await ensureFirstMember(roomId, authedUserId);
      if (!becameFirst) {
        let allowed = await isRoomMember(roomId, authedUserId);
        if (!allowed) {
          // Production: Disable auto-join for 'lobby' to prevent membership bypass
          // Users must be explicitly added to rooms or create them
          if (process.env.NODE_ENV === 'production' && roomId === 'lobby') {
            baseLogger.warn({ userId: authedUserId, roomId }, 'Production: lobby auto-join disabled for security');
            return socket.emit('join-result', { ok: false, error: 'lobby-auto-join-disabled-in-production' });
          }
          
          // Development: Allow lobby auto-join for testing convenience
          if (process.env.NODE_ENV !== 'production' && roomId === 'lobby') {
            try {
              await prisma.roomMember.upsert({
                where: { roomId_userId: { roomId, userId: authedUserId } },
                create: { id: nanoid(12), roomId, userId: authedUserId },
                update: {},
              });
              allowed = true;
              baseLogger.info({ userId: authedUserId, roomId }, 'Development: lobby auto-join granted');
            } catch (e) {
              baseLogger.warn({ err: e, userId: authedUserId, roomId }, 'Failed to auto-grant lobby membership');
            }
          }
        }
        if (!allowed) return socket.emit('join-result', { ok: false, error: 'not-member' });
      }
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

    // Send current state to the new user (only after success) - reduced from 500 to 50 messages for performance
    const messages = await listMessagesAsc({ roomId, limit: 50 });
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

  socket.on('message', async (payload, ack) => {
    // Per-IP and per-user rate limiting for hot events
    try {
      await rlByIp.consume(socket.handshake.address);
      await rlByUser.consume(authedUserId || 'anon');
    } catch {
      ack?.({ ok: false, error: "rate_limited" });
      return;
    }
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

    // Acknowledge successful message creation
    ack?.({ ok: true });
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
      // Update reaction_counts in Message.meta - safe parameterized query
      try {
        // Validate emoji to prevent SQL injection
        if (!isSafeEmoji(emoji)) {
          baseLogger.warn({ emoji, userId: authedUserId }, 'Invalid emoji rejected');
          return;
        }

        await prisma.$executeRaw`
          UPDATE "Message"
          SET meta = jsonb_set(
            COALESCE(meta, '{}'::jsonb),
            ARRAY['reaction_counts', ${emoji}],
            to_jsonb( COALESCE( (meta->'reaction_counts'->>${emoji})::int, 0) + 1 )
          )
          WHERE id = ${messageId}
        `;
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
    // Rate limiting for typing events
    try {
      await rlByIp.consume(socket.handshake.address);
      await rlByUser.consume(authedUserId || 'anon');
    } catch {
      return; // Silently drop typing events when rate limited
    }
    if (!currentRoomId) return;
    socket.to(currentRoomId).emit('typing', { userId: authedUserId, name: authedName, isTyping: !!isTyping });
  });

  // Heartbeat to keep presence fresh
  socket.on('heartbeat', async () => {
    if (currentRoomId) {
      await presenceHeartbeat(currentRoomId, socket.id);
    }
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
  
  // Start presence cleanup job (every 60 seconds for aggressive cleanup)
  setInterval(cleanupStalePresence, 60_000);
  baseLogger.info('Presence cleanup job started');
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

// Global error handler - never leak stack traces
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const errorId = require('crypto').randomUUID();
  try { 
    track({ 
      type: 'error_occurred', 
      ts: Date.now(), 
      op: req.path || 'unknown', 
      code: String(err.code || 500),
      errorId 
    }); 
  } catch {}
  
  baseLogger.error({ err, errorId, path: req.path, method: req.method }, 'Unhandled error');
  
  // Never leak stack traces in production
  const response = { 
    ok: false, 
    error: 'internal_error',
    id: errorId
  };
  
  if (process.env.NODE_ENV !== 'production') {
    response.details = err.message;
  }
  
  res.status(500).json(response);
});


