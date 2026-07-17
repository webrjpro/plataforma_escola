/**
 * app.ts — Composição HTTP do Backend EduVault
 *
 * Responsabilidades:
 * 1. Configura middleware de segurança (Helmet, Rate Limit, CORS)
 * 2. Cria diretórios de armazenamento de vídeo (uploads/videos, uploads/hls)
 * 3. Registra todas as rotas da API (/api/auth, /api/admin, /api/student, /api/videos)
 * 4. Serve arquivos HLS estáticos com autenticação JWT obrigatória
 *
 * Não abre portas nem inicia workers. Isso mantém a aplicação testável e deixa
 * o ciclo de vida do processo sob responsabilidade de main.ts.
 */
import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import authRoutes from './routes/auth';
import videoRoutes from './routes/video';
import adminRoutes from './routes/admin';
import studentRoutes from './routes/student';
import configRoutes from './routes/config';
import aiRoutes from './routes/ai';
import {
    adminBroadcastRouter,
    internalBroadcastRouter,
    publicBroadcastRouter,
} from './routes/broadcast';
import { privateRoomsRouter, adminPrivateRoomsRouter } from './routes/privateRooms';
import schoolRouter from './modules/school/schoolRouter';
import { authenticateStreamToken, authenticateToken, requireRole } from './middleware/authMiddleware';
import { requireCsrf } from './lib/sessionCookies';
import prisma from './lib/prisma';
import logger from './lib/logger';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';
import { publicPdfPathFromMountedRequest } from './lib/mediaPaths';
import { createErrorHandler, notFoundHandler } from './lib/http';

export interface AppLifecycleState {
    shuttingDown: boolean;
    startupReady: boolean;
}

export interface CreateAppOptions {
    lifecycle?: AppLifecycleState;
    database?: typeof prisma;
    createStorageDirectories?: boolean;
    requestLogging?: boolean;
    startedAt?: number;
}

/**
 * Cria a aplicação Express sem abrir socket nem conectar serviços de background.
 * Dependências operacionais usadas por health/metrics podem ser substituídas em
 * testes; as rotas de domínio preservam seus próprios módulos atuais.
 */
export function createApp(options: CreateAppOptions = {}): express.Express {
    const app = express();
    const lifecycle = options.lifecycle ?? { shuttingDown: false, startupReady: true };
    const database = options.database ?? prisma;
    const shouldCreateStorageDirectories = options.createStorageDirectories ?? true;
    app.set('trust proxy', trustProxySetting(process.env.TRUST_PROXY));

const corsOptions: cors.CorsOptions = {
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-XSRF-TOKEN'],
    credentials: true
};

// ========================================
// CAMADA DE SEGURANÇA (OWASP Compliance)
// ========================================

// Helmet: Remove headers que expõem a tecnologia do servidor
// crossOriginResourcePolicy: false → permite que o frontend (porta diferente) carregue imagens/vídeos
app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

// CORS precisa ser aplicado antes de rate limits para cobrir preflight (OPTIONS)
app.use(cors(corsOptions));
app.options('*path', cors(corsOptions));

// Rate Limiting: proteção contra brute force e DDoS básico
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: 10, // Limite rígido: 10 tentativas de login por IP a cada 15 min
    skip: (req) => req.method === 'OPTIONS',
    message: { message: 'Muitas tentativas de login. Aguarde 15 minutos.' }
});
app.use('/api/auth/login', loginLimiter);

// A troca de credenciais também executa bcrypt e precisa de um orçamento
// próprio para que uma conta comprometida não seja usada para exaurir CPU.
const credentialChangeLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    skip: (req) => req.method !== 'PUT',
    message: { message: 'Muitas tentativas de alteração de credenciais. Aguarde 15 minutos.' }
});
app.use('/api/auth/profile', credentialChangeLimiter);

const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 1000,
    skip: (req) => req.method === 'OPTIONS',
    message: { message: 'Muitas requisições deste IP. Tente novamente mais tarde.' }
});

const privateRoomAuthLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    skip: (req) => req.method === 'OPTIONS',
    message: { error: 'Muitas tentativas de acesso. Aguarde 15 minutos.' }
});
app.use('/api/private-rooms', privateRoomAuthLimiter);
app.use('/api/', apiLimiter);

// Rate limit separado para /progress (chamado a cada 10s por aluno ativo)
const progressLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300, // ~3.3/s — suficiente para 1 req/10s com margem
    skip: (req) => req.method === 'OPTIONS',
    message: { message: 'Muitas atualizações de progresso.' }
});
app.use('/api/student/progress', progressLimiter);

// Multipart uploads are intentionally larger than JSON commands. Keeping the
// global JSON budget small prevents a cheap memory-exhaustion path without
// affecting video/PDF/image uploads handled by Multer.
app.use(express.json({ limit: jsonBodyLimit(process.env.JSON_BODY_LIMIT) }));

const videoUploadLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 20,
    skip: (req) => req.method === 'OPTIONS',
    message: { message: 'Limite de uploads de vídeo atingido. Tente novamente mais tarde.' }
});
app.use('/api/videos/upload', videoUploadLimiter);

const assetUploadLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 200,
    skip: (req) => req.method === 'OPTIONS',
    message: { message: 'Limite de uploads atingido. Tente novamente mais tarde.' }
});
app.use(['/api/admin/upload-image', '/api/admin/upload-pdf', '/api/admin/upload-students-excel'], assetUploadLimiter);

// Request logging estruturado
if (options.requestLogging ?? true) {
    app.use(pinoHttp({
        logger,
        genReqId: (req, res) => {
            const incoming = req.headers['x-request-id'];
            const requestId = typeof incoming === 'string' && /^[a-zA-Z0-9._:-]{8,128}$/.test(incoming)
                ? incoming
                : crypto.randomUUID();
            res.setHeader('X-Request-ID', requestId);
            return requestId;
        },
        autoLogging: { ignore: (req) => (req.url === '/' || req.url === '/api/metrics') }
    }));
}
app.use('/api', requireCsrf);

// ========================================
// DIRETÓRIOS DE ARMAZENAMENTO
// ========================================
const videoStoragePath = process.env.VIDEO_STORAGE_PATH || './uploads/videos';
const hlsStoragePath = process.env.HLS_STORAGE_PATH || './uploads/hls';
const imageStoragePath = process.env.IMAGE_STORAGE_PATH || './uploads/images';

if (shouldCreateStorageDirectories) {
    [videoStoragePath, hlsStoragePath, imageStoragePath].forEach((dir) => {
        const fullPath = path.resolve(dir);
        if (!fs.existsSync(fullPath)) {
            fs.mkdirSync(fullPath, { recursive: true });
        }
    });
}

// ========================================
// ROTAS DA API
// ========================================

// Health check — verifica DB, pg-boss, disco e fila de vídeos
app.get('/health/live', (_req, res) => {
    res.json({ status: 'ok' });
});

app.get('/health/ready', async (_req, res) => {
    if (lifecycle.shuttingDown || !lifecycle.startupReady) {
        res.status(503).json({ status: lifecycle.shuttingDown ? 'shutting-down' : 'starting' });
        return;
    }
    try {
        const startedAt = Date.now();
        await database.$queryRaw`SELECT 1`;
        res.json({ status: 'ready', databaseLatencyMs: Date.now() - startedAt });
    } catch {
        res.status(503).json({ status: 'not-ready' });
    }
});

app.get('/', (_req, res) => {
    // Do not expose queue size, disk capacity, DB latency or process details on
    // an unauthenticated endpoint. /health/ready and ADMIN /api/metrics cover
    // orchestration and operations respectively.
    res.json({ service: 'eduvault-api', status: 'ok' });
});

// Métricas operacionais (para monitoramento/alertas)
const startTime = options.startedAt ?? Date.now();
app.get('/api/metrics', authenticateToken, requireRole(['ADMIN']), async (_req, res) => {
    try {
        const mem = process.memoryUsage();
        const [queueSize] = await database.$queryRaw<[{ count: bigint }]>`
            SELECT COUNT(*) as count FROM pgboss.job WHERE name = 'video-process' AND state < 'completed'
        `.catch(() => [{ count: 0n }]);

        res.json({
            uptime: Math.floor((Date.now() - startTime) / 1000),
            memory: {
                rss: Math.round(mem.rss / 1024 / 1024),
                heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
                heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
            },
            pid: process.pid,
            queuePending: Number(queueSize?.count ?? 0),
        });
    } catch {
        res.status(500).json({ error: 'metrics unavailable' });
    }
});

// Autenticação (Login)
app.use('/api/auth', authRoutes);

// Upload e Listagem de Vídeos (Admin/Professor)
app.use('/api/videos', videoRoutes);

// Professor virtual com contexto pedagogico e historico por aluno
app.use('/api/ai', aiRoutes);

// Campus ao vivo: leitura publica, administracao protegida e autorizacao RTMP interna
app.use('/api/broadcast', publicBroadcastRouter);
app.use('/api/admin/broadcast', adminBroadcastRouter);
app.use('/internal', internalBroadcastRouter);

// Salas Privadas (Masterclass com senha)
app.use('/api/private-rooms', privateRoomsRouter);
app.use('/api/admin/private-rooms', adminPrivateRoomsRouter);

// Painel Administrativo Completo (CRUD)
app.use('/api/admin', adminRoutes);

// Área do Aluno (Cursos matriculados, Progresso)
app.use('/api/student', studentRoutes);

// Configurações Globais (Nome, Cor, Logo - Rota Pública)
app.use('/api/config', configRoutes);

// Sistema operacional escolar versionado (SIS + diário + gradebook)
app.use('/api/v1/school', schoolRouter);

// Servir imagens de uploads/images (thumbnails, conteúdo rico)
app.use('/uploads/images', express.static(path.resolve(imageStoragePath), { dotfiles: 'deny' }));

// Servir PDFs de uploads/pdfs (material de módulo + calendário)
const pdfStoragePath = process.env.PDF_STORAGE_PATH || './uploads/pdfs';
app.use('/uploads/pdfs', authenticateToken, async (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.status(405).json({ message: 'Método não permitido.' });
        return;
    }

    const publicPath = publicPdfPathFromMountedRequest(req.path);
    if (!publicPath) {
        res.status(404).json({ message: 'Material não encontrado.' });
        return;
    }

    // Administrators need access to a newly uploaded file before attaching it.
    if (req.user!.role === 'ADMIN') {
        next();
        return;
    }

    try {
        const enrollmentRole = req.user!.role === 'STUDENT' ? 'STUDENT' as const : 'TEACHER' as const;
        const courseAccess = {
            enrollments: { some: { userId: req.user!.id, enrollmentRole } }
        };

        const [moduleReference, courseReference] = await Promise.all([
            database.module.findFirst({
                where: { pdfUrl: publicPath, course: courseAccess },
                select: { id: true }
            }),
            database.course.findFirst({
                where: { calendarUrl: publicPath, ...courseAccess },
                select: { id: true }
            })
        ]);

        if (!moduleReference && !courseReference) {
            // 404 avoids turning UUID filenames into an authorization oracle.
            res.status(404).json({ message: 'Material não encontrado.' });
            return;
        }
        next();
    } catch (error) {
        logger.error({ error, userId: req.user!.id, publicPath }, 'Falha ao autorizar material PDF');
        res.status(503).json({ message: 'Serviço de materiais temporariamente indisponível.' });
    }
});
app.use('/uploads/pdfs', express.static(path.resolve(pdfStoragePath), { dotfiles: 'deny' }));

// HLS Streaming Route
// Cada playlist e segmento exige token curto, com purpose=stream e videoId.
// O VideoPlayer injeta o header Authorization em todas as requisições VHS.
app.use('/hls', authenticateStreamToken, express.static(path.resolve(hlsStoragePath), {
    dotfiles: 'deny',
    setHeaders: (res, filePath) => {
        // Segmentos .ts são imutáveis (conteúdo fixo), cache longo
        // Playlists .m3u8 precisam ser fresh para adaptive switching
        if (filePath.endsWith('.ts')) {
            res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
        } else {
            res.setHeader('Cache-Control', 'no-cache');
        }
        res.setHeader('X-Robots-Tag', 'noindex');
        res.setHeader('Access-Control-Allow-Origin', process.env.FRONTEND_URL || 'http://localhost:5173');
    }
}));

// API/static misses and middleware errors (Multer, malformed JSON, size limits)
// must be deterministic JSON and must never leak framework stack traces.
app.use(notFoundHandler);
app.use(createErrorHandler(logger));

    return app;
}

export function trustProxySetting(value: string | undefined): number | boolean {
    if (!value || value === '0' || value.toLowerCase() === 'false') return false;
    if (value.toLowerCase() === 'true') return true;
    const hops = Number(value);
    if (Number.isInteger(hops) && hops >= 0 && hops <= 10) return hops;
    throw new Error('TRUST_PROXY invalido. Use false, true ou um numero de saltos entre 0 e 10.');
}

export function jsonBodyLimit(value: string | undefined): string {
    const normalized = value?.trim().toLowerCase();
    if (!normalized) return '2mb';
    if (/^[1-9]\d{0,3}(kb|mb)$/.test(normalized)) return normalized;
    logger.warn({ value }, 'JSON_BODY_LIMIT inválido; usando 2mb.');
    return '2mb';
}
