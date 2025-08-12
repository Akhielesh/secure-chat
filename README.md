# Secure Chat Platform

Secure, scalable real-time chat with rooms, auth, attachments, and metrics. Runs on Node.js/Express with Socket.IO and Prisma (Postgres), horizontally scalable via Redis.

## What it does
- Real-time chat rooms with presence and typing indicators
- User accounts with hashed passwords and JWT session cookies
- Horizontal scaling across instances using Redis adapter
- Persistent storage in Postgres (via Prisma)
- Attachments via S3-compatible storage (Cloudflare R2) with signed URLs
- Cursor-based pagination for message history
- Structured logs and Prometheus metrics

## Features
- Rooms: create/join, join/leave events, presence list
- Messages: text and media (images/GIFs/MP4), size/type validation, history pagination
- Security: JWT auth, rate limiting (per-socket, Redis-backed), input validation (Zod)
- Ops: healthcheck `/healthz`, `/metrics`, graceful shutdown
- Deployable: Docker-friendly, .env-driven configuration

## Requirements
- Node.js 18+
- Postgres (DATABASE_URL)
- Redis (REDIS_URL)
- S3-compatible bucket (R2) for media

## Quick start
1) Install dependencies
```sh
npm install
```

2) Configure environment (.env)
```ini
PORT=3000
ALLOWED_ORIGINS=["http://localhost:3000"]
DATABASE_URL=postgresql://user:password@localhost:5432/chat
REDIS_URL=redis://localhost:6379
JWT_SECRET=change-me
R2_ENDPOINT=https://accountid.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET=chat-media
# Optional basic auth for /metrics
METRICS_USER=
METRICS_PASS=
```

3) Generate Prisma client and apply schema
```sh
npx prisma generate
# For managed migrations in production:
npm run prisma:migrate:deploy
```

4) Run the server
```sh
npm run dev
# Visit http://localhost:3000
```

## How to use
- Register and log in via REST:
  - POST /api/register {username, password}
  - POST /api/login {username, password} → sets httpOnly cookie `sid`
- The web UI connects over Socket.IO. Join a room, then send messages.
- Upload flow for media:
  - POST /api/upload/init → get presigned POST {url, fields, key}
  - Upload file directly to R2 using returned form
  - POST /api/upload/complete with {roomId, key, mime, bytes} → receive `attachmentId` and signed GET url
  - Send a message with `{ attachmentId }` to broadcast media

## API overview
- GET /healthz → ok
- GET /metrics → Prometheus metrics (optional basic auth)
- GET /messages?roomId=R&beforeTs=T&limit=N → paginated history
- POST /api/register, /api/login, /api/logout
- POST /api/upload/init, /api/upload/complete

## Configuration
- CORS allow-list via `ALLOWED_ORIGINS` (JSON array)
- Logging level via `LOG_LEVEL`
- Metrics basic auth via `METRICS_USER`/`METRICS_PASS`

## Deployment
- Dockerfile and .dockerignore included
- Ensure Postgres, Redis, and R2 credentials are provided via environment

## Security notes
- JWT secret must be set in production
- Enable HTTPS in your deploy platform and set `secure` cookies
- Validate origins and keep rate limits enabled

## Development tips
- Run two instances with the same `REDIS_URL` to test multi-node presence
- Use `migrate:sqlite-to-pg` script if moving historical data from SQLite



New DB user and password
Username: shnag
Password: 5c622e63438aa83f2fcf3eeb3d67b8132ce38fe1a26a1f9e
Your DATABASE_URL
postgresql://shnag:5c622e63438aa83f2fcf3eeb3d67b8132ce38fe1a26a1f9e@localhost:5432/chat
How to test (already run, you can re-run)
In Terminal:
export PATH="/opt/homebrew/opt/postgresql@16/bin:$PATH"
psql -U shnag -h localhost -d chat -c "\dt"
You should see tables listed (Attachment, Message, etc.).