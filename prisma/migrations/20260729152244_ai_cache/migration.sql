-- CreateTable
CREATE TABLE "ModelResolution" (
    "cacheKey" TEXT NOT NULL PRIMARY KEY,
    "rawTitle" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "modelTitle" TEXT NOT NULL,
    "modelKey" TEXT NOT NULL,
    "capacity" TEXT,
    "color" TEXT,
    "source" TEXT NOT NULL,
    "agreed" BOOLEAN NOT NULL DEFAULT false,
    "frozen" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ProductDescription" (
    "modelKey" TEXT NOT NULL PRIMARY KEY,
    "html" TEXT NOT NULL,
    "promptVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "ModelResolution_modelKey_idx" ON "ModelResolution"("modelKey");
