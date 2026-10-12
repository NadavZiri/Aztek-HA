CREATE TABLE "RateLimitBucket" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "hits" INTEGER NOT NULL,
  "resetAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "RateLimitBucket_resetAt_idx" ON "RateLimitBucket"("resetAt");
