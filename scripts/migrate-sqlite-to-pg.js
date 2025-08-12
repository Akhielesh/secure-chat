/*
 One-time migration script: SQLite (chat.db) -> Postgres via Prisma
 Usage:
   DATABASE_URL=postgres://... node scripts/migrate-sqlite-to-pg.js
*/
const path = require('path');
const Database = require('better-sqlite3');
const { PrismaClient } = require('@prisma/client');

async function main() {
  const sqlitePath = path.join(__dirname, '..', 'chat.db');
  const db = new Database(sqlitePath, { readonly: true });
  const prisma = new PrismaClient();
  try {
    const rooms = db.prepare('SELECT id, created_at FROM rooms').all();
    const users = db.prepare('SELECT id, username, password_hash, created_at FROM users').all();
    const messages = db.prepare('SELECT id, room_id as roomId, user_id as userId, name, text, ts FROM messages').all();

    // Upsert users
    for (const u of users) {
      await prisma.user.upsert({
        where: { id: u.id },
        create: {
          id: u.id,
          username: u.username,
          passwordHash: u.password_hash,
          createdAt: new Date(u.created_at),
        },
        update: {
          username: u.username,
          passwordHash: u.password_hash,
        },
      });
    }

    // Upsert rooms
    for (const r of rooms) {
      await prisma.room.upsert({
        where: { id: r.id },
        create: { id: r.id, createdAt: new Date(r.created_at) },
        update: {},
      });
    }

    // Batch insert messages in chunks
    const chunkSize = 1000;
    for (let i = 0; i < messages.length; i += chunkSize) {
      const chunk = messages.slice(i, i + chunkSize);
      if (chunk.length === 0) continue;
      await prisma.message.createMany({
        data: chunk.map((m) => ({
          id: m.id,
          roomId: m.roomId,
          userId: m.userId,
          name: m.name,
          text: m.text,
          ts: BigInt(m.ts),
        })),
        skipDuplicates: true,
      });
    }

    console.log(`Migrated: users=${users.length}, rooms=${rooms.length}, messages=${messages.length}`);
  } finally {
    await prisma.$disconnect();
    db.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});



