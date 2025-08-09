# secure-chat

Modern, scalable real-time chat with Postgres, Redis, S3-compatible media, analytics, and a polished UI.

## Features
- Real-time messaging (Socket.IO) with JWT-authenticated handshakes
- Postgres + Prisma persistence (Rooms, Members, Messages, Reactions, Pins, Read receipts, Attachments)
- Redis adapter (horizontal scale), presence, and rate-limiting
- Media uploads to R2/S3 with presigned URLs and server-side compression (sharp/ffmpeg)
- Observability: structured logs (pino) and Prometheus metrics (`/metrics`)
- UI/UX: dark mode, reactions, edit, unread jump, bottom-center jump to latest

## Quick start (local)
```sh
npm install
# Ensure Postgres and Redis are running; set .env from .env.example
npx prisma migrate dev --name init
npm run start
# open http://localhost:3000
```

## Environment
See `.env.example` for all variables (DATABASE_URL, REDIS_URL, R2 creds, JWT_SECRET, etc.).

## Database
- Prisma schema at `prisma/schema.prisma`
- Additional FTS/indexes in `scripts/migrations.sql` (run via `npm run db:migrate:sql`)

## Docs
- `ARCHITECTURE.md`: components, flows, data model
- `VERSION_CONTROL.md`: version log by date
- `BUGLOG.md`: bugs and fixes

