import { PrismaClient } from '@prisma/client';

// Singleton pattern para evitar múltiplas conexões em dev (hot-reload)
const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined };

const prisma = globalForPrisma.prisma ?? (process.env.DATABASE_URL
    ? new PrismaClient({
        datasources: { db: { url: process.env.DATABASE_URL } },
        log: process.env.NODE_ENV === 'production' ? ['error'] : ['warn', 'error']
    })
    : new PrismaClient());

if (process.env.NODE_ENV !== 'production') {
    globalForPrisma.prisma = prisma;
}

export default prisma;
