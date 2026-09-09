-- Persisted AI-assistant conversations. Each row is one thread the chat
-- panel can re-open and replay. `messages` holds the ChatMessage[] transcript
-- as JSONB. Owned by one user (ownerId) within one org — chat history is
-- private to the person who had the conversation.
CREATE TABLE "chat_threads" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "ownerId" TEXT,
    "title" TEXT NOT NULL,
    "messages" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_threads_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "chat_threads_orgId_idx" ON "chat_threads"("orgId");
CREATE INDEX "chat_threads_orgId_ownerId_idx" ON "chat_threads"("orgId", "ownerId");
