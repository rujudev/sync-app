-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ProductDescription" (
    "modelKey" TEXT NOT NULL PRIMARY KEY,
    "html" TEXT NOT NULL,
    "promptVersion" INTEGER NOT NULL DEFAULT 1,
    "sourceHash" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_ProductDescription" ("createdAt", "html", "modelKey", "promptVersion") SELECT "createdAt", "html", "modelKey", "promptVersion" FROM "ProductDescription";
DROP TABLE "ProductDescription";
ALTER TABLE "new_ProductDescription" RENAME TO "ProductDescription";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
