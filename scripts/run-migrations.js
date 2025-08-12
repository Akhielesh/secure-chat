const { readFileSync } = require('fs');
const { Client } = require('pg');
require('dotenv').config();

async function main() {
  const sql = readFileSync(require('path').join(__dirname, 'migrations.sql'), 'utf8');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    // Execute each statement separately to avoid transaction issues with concurrent indexes
    const statements = sql.split(/;\s*\n/).map(s => s.trim()).filter(Boolean);
    for (const stmt of statements) {
      console.log('> executing:', stmt.slice(0,80).replace(/\n/g,' '), '...');
      await client.query(stmt);
    }
    console.log('Migrations complete.');
  } finally {
    await client.end();
  }
}

main().catch((e)=>{ console.error(e); process.exit(1); });


