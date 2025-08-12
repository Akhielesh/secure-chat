# Architecture & System Design

## Overview
A Node.js/Express server provides HTTP APIs and hosts a Socket.IO real-time gateway. Data is persisted in Postgres via Prisma ORM. Redis enables horizontal scaling and shared presence/rate limits. Media files are stored in an S3-compatible bucket (Cloudflare R2) and accessed via signed URLs.

## Components
- API Server: Express + Socket.IO
- Database: Postgres (Prisma client)
- Cache/Adapter: Redis (Socket.IO adapter, presence, rate limits)
- Object Storage: Cloudflare R2 (S3 API)
- Observability: pino logs + Prometheus metrics

## Data Model (Prisma)
- User(id, username, passwordHash, createdAt)
- Room(id, createdAt)
- RoomMember(id, roomId, userId, joinedAt)
- Message(id, roomId, userId, name, text, ts, attachmentId?)
- Attachment(id, roomId, userId, key, mime, bytes, ts)

## Real-time Flow
1. Client authenticates (JWT in `sid` cookie) via REST.
2. Socket.IO handshake checks JWT and sets `socket.user`.
3. Client joins a room; server records presence in Redis hash `presence:room:<roomId>` and returns users + last messages.
4. Messages are validated (Zod), rate-limited (Redis), persisted (Postgres), and broadcast to the room.

## Presence
- Redis Hash per room: key `presence:room:<roomId>` → { socketId: { id, name, ts } }
- On disconnect: HDEL socketId
- Periodic prune by timestamp (server-side helper available)

## Rate Limiting
- Redis `INCR` + `EXPIRE` per socketId under `ratelimit:<socketId>`
- Caps bursts and per-second throughput for `message` and `typing`

## Media Uploads
- POST /api/upload/init → presigned POST (fields + URL)
- Client sends file directly to R2
- POST /api/upload/complete → records Attachment row; returns signed GET URL
- Messages may reference `attachmentId`; server injects signed GET URL on broadcast and history fetch

## Pagination
- Cursor-like via timestamp: `/messages?roomId=R&beforeTs=T&limit=N`
- Server queries messages before `T` sorted desc, then reverses to ASC for display

## Security Considerations
- JWT HS256 with httpOnly cookie; secret via env
- CORS allow-list for Socket.IO
- Zod payload validation; size/type limits for media
- Rate limiting for abuse resistance

## Deployment
- Configure `DATABASE_URL`, `REDIS_URL`, R2 credentials, `JWT_SECRET`
- Horizontal scaling supported; use the Redis adapter in all instances

## Graceful Shutdown
- On SIGTERM/SIGINT: close HTTP server, Socket.IO, Prisma, and Redis connections; exit cleanly

