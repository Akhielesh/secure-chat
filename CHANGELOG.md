# Changelog

All notable changes to this project will be documented in this file.

## 1.0.0 - Initial release
- Initialize Node.js project with `express`, `socket.io`, and `nanoid`.
- Add `server.js` to serve static files and power real-time chat with rooms, join/leave notifications, typing indicators, and message history.
- Add frontend assets under `public/`:
  - `index.html`: minimal retro UI (room, name, messages list, input).
  - `styles.css`: retro terminal-like theme.
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


