-- CreateTable
CREATE TABLE "ZoneDemand" (
    "id" TEXT NOT NULL,
    "zoneId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ZoneDemand_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ZoneDemand_zoneId_createdAt_idx" ON "ZoneDemand"("zoneId", "createdAt");

-- AddForeignKey
ALTER TABLE "ZoneDemand" ADD CONSTRAINT "ZoneDemand_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE CASCADE ON UPDATE CASCADE;

