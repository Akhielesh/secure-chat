-- Production performance indexes for chat application

-- Messages: Hot query patterns
CREATE INDEX IF NOT EXISTS idx_messages_room_time ON "Message"("roomId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS idx_messages_user_time ON "Message"("userId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS idx_messages_text_search ON "Message" USING gin(to_tsvector('english', text));

-- Room members: Membership checks
CREATE INDEX IF NOT EXISTS idx_room_members_user ON "RoomMember"("userId");
CREATE INDEX IF NOT EXISTS idx_room_members_room_role ON "RoomMember"("roomId", "role");

-- Read receipts: Unread message calculations
CREATE INDEX IF NOT EXISTS idx_read_receipts_room_user ON "ReadReceipt"("roomId", "userId");
CREATE INDEX IF NOT EXISTS idx_read_receipts_message ON "ReadReceipt"("messageId");

-- Attachments: Media queries
CREATE INDEX IF NOT EXISTS idx_attachments_room_time ON "Attachment"("roomId", "ts" DESC);
CREATE INDEX IF NOT EXISTS idx_attachments_user ON "Attachment"("userId");

-- Users: Auth and search
CREATE INDEX IF NOT EXISTS idx_users_username_lower ON "User"(lower("username"));

-- Reactions: Message interactions
CREATE INDEX IF NOT EXISTS idx_reactions_message_emoji ON "Reaction"("messageId", "emoji");

-- Pins: Pinned messages
CREATE INDEX IF NOT EXISTS idx_pins_message ON "Pin"("messageId");

-- Room read state: Unread tracking
CREATE INDEX IF NOT EXISTS idx_room_read_state_user ON "RoomReadState"("userId");
