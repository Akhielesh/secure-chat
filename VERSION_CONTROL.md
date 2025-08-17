# Version Control Log

Chronological log of noteworthy changes. Timestamps are in ISO-8601.

## 2025-08-11T00:00:00Z
- Initialize version log retroactively for recent phases.
- Phase 0–6 applied: hygiene, validation, auth, Postgres, Redis scaling, media, metrics.

## 2025-08-11T00:05:00Z
- Docs: Rewrite README to remove outdated terms and document features/usage.
- Add BUGLOG.md and ARCHITECTURE.md.

## 2025-08-11T00:10:00Z
- Remove remaining "retro" references in `CHANGELOG.md`, `public/about.html`, and rename Render service to `secure-chat`.

## 2025-08-11T00:15:00Z
- Apply About page design language to home/chat: added shared animations and hover styles in `public/index.html`; refined layout container and panels in `public/app.jsx` (rounded corners, gradient background, subtle shadows, consistent header avatar block).

## 2025-08-11T00:18:00Z
- Set founder profile image on About page to `/public/images/founder.jpg` with fallback; created `public/images/` and `.keep` placeholder.

## 2025-08-11T00:20:00Z
- Updated founder details on About page: name set to "Akhielesh Srirangam" and bio quote added.

## 2025-08-11T00:22:00Z
- Replaced placeholder founder image with uploaded `/public/images/founder.jpg` (moved from project root `founder.jpeg`).

## 2025-08-11T00:28:00Z
- UI polish: Added shared animations/utilities in `public/index.html` (bubble-in, typing dots, thin scrollbars). Enhanced `public/app.jsx` with hover/press transitions for buttons, animated message bubbles, refined panels.

## 2025-08-11T00:36:00Z
- Feature UX: message copy/react/edit (time-limited), typing indicator row, scroll-to-bottom button, live char counter, drag-and-drop media preview, theme toggle (persisted), keyboard shortcuts. Added DAO helpers for reactions/pins. Accessibility: added ARIA labels and better focus via styles.

## 2025-08-11T00:44:00Z
- Dark theme polish: global text color adjustments to ensure contrast; hover styles in dark.
- Emoji UX: added recent emoji memory in picker; customizable react prompt; expanded default set.
- In-place editing: replaced prompt with inline input in the message bubble; Enter to save, Esc to cancel.
- Verified scroll FAB logic and auto-scroll only when near bottom.

## 2025-08-12T02:40:00Z
- Backend: Implemented delivery acknowledgments. Client emits `message:ack` on receive; server updates `Message.meta.delivered_by` and emits `message:delivered` with counts.
- Frontend: Ticks logic updated — `✓` sent, `✓✓` gray after any delivery ack, `✓✓` black bold after read receipted. Added bottom-center “↓” jump-to-latest button above composer.
- Backend: Seed defaults on empty DB (dev only) — creates users `alice/bob` with `secret123`, lobby membership, and a welcome message to ease testing.

## 2025-08-17T00:23:50Z
- Repo: Commit pending workspace changes and publish to GitHub remote `origin` (`Akhielesh/secure-chat`). Includes updates to `package.json`, `package-lock.json`, `server.js`, `public/*` and addition of `public/test.html`.

