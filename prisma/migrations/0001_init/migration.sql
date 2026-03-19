-- CreateEnum
CREATE TYPE "VideoJobStatus" AS ENUM ('DISCOVERED', 'PROCESSING', 'READY', 'PUBLISHING', 'PUBLISHED', 'RETRY_WAITING', 'PAUSED_FAILED');

-- CreateEnum
CREATE TYPE "TelegramDraftStatus" AS ENUM ('PENDING_REVIEW', 'PUBLISHED', 'DELETED');

-- CreateEnum
CREATE TYPE "SocialPublicationStatus" AS ENUM ('AWAITING_EXTERNAL_API_CONFIG', 'READY', 'PUBLISHING', 'PUBLISHED', 'FAILED');

-- CreateEnum
CREATE TYPE "EditSessionStatus" AS ENUM ('ACTIVE', 'CLOSED');

-- CreateTable
CREATE TABLE "AppState" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppState_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "VideoJob" (
    "id" TEXT NOT NULL,
    "driveFileId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "descriptionFileId" TEXT,
    "descriptionFileName" TEXT,
    "createdTime" TIMESTAMP(3) NOT NULL,
    "status" "VideoJobStatus" NOT NULL DEFAULT 'DISCOVERED',
    "transcriptText" TEXT,
    "descriptionText" TEXT,
    "scheduledFor" TIMESTAMP(3),
    "scheduledSlotKey" TEXT,
    "publishAttempts" INTEGER NOT NULL DEFAULT 0,
    "publishedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "lastPublishPayload" JSONB,
    "lastPublishResult" JSONB,
    "deferredNotes" JSONB,
    "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VideoJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArticleRecord" (
    "id" TEXT NOT NULL,
    "sourceName" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "canonicalUrl" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "contentHash" TEXT NOT NULL,
    "excerpt" TEXT,
    "bodyText" TEXT,
    "clusterId" TEXT,
    "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ArticleRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentCluster" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "sourceUrlsJson" TEXT NOT NULL,
    "articleIdsJson" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContentCluster_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelegramDraft" (
    "id" TEXT NOT NULL,
    "clusterId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "textFileId" TEXT,
    "imageFileId" TEXT,
    "imageMimeType" TEXT,
    "sourceUrlsJson" TEXT NOT NULL,
    "previewChatId" TEXT,
    "previewMessageId" TEXT,
    "channelMessageId" TEXT,
    "rewriteOfDraftId" TEXT,
    "status" "TelegramDraftStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelegramDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EditSession" (
    "id" TEXT NOT NULL,
    "telegramDraftId" TEXT NOT NULL,
    "ownerChatId" TEXT NOT NULL,
    "promptMessageId" TEXT,
    "status" "EditSessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EditSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocialPublication" (
    "id" TEXT NOT NULL,
    "clusterId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "imagePrompt" TEXT,
    "imageFileId" TEXT,
    "imageMimeType" TEXT,
    "textFileId" TEXT,
    "folderStem" TEXT NOT NULL,
    "scheduledFor" TIMESTAMP(3),
    "scheduledSlotKey" TEXT,
    "status" "SocialPublicationStatus" NOT NULL DEFAULT 'AWAITING_EXTERNAL_API_CONFIG',
    "publishAttempts" INTEGER NOT NULL DEFAULT 0,
    "publishedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "lastPayload" JSONB,
    "lastResult" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialPublication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationEvent" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "entityId" TEXT,
    "chatId" TEXT,
    "messageId" TEXT,
    "payload" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VideoJob_driveFileId_key" ON "VideoJob"("driveFileId");

-- CreateIndex
CREATE INDEX "VideoJob_status_scheduledFor_idx" ON "VideoJob"("status", "scheduledFor");

-- CreateIndex
CREATE UNIQUE INDEX "ArticleRecord_dedupeKey_key" ON "ArticleRecord"("dedupeKey");

-- CreateIndex
CREATE INDEX "ArticleRecord_clusterId_idx" ON "ArticleRecord"("clusterId");

-- CreateIndex
CREATE UNIQUE INDEX "ContentCluster_fingerprint_key" ON "ContentCluster"("fingerprint");

-- CreateIndex
CREATE INDEX "TelegramDraft_status_createdAt_idx" ON "TelegramDraft"("status", "createdAt");

-- CreateIndex
CREATE INDEX "EditSession_ownerChatId_status_idx" ON "EditSession"("ownerChatId", "status");

-- CreateIndex
CREATE INDEX "SocialPublication_status_scheduledFor_idx" ON "SocialPublication"("status", "scheduledFor");

-- AddForeignKey
ALTER TABLE "ArticleRecord" ADD CONSTRAINT "ArticleRecord_clusterId_fkey" FOREIGN KEY ("clusterId") REFERENCES "ContentCluster"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramDraft" ADD CONSTRAINT "TelegramDraft_clusterId_fkey" FOREIGN KEY ("clusterId") REFERENCES "ContentCluster"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EditSession" ADD CONSTRAINT "EditSession_telegramDraftId_fkey" FOREIGN KEY ("telegramDraftId") REFERENCES "TelegramDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialPublication" ADD CONSTRAINT "SocialPublication_clusterId_fkey" FOREIGN KEY ("clusterId") REFERENCES "ContentCluster"("id") ON DELETE CASCADE ON UPDATE CASCADE;

