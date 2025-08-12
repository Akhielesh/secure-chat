# Bug Log

Tracks bugs to avoid regressions. Reference timestamps tie back to `VERSION_CONTROL.md`.

- 2025-08-11: Presence bug after Redis migration — some handlers still referenced in-memory `liveRooms`. Fixed by removing all references and using Redis-backed presence for join/list/typing.
- 2025-08-11: Prisma version mismatch (client vs CLI). Aligned to 5.22.0 and regenerated client.
- 2025-08-11: Signed GET URL mistakenly used PutObject. Switched to `GetObjectCommand`.
- 2025-08-11: `.env.example` updates blocked via patch; switched to runtime write to append variables.

Future bugs should include: steps to reproduce, expected vs actual, root cause, and fix.



