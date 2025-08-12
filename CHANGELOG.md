# Changelog

All notable changes to this project will be documented in this file.

## 1.0.0 - Initial release
- Initialize Node.js project with `express`, `socket.io`, and `nanoid`.
- Add `server.js` to serve static files and power real-time chat with rooms, join/leave notifications, typing indicators, and message history.
- Add frontend assets under `public/`:
  - `index.html`: minimal UI (room, name, messages list, input).
  - `styles.css`: clean theme.
  - `client.js`: Socket.IO client, join flow, messages, typing indicator.
- Default room is `lobby` with in-memory storage.

### Enhancements
- Shareable room links via URL query params `?room=...&name=...`.
- UI shows a share link and copy button after joining.
- Explicit Create/Join room flow; history loads only after successful join.
- SQLite persistence (`better-sqlite3`) for rooms and messages.
- React demo UI:
  - Auto-loads messages when conversation is open (live updates via `chatdb:update`).
  - Notification bell shows unread count for other conversations.
  - Stackable toasts for new messages and membership events; auto-dismiss after 5s; manual close supported.
  - Membership notifications for group/lobby create, invite, and join events.
  - Header title changed to `Secure chat`.
- Add `render.yaml` and `Dockerfile` for easy free hosting (Render/Fly/Railway).


## 1.1.0 - Ops hygiene and baseline
- Add `.dockerignore` to exclude `node_modules`, `chat.db*`, `.git`, logs, `.env`, and `.DS_Store` from build context.
- Ensure `.gitignore` includes `chat.db*` and `.env`.
- Add `.env.example` with `PORT` and `ALLOWED_ORIGINS` (no secrets).
- Add env loading via `dotenv` and parse `ALLOWED_ORIGINS` (JSON array or comma list) with safe defaults.
- Add healthcheck route `GET /healthz` returning 200 `ok`.
- Integrate structured HTTP logging using `pino` and `pino-http` with per-request IDs (`nanoid`).
- Configure Socket.IO CORS to use `ALLOWED_ORIGINS`.
- Update `package.json` scripts: `dev` and `start` both run `node server.js`.

## 1.2.0 - Stability & abuse controls
- Configure Socket.IO with `maxHttpBufferSize` (~100KB) and CORS allow-list from `ALLOWED_ORIGINS`.
- Add Zod validation schemas for `create-room`, `join`, and `message` payloads; reject invalid inputs with structured errors.
- Enforce message length limit (max 2000 chars).
- Add per-socket token-bucket rate limiting (burst=10, rate=5/sec) for `message` and `typing` events.
- Add dependency `zod` to `package.json`.

## 1.3.0 - Postgres, pagination, Redis scale, media, metrics
- Migrate storage to Postgres via Prisma; add `prisma/schema.prisma` and migration script.
- Replace SQLite queries with Prisma; add cursor-based pagination and `/messages` endpoint.
- Add Redis adapter for Socket.IO and Redis-backed presence/rate limiting.
- Add attachments via R2 (S3-compatible) and signed URLs; `/api/upload/init` and `/api/upload/complete`.
- Add Prometheus metrics `/metrics`, counters/histograms, and graceful shutdown.
- Rewrite README to describe features/usage and remove retro terminology.

