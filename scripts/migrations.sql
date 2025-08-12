-- FTS column for messages
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS text_fts tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(text,''))) STORED;

-- Concurrent indexes (run outside transaction in production)
CREATE INDEX IF NOT EXISTS idx_msg_room_ts_id ON "Message" ("roomId", ts DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_msg_fts ON "Message" USING GIN (text_fts);

-- Read state uniqueness (Prisma composite id covers this, keep for safety)
-- CREATE UNIQUE INDEX CONCURRENTLY idx_read_state_room_user ON "RoomReadState"("roomId", "userId");

-- Reactions, Pins (already in schema but ensure)
CREATE INDEX IF NOT EXISTS idx_react_msg_emoji ON "Reaction" ("messageId", emoji);
CREATE INDEX IF NOT EXISTS idx_pin_msg ON "Pin" ("messageId");


