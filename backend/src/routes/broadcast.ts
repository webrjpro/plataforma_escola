import { createHash, timingSafeEqual } from 'crypto';
import express, { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { authenticateToken, requireRole } from '../middleware/authMiddleware';
import { uploadVideo, validateUploadedVideo, removeUploadedFile } from '../middleware/uploadMiddleware';
import { uploadFileToStorage } from '../lib/storage';
import prisma from '../lib/prisma';
import logger from '../lib/logger';
import { asyncHandler as asyncRoute, HttpError } from '../lib/http';
import { createInputValidator } from '../lib/validation';

const BroadcastHttpError = HttpError;
const broadcastInput = createInputValidator(
    (_issue, message) => new HttpError(400, message),
);
const {
    requireObject,
    rejectUnknownKeys,
    requiredText,
    nullableText,
    requiredUuid,
    optionalUuid,
    enumValue,
} = broadcastInput;

export const publicBroadcastRouter = Router();
export const adminBroadcastRouter = Router();
export const internalBroadcastRouter = Router();

publicBroadcastRouter.get('/status', asyncRoute(async (_req, res) => {
    res.json(await readBroadcastRuntimeStatus());
}));

publicBroadcastRouter.get('/public', asyncRoute(async (_req, res) => {
    const now = new Date();
    const [storedSettings, programs, tickers, partners, status] = await Promise.all([
        prisma.broadcastSettings.findUnique({ where: { id: 'default' } }),
        prisma.broadcastProgram.findMany({
            where: {
                published: true,
                AND: [
                    { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
                    { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
                ],
            },
            orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
            include: {
                course: { select: { id: true, name: true } },
                lesson: { select: { id: true, title: true } },
            },
        }),
        prisma.broadcastTicker.findMany({
            where: {
                active: true,
                AND: [
                    { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
                    { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
                ],
            },
            orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
        }),
        prisma.broadcastPartner.findMany({
            where: { active: true },
            orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
        }),
        readBroadcastRuntimeStatus(),
    ]);
    const settings = storedSettings ?? defaultBroadcastSettings();

    res.json({
        settings: serializeSettings(settings),
        programs: programs.map(serializeProgram),
        tickers: tickers.map(serializeTicker),
        ticker: tickers.map(serializeTicker),
        partners: partners.map(serializePartner),
        status,
    });
}));

adminBroadcastRouter.use(authenticateToken, requireRole(['ADMIN']));

adminBroadcastRouter.get('/', asyncRoute(async (_req, res) => {
    const [settings, programs, tickers, partners, status] = await Promise.all([
        ensureBroadcastSettings(),
        prisma.broadcastProgram.findMany({
            orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
            include: {
                course: { select: { id: true, name: true } },
                lesson: { select: { id: true, title: true } },
            },
        }),
        prisma.broadcastTicker.findMany({ orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] }),
        prisma.broadcastPartner.findMany({ orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] }),
        readBroadcastRuntimeStatus(),
    ]);
    res.json({
        settings: serializeSettings(settings),
        programs: programs.map(serializeProgram),
        tickers: tickers.map(serializeTicker),
        ticker: tickers.map(serializeTicker),
        partners: partners.map(serializePartner),
        status,
    });
}));

adminBroadcastRouter.put('/', asyncRoute(async (req, res) => {
    const current = await ensureBroadcastSettings();
    const data = validateSettings(req.body, current);
    const settings = await prisma.broadcastSettings.upsert({
        where: { id: 'default' },
        create: { id: 'default', ...data },
        update: data,
    });
    await audit(req, 'BROADCAST_SETTINGS_UPDATE', settings.id, 'Atualizou as configuracoes do Campus ao vivo.');
    res.json(serializeSettings(settings));
}));

adminBroadcastRouter.get('/programs', asyncRoute(async (_req, res) => {
    const programs = await prisma.broadcastProgram.findMany({
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
        include: {
            course: { select: { id: true, name: true } },
            lesson: { select: { id: true, title: true } },
        },
    });
    res.json({ programs: programs.map(serializeProgram), items: programs.map(serializeProgram) });
}));

adminBroadcastRouter.post('/upload-video', uploadVideo.single('video'), async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!req.file) throw new BroadcastHttpError(400, 'Nenhum vídeo enviado.');
        if (!await validateUploadedVideo(req.file.path)) {
            throw new BroadcastHttpError(400, 'O arquivo enviado não contém um vídeo válido.');
        }
        const r2Url = await uploadFileToStorage(req.file.path, 'videos/broadcast', req.file.filename, req.file.mimetype);
        await removeUploadedFile(req.file.path);
        res.json({ url: r2Url });
    } catch (error) {
        if (req.file) await removeUploadedFile(req.file.path).catch(() => {});
        next(error);
    }
});

adminBroadcastRouter.post('/programs', asyncRoute(async (req, res) => {
    const data = await validateProgram(req.body);
    const program = await prisma.broadcastProgram.create({ data });
    await audit(req, 'BROADCAST_PROGRAM_CREATE', program.id, `Criou programa ${program.title}.`);
    res.status(201).json(serializeProgram(program));
}));

adminBroadcastRouter.put('/programs/:id', asyncRoute(async (req, res) => {
    const id = requiredUuid(req.params.id, 'id');
    await ensureProgram(id);
    const data = await validateProgram(req.body);
    const program = await prisma.broadcastProgram.update({ where: { id }, data });
    await audit(req, 'BROADCAST_PROGRAM_UPDATE', id, `Atualizou programa ${program.title}.`);
    res.json(serializeProgram(program));
}));

adminBroadcastRouter.delete('/programs/:id', asyncRoute(async (req, res) => {
    const id = requiredUuid(req.params.id, 'id');
    const deleted = await prisma.broadcastProgram.deleteMany({ where: { id } });
    if (!deleted.count) throw new BroadcastHttpError(404, 'Programa nao encontrado.');
    await audit(req, 'BROADCAST_PROGRAM_DELETE', id, 'Removeu programa da grade.');
    res.status(204).send();
}));

const listTickers: RequestHandler = asyncRoute(async (_req, res) => {
    const tickers = await prisma.broadcastTicker.findMany({ orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] });
    const serialized = tickers.map(serializeTicker);
    res.json({ tickers: serialized, ticker: serialized, items: serialized });
});
const createTicker: RequestHandler = asyncRoute(async (req, res) => {
    const ticker = await prisma.broadcastTicker.create({ data: validateTicker(req.body) });
    await audit(req, 'BROADCAST_TICKER_CREATE', ticker.id, 'Criou chamada no giro de noticias.');
    res.status(201).json(serializeTicker(ticker));
});
const updateTicker: RequestHandler = asyncRoute(async (req, res) => {
    const id = requiredUuid(req.params.id, 'id');
    const existing = await prisma.broadcastTicker.findUnique({ where: { id }, select: { id: true } });
    if (!existing) throw new BroadcastHttpError(404, 'Chamada nao encontrada.');
    const ticker = await prisma.broadcastTicker.update({ where: { id }, data: validateTicker(req.body) });
    await audit(req, 'BROADCAST_TICKER_UPDATE', id, 'Atualizou chamada no giro de noticias.');
    res.json(serializeTicker(ticker));
});
const deleteTicker: RequestHandler = asyncRoute(async (req, res) => {
    const id = requiredUuid(req.params.id, 'id');
    const deleted = await prisma.broadcastTicker.deleteMany({ where: { id } });
    if (!deleted.count) throw new BroadcastHttpError(404, 'Chamada nao encontrada.');
    await audit(req, 'BROADCAST_TICKER_DELETE', id, 'Removeu chamada do giro de noticias.');
    res.status(204).send();
});

// O frontend consolidado usa /ticker; /tickers permanece como alias sem duplicar logica.
for (const base of ['/ticker', '/tickers']) {
    adminBroadcastRouter.get(base, listTickers);
    adminBroadcastRouter.post(base, createTicker);
    adminBroadcastRouter.put(`${base}/:id`, updateTicker);
    adminBroadcastRouter.delete(`${base}/:id`, deleteTicker);
}

adminBroadcastRouter.get('/partners', asyncRoute(async (_req, res) => {
    const partners = await prisma.broadcastPartner.findMany({ orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] });
    const serialized = partners.map(serializePartner);
    res.json({ partners: serialized, items: serialized });
}));

adminBroadcastRouter.post('/partners', asyncRoute(async (req, res) => {
    const partner = await prisma.broadcastPartner.create({ data: validatePartner(req.body) });
    await audit(req, 'BROADCAST_PARTNER_CREATE', partner.id, `Criou parceiro ${partner.name}.`);
    res.status(201).json(serializePartner(partner));
}));

adminBroadcastRouter.put('/partners/:id', asyncRoute(async (req, res) => {
    const id = requiredUuid(req.params.id, 'id');
    const existing = await prisma.broadcastPartner.findUnique({ where: { id }, select: { id: true } });
    if (!existing) throw new BroadcastHttpError(404, 'Parceiro nao encontrado.');
    const partner = await prisma.broadcastPartner.update({ where: { id }, data: validatePartner(req.body) });
    await audit(req, 'BROADCAST_PARTNER_UPDATE', id, `Atualizou parceiro ${partner.name}.`);
    res.json(serializePartner(partner));
}));

adminBroadcastRouter.delete('/partners/:id', asyncRoute(async (req, res) => {
    const id = requiredUuid(req.params.id, 'id');
    const deleted = await prisma.broadcastPartner.deleteMany({ where: { id } });
    if (!deleted.count) throw new BroadcastHttpError(404, 'Parceiro nao encontrado.');
    await audit(req, 'BROADCAST_PARTNER_DELETE', id, 'Removeu parceiro do Campus ao vivo.');
    res.status(204).send();
}));

internalBroadcastRouter.use(express.urlencoded({ extended: false, limit: '16kb' }));
internalBroadcastRouter.post('/rtmp/authorize', authorizeRtmpRequest);
internalBroadcastRouter.post('/broadcast/authorize', authorizeRtmpRequest);

export function authorizeRtmpPublication(
    payload: Record<string, unknown>,
    query: Record<string, unknown>,
    environment: NodeJS.ProcessEnv = process.env,
): { allowed: boolean; streamName: string } {
    const rawName = textValue(payload.name);
    const [streamName = '', nameQuery = ''] = rawName.split('?', 2);
    const argumentsValue = textValue(payload.args);
    const directToken = textValue(payload.token) || textValue(query.token);
    const token = directToken
        || new URLSearchParams(argumentsValue).get('token')
        || new URLSearchParams(nameQuery).get('token')
        || '';
    const expected = streamName === 'stream'
        ? environment.RTMP_STREAM_KEY?.trim()
        : streamName === 'loop'
            ? environment.LOOP_STREAM_KEY?.trim()
            : undefined;

    return { allowed: Boolean(expected && token && safeEqual(token, expected)), streamName };
}

export async function readBroadcastRuntimeStatus(
    environment: NodeJS.ProcessEnv = process.env,
    fetchImplementation: typeof fetch = fetch,
) {
    const configuredUrl = environment.BROADCAST_INTERNAL_URL?.trim().replace(/\/$/, '');
    if (!configuredUrl) {
        return { live: false, loop: false, available: false, source: 'not-configured', checkedAt: new Date() };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1_500);
    try {
        const response = await fetchImplementation(`${configuredUrl}/stat`, {
            headers: { Accept: 'application/xml' },
            signal: controller.signal,
        });
        if (!response.ok) throw new Error('broadcast status unavailable');
        const declaredLength = Number(response.headers.get('content-length') ?? 0);
        if (declaredLength > MAX_RTMP_STATUS_BYTES) throw new Error('broadcast status payload too large');
        const body = await response.text();
        const status = parseNginxRtmpStatus(body);
        if (!status.valid) throw new Error('invalid nginx-rtmp status payload');
        return {
            live: status.live,
            loop: status.loop,
            available: true,
            source: 'nginx-rtmp-stat',
            checkedAt: new Date(),
        };
    } catch {
        return { live: false, loop: false, available: false, source: 'nginx-rtmp-stat', checkedAt: new Date() };
    } finally {
        clearTimeout(timeout);
    }
}

const MAX_RTMP_STATUS_BYTES = 512 * 1024;

/**
 * Interpreta apenas o subconjunto do XML emitido por `rtmp_stat all` que
 * precisamos. Um stream so e considerado ativo quando tem um publisher; isso
 * evita que playlist HLS residual ou um consumidor isolado sinalize "ao vivo".
 */
export function parseNginxRtmpStatus(xml: string): { valid: boolean; live: boolean; loop: boolean } {
    if (typeof xml !== 'string' || xml.length > MAX_RTMP_STATUS_BYTES) {
        return { valid: false, live: false, loop: false };
    }
    if (!/<rtmp(?:\s[^>]*)?>[\s\S]*<\/rtmp\s*>/i.test(xml)) {
        return { valid: false, live: false, loop: false };
    }

    const activeNames = new Set<string>();
    for (const applicationMatch of xml.matchAll(/<application(?:\s[^>]*)?>([\s\S]*?)<\/application\s*>/gi)) {
        const application = applicationMatch[1] ?? '';
        const applicationName = application.match(/<name(?:\s[^>]*)?>\s*([^<]+?)\s*<\/name\s*>/i)?.[1]?.trim();
        if (applicationName !== 'live') continue;

        const liveSection = application.match(/<live(?:\s[^>]*)?>([\s\S]*?)<\/live\s*>/i)?.[1] ?? '';
        for (const streamMatch of liveSection.matchAll(/<stream(?:\s[^>]*)?>([\s\S]*?)<\/stream\s*>/gi)) {
            const stream = streamMatch[1] ?? '';
            if (!/<publishing(?:\s[^>]*)?(?:\/>|>[\s\S]*?<\/publishing\s*>)/i.test(stream)) continue;
            const streamName = stream.match(/<name(?:\s[^>]*)?>\s*([^<]+?)\s*<\/name\s*>/i)?.[1]?.trim();
            if (streamName === 'stream' || streamName === 'loop') activeNames.add(streamName);
        }
    }

    return { valid: true, live: activeNames.has('stream'), loop: activeNames.has('loop') };
}

function authorizeRtmpRequest(req: Request, res: Response): void {
    const payload = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
    const query = req.query as Record<string, unknown>;
    const result = authorizeRtmpPublication(payload, query);
    if (!result.allowed) {
        logger.warn({ streamName: result.streamName || 'unknown', requestId: req.id }, 'Rejected RTMP publisher');
        res.status(403).send();
        return;
    }
    logger.info({ streamName: result.streamName, requestId: req.id }, 'Authorized RTMP publisher');
    res.status(204).send();
}

async function ensureBroadcastSettings() {
    return prisma.broadcastSettings.upsert({
        where: { id: 'default' },
        create: { id: 'default' },
        update: {},
    });
}

function defaultBroadcastSettings() {
    const now = new Date(0);
    return {
        id: 'default',
        companyName: 'EduVault TV',
        tagline: 'Conhecimento ao vivo',
        watermarkText: 'EduVault',
        logoUrl: null,
        backgroundUrl: null,
        accentColor: '#00c4b5',
        scheduleTitle: 'Programacao',
        tickerLabel: 'Agora',
        partnerLabel: 'Parceiros',
        liveSource: 'OBS' as const,
        liveYoutubeUrl: null,
        liveTitle: 'Ao vivo',
        liveDescription: null,
        loopTitle: 'Programacao continua',
        loopDescription: null,
        published: true,
        createdAt: now,
        updatedAt: now,
    };
}

function validateSettings(body: unknown, current: Awaited<ReturnType<typeof ensureBroadcastSettings>>) {
    const object = requireObject(body);
    rejectUnknownKeys(object, [
        'companyName', 'tagline', 'watermarkText', 'logoUrl', 'backgroundUrl', 'scheduleTitle',
        'tickerLabel', 'partnerLabel', 'liveSource', 'liveYoutubeUrl', 'liveTitle',
        'liveDescription', 'loopTitle', 'loopDescription', 'published', 'accentColor',
        'title', 'description', 'posterUrl', 'liveUrl', 'loopUrl',
    ]);
    return {
        companyName: requiredText(object.companyName ?? object.title ?? current.companyName, 'companyName', 160),
        tagline: requiredText(object.tagline ?? object.description ?? current.tagline, 'tagline', 300),
        watermarkText: requiredText(object.watermarkText ?? current.watermarkText, 'watermarkText', 300),
        logoUrl: object.logoUrl === undefined ? current.logoUrl : nullableAssetUrl(object.logoUrl, 'logoUrl'),
        backgroundUrl: object.backgroundUrl === undefined && object.posterUrl === undefined
            ? current.backgroundUrl
            : nullableAssetUrl(object.backgroundUrl ?? object.posterUrl, 'backgroundUrl'),
        accentColor: colorValue(object.accentColor ?? current.accentColor, 'accentColor'),
        scheduleTitle: requiredText(object.scheduleTitle ?? current.scheduleTitle, 'scheduleTitle', 160),
        tickerLabel: requiredText(object.tickerLabel ?? current.tickerLabel, 'tickerLabel', 80),
        partnerLabel: requiredText(object.partnerLabel ?? current.partnerLabel, 'partnerLabel', 80),
        liveSource: enumValue(object.liveSource ?? current.liveSource, 'liveSource', ['OBS', 'YOUTUBE'] as const),
        liveYoutubeUrl: object.liveYoutubeUrl === undefined ? current.liveYoutubeUrl : nullableHttpsUrl(object.liveYoutubeUrl, 'liveYoutubeUrl'),
        liveTitle: requiredText(object.liveTitle ?? current.liveTitle, 'liveTitle', 160),
        liveDescription: object.liveDescription === undefined ? current.liveDescription : nullableText(object.liveDescription, 'liveDescription', 2_000),
        loopTitle: requiredText(object.loopTitle ?? current.loopTitle, 'loopTitle', 160),
        loopDescription: object.loopDescription === undefined ? current.loopDescription : nullableText(object.loopDescription, 'loopDescription', 2_000),
        published: object.published === undefined ? current.published : booleanValue(object.published, 'published'),
    };
}

async function validateProgram(body: unknown) {
    const object = requireObject(body);
    rejectUnknownKeys(object, [
        'title', 'description', 'desc', 'sourceType', 'sourceUrl', 'video', 'category', 'position',
        'published', 'active', 'startsAt', 'startAt', 'endsAt', 'endAt', 'courseId', 'lessonId', 'videoId',
        'posterUrl', 'order',
    ]);
    const sourceUrl = requiredText(object.sourceUrl ?? object.video, 'sourceUrl', 2_048);
    validateProgramSourceUrl(sourceUrl);
    const courseId = optionalUuid(object.courseId, 'courseId');
    const lessonId = optionalUuid(object.lessonId ?? object.videoId, 'lessonId');
    const startsAt = nullableDate(object.startsAt ?? object.startAt, 'startsAt');
    const endsAt = nullableDate(object.endsAt ?? object.endAt, 'endsAt');
    if (startsAt && endsAt && endsAt <= startsAt) {
        throw new BroadcastHttpError(400, 'endsAt deve ser posterior a startsAt.');
    }
    await validateProgramRelations(courseId, lessonId);

    return {
        title: requiredText(object.title, 'title', 160),
        description: nullableText(object.description ?? object.desc, 'description', 2_000),
        sourceType: object.sourceType === undefined
            ? inferSourceType(sourceUrl)
            : enumValue(object.sourceType, 'sourceType', ['LIVE', 'VIDEO', 'YOUTUBE', 'EXTERNAL'] as const),
        sourceUrl,
        posterUrl: nullableAssetUrl(object.posterUrl, 'posterUrl'),
        category: nullableText(object.category, 'category', 100),
        position: integerValue(object.position ?? object.order, 'position', 0, 1_000_000),
        published: booleanValue(object.published ?? object.active, 'published'),
        startsAt,
        endsAt,
        courseId: courseId ?? null,
        lessonId: lessonId ?? null,
    };
}

function validateTicker(body: unknown) {
    const object = requireObject(body);
    rejectUnknownKeys(object, ['text', 'href', 'position', 'order', 'active', 'startsAt', 'startAt', 'endsAt', 'endAt']);
    const startsAt = nullableDate(object.startsAt ?? object.startAt, 'startsAt');
    const endsAt = nullableDate(object.endsAt ?? object.endAt, 'endsAt');
    if (startsAt && endsAt && endsAt <= startsAt) {
        throw new BroadcastHttpError(400, 'endsAt deve ser posterior a startsAt.');
    }
    return {
        text: requiredText(object.text, 'text', 500),
        href: nullableHttpsUrl(object.href, 'href'),
        position: integerValue(object.position ?? object.order, 'position', 0, 1_000_000),
        active: booleanValue(object.active, 'active'),
        startsAt,
        endsAt,
    };
}

function validatePartner(body: unknown) {
    const object = requireObject(body);
    rejectUnknownKeys(object, ['name', 'logoUrl', 'destinationUrl', 'position', 'order', 'active']);
    return {
        name: requiredText(object.name, 'name', 160),
        logoUrl: requiredAssetUrl(object.logoUrl, 'logoUrl'),
        destinationUrl: requiredHttpsUrl(object.destinationUrl, 'destinationUrl'),
        position: integerValue(object.position ?? object.order, 'position', 0, 1_000_000),
        active: booleanValue(object.active, 'active'),
    };
}

async function validateProgramRelations(courseId?: string, lessonId?: string) {
    if (lessonId) {
        const lesson = await prisma.video.findUnique({
            where: { id: lessonId },
            select: { module: { select: { courseId: true } } },
        });
        if (!lesson) throw new BroadcastHttpError(404, 'Aula vinculada nao encontrada.');
        if (courseId && lesson.module.courseId !== courseId) {
            throw new BroadcastHttpError(400, 'A aula vinculada nao pertence ao curso informado.');
        }
    } else if (courseId) {
        const course = await prisma.course.findUnique({ where: { id: courseId }, select: { id: true } });
        if (!course) throw new BroadcastHttpError(404, 'Curso vinculado nao encontrado.');
    }
}

async function ensureProgram(id: string) {
    const program = await prisma.broadcastProgram.findUnique({ where: { id }, select: { id: true } });
    if (!program) throw new BroadcastHttpError(404, 'Programa nao encontrado.');
}

interface BroadcastSettingsView {
    companyName?: string;
    tagline?: string;
    backgroundUrl?: string | null;
    logoUrl?: string | null;
    accentColor?: string;
    liveSource?: string;
    liveYoutubeUrl?: string | null;
    liveTitle?: string;
    loopTitle?: string;
}

export function serializeSettings<T extends BroadcastSettingsView>(settings: T) {
    const configuredLiveUrl = settings.liveSource === 'YOUTUBE' && settings.liveYoutubeUrl
        ? settings.liveYoutubeUrl
        : '/broadcast/hls/stream.m3u8';
    return {
        ...settings,
        title: settings.companyName ?? 'Campus ao Vivo',
        description: settings.tagline ?? '',
        liveUrl: safeMediaViewUrl(configuredLiveUrl, '/broadcast/hls/stream.m3u8'),
        loopUrl: '/broadcast/hls/loop.m3u8',
        posterUrl: settings.backgroundUrl ?? '',
        logoUrl: settings.logoUrl ?? '',
        accentColor: settings.accentColor ?? '#00c4b5',
        liveTitle: settings.liveTitle ?? 'Campus ao vivo agora',
        loopTitle: settings.loopTitle ?? 'Programacao continua',
    };
}

interface BroadcastProgramView {
    sourceUrl: string;
    description: string | null;
    startsAt?: Date | string | null;
    endsAt?: Date | string | null;
    published?: boolean;
    position?: number;
}

export function serializeProgram<T extends BroadcastProgramView>(program: T) {
    return {
        ...program,
        video: program.sourceUrl,
        desc: program.description,
        startAt: program.startsAt ?? null,
        endAt: program.endsAt ?? null,
        active: program.published ?? true,
        order: program.position ?? 0,
    };
}

interface BroadcastOrderedView {
    position?: number;
    active?: boolean;
}

export function serializeTicker<T extends BroadcastOrderedView>(ticker: T) {
    return { ...ticker, order: ticker.position ?? 0, active: ticker.active ?? true };
}

export function serializePartner<T extends BroadcastOrderedView & { destinationUrl?: string }>(partner: T) {
    return {
        ...partner,
        order: partner.position ?? 0,
        active: partner.active ?? true,
        url: partner.destinationUrl ?? '',
    };
}

function safeMediaViewUrl(value: string | null | undefined, fallback: string): string {
    if (!value) return fallback;
    if (/^\/broadcast\/hls\/[a-zA-Z0-9._/-]+$/.test(value)) return value;
    try {
        if (new URL(value).protocol === 'https:') return value;
    } catch {
        // Configuracao legada invalida e substituida pelo endpoint interno seguro.
    }
    return fallback;
}

async function audit(req: Request, action: string, target: string, details: string) {
    await prisma.auditLog.create({ data: { userId: req.user!.id, action, target, details } });
}

function safeEqual(left: string, right: string): boolean {
    const leftHash = createHash('sha256').update(left, 'utf8').digest();
    const rightHash = createHash('sha256').update(right, 'utf8').digest();
    return timingSafeEqual(leftHash, rightHash);
}

for (const targetRouter of [publicBroadcastRouter, adminBroadcastRouter, internalBroadcastRouter]) {
    targetRouter.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
        if (res.headersSent) return next(error);
        if (error instanceof BroadcastHttpError) {
            res.status(error.statusCode).json({ code: 'BROADCAST_REQUEST_ERROR', message: error.safeMessage });
            return;
        }
        logger.error({ err: error, requestId: req.id }, 'Unhandled broadcast route error');
        res.status(500).json({ code: 'BROADCAST_INTERNAL_ERROR', message: 'Nao foi possivel concluir a operacao do Campus ao vivo.' });
    });
}

function integerValue(value: unknown, field: string, minimum: number, maximum: number): number {
    const normalized = value === undefined || value === null || value === '' ? minimum : Number(value);
    if (!Number.isInteger(normalized) || normalized < minimum || normalized > maximum) {
        throw new BroadcastHttpError(400, `${field} deve ser um inteiro entre ${minimum} e ${maximum}.`);
    }
    return normalized;
}

function booleanValue(value: unknown, field: string): boolean {
    if (value === undefined) return true;
    if (typeof value !== 'boolean') throw new BroadcastHttpError(400, `${field} deve ser booleano.`);
    return value;
}

function colorValue(value: unknown, field: string): string {
    if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value.trim())) {
        throw new BroadcastHttpError(400, `${field} deve usar o formato hexadecimal #RRGGBB.`);
    }
    return value.trim().toLowerCase();
}

function nullableDate(value: unknown, field: string): Date | null {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' && !(value instanceof Date)) throw new BroadcastHttpError(400, `${field} e invalido.`);
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw new BroadcastHttpError(400, `${field} e invalido.`);
    return date;
}

function requiredAssetUrl(value: unknown, field: string): string {
    const url = requiredText(value, field, 2_048);
    if (/^\/uploads\/images\/[a-zA-Z0-9._-]+$/.test(url)) return url;
    return assertHttps(url, field);
}

function nullableAssetUrl(value: unknown, field: string): string | null {
    if (value === undefined || value === null || value === '') return null;
    return requiredAssetUrl(value, field);
}

function requiredHttpsUrl(value: unknown, field: string): string {
    return assertHttps(requiredText(value, field, 2_048), field);
}

function nullableHttpsUrl(value: unknown, field: string): string | null {
    if (value === undefined || value === null || value === '') return null;
    return requiredHttpsUrl(value, field);
}

function assertHttps(value: string, field: string): string {
    try {
        if (new URL(value).protocol === 'https:') return value;
    } catch {
        // Tratado pela mensagem unica abaixo.
    }
    throw new BroadcastHttpError(400, `${field} deve usar HTTPS.`);
}

function validateProgramSourceUrl(value: string) {
    if (/^(?:\/videos\/|\/broadcast\/hls\/)[a-zA-Z0-9._/-]+$/.test(value)) return;
    assertHttps(value, 'sourceUrl');
}

function inferSourceType(value: string): 'LIVE' | 'VIDEO' | 'YOUTUBE' | 'EXTERNAL' {
    if (value.startsWith('/broadcast/hls/')) return 'LIVE';
    if (value.startsWith('/videos/')) return 'VIDEO';
    try {
        const host = new URL(value).hostname.toLowerCase();
        if (host === 'youtu.be' || host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) return 'YOUTUBE';
    } catch {
        return 'VIDEO';
    }
    return 'EXTERNAL';
}

function textValue(value: unknown): string {
    return typeof value === 'string' ? value : '';
}
