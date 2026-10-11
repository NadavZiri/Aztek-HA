CREATE TABLE "User" (
    "id" UUID NOT NULL, "email" TEXT NOT NULL, "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "Session" (
    "id" UUID NOT NULL, "userId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL, "revokedAt" TIMESTAMP(3),
    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "RefreshToken" (
    "id" UUID NOT NULL, "hash" TEXT NOT NULL, "sessionId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "consumedAt" TIMESTAMP(3),
    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "WeatherDraft" (
    "id" UUID NOT NULL, "userId" UUID NOT NULL, "sessionId" UUID NOT NULL,
    "citySelection" JSONB NOT NULL, "current" JSONB NOT NULL, "forecast" JSONB NOT NULL,
    "units" TEXT NOT NULL DEFAULT 'metric', "fetchedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WeatherDraft_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "WeatherSnapshot" (
    "id" UUID NOT NULL, "sourceDraftId" UUID NOT NULL, "userId" UUID NOT NULL,
    "citySelection" JSONB NOT NULL, "current" JSONB NOT NULL, "forecast" JSONB NOT NULL,
    "units" TEXT NOT NULL DEFAULT 'metric', "fetchedAt" TIMESTAMP(3) NOT NULL,
    "savedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WeatherSnapshot_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE INDEX "Session_userId_idx" ON "Session"("userId");
CREATE UNIQUE INDEX "RefreshToken_hash_key" ON "RefreshToken"("hash");
CREATE INDEX "RefreshToken_sessionId_idx" ON "RefreshToken"("sessionId");
CREATE INDEX "WeatherDraft_expiresAt_idx" ON "WeatherDraft"("expiresAt");
CREATE INDEX "WeatherDraft_userId_idx" ON "WeatherDraft"("userId");
CREATE UNIQUE INDEX "WeatherSnapshot_sourceDraftId_key" ON "WeatherSnapshot"("sourceDraftId");
CREATE INDEX "WeatherSnapshot_userId_savedAt_id_idx" ON "WeatherSnapshot"("userId", "savedAt", "id");
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WeatherDraft" ADD CONSTRAINT "WeatherDraft_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WeatherDraft" ADD CONSTRAINT "WeatherDraft_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WeatherSnapshot" ADD CONSTRAINT "WeatherSnapshot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
