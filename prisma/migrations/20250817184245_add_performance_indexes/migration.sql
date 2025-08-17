-- Performance Indexes for Chat Application
-- This migration adds critical indexes for message pagination and room membership queries

-- Index for efficient message retrieval by room and timestamp (keyset pagination)
CREATE INDEX IF NOT EXISTS idx_messages_room_time ON "Message"("roomId", "ts" DESC);

-- Index for efficient room membership lookups
CREATE INDEX IF NOT EXISTS idx_members_room_user ON "RoomMember"("roomId", "userId");

-- Index for efficient read receipt queries
CREATE INDEX IF NOT EXISTS idx_receipts_room_user ON "RoomReadState"("roomId", "userId");

-- Index for efficient user presence tracking
CREATE INDEX IF NOT EXISTS idx_presence_user_room ON "RoomReadState"("userId", "roomId");

-- Index for efficient message search by user
CREATE INDEX IF NOT EXISTS idx_messages_user_time ON "Message"("userId", "ts" DESC);

-- Index for efficient attachment queries
CREATE INDEX IF NOT EXISTS idx_attachments_room_user ON "Attachment"("roomId", "userId");

-- Index for efficient room queries
CREATE INDEX IF NOT EXISTS idx_rooms_updated ON "Room"("updatedAt" DESC);

-- Index for efficient test data queries
CREATE INDEX IF NOT EXISTS idx_testlog_run_section ON "TestLog"("runId", "section");
CREATE INDEX IF NOT EXISTS idx_testmetric_run_time ON "TestMetric"("runId", "createdAt");
