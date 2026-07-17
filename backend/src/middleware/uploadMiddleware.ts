/**
 * uploadMiddleware.ts — Middleware de Upload de Vídeo (Multer)
 *
 * Configuração:
 * - Destino: VIDEO_STORAGE_PATH (padrão: ./uploads/videos)
 * - Nomes únicos: UUID + extensão original para evitar conflitos
 * - Filtro: Aceita apenas arquivos com mimetype video/*
 * - Limite: 500MB por arquivo
 */
import multer from 'multer';
import path from 'path';
import { randomUUID } from 'crypto';
import { Request } from 'express';
import fsp from 'fs/promises';

const ALLOWED_VIDEO_EXTENSIONS = new Set([
    '.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi', '.mpeg', '.mpg', '.ts', '.ogv', '.flv'
]);
const ALLOWED_VIDEO_MIME_TYPES = new Set([
    'video/mp4', 'video/x-m4v', 'video/quicktime', 'video/webm',
    'video/x-matroska', 'video/x-msvideo', 'video/mpeg', 'video/mp2t',
    'video/ogg', 'video/x-flv'
]);

const storage = multer.diskStorage({
    destination: (_req, _file, cb) => {
        cb(null, process.env.VIDEO_STORAGE_PATH || './uploads/videos');
    },
    filename: (_req, file, cb) => {
        // Generate unique filename to prevent overrides
        const extension = path.extname(file.originalname).toLowerCase();
        const uniqueSuffix = randomUUID() + extension;
        cb(null, file.fieldname + '-' + uniqueSuffix);
    }
});

// ISSUE-12: Tipagem correta (não usa `any`)
const fileFilter = (_req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_VIDEO_EXTENSIONS.has(extension) && ALLOWED_VIDEO_MIME_TYPES.has(file.mimetype.toLowerCase())) {
        cb(null, true);
    } else {
        cb(new Error('Formato de arquivo não suportado. Envie apenas vídeos.'));
    }
};

export const uploadVideo = multer({
    storage: storage,
    fileFilter: fileFilter,
    limits: {
        // ISSUE-11: Limite reduzido para 500MB (mais realista para a maioria dos servidores)
        fileSize: 1024 * 1024 * 500
    }
});

import { execFile } from 'child_process';
import { promisify } from 'util';

const executeFile = promisify(execFile);
const ffprobeBinary = process.env.FFPROBE_PATH?.trim() || 'ffprobe';

export async function validateUploadedVideo(filePath: string): Promise<boolean> {
    try {
        const { stdout } = await executeFile(
            ffprobeBinary,
            ['-v', 'error', '-show_entries', 'stream=codec_type', '-show_entries', 'format=duration', '-of', 'json', filePath],
            { timeout: 20000, maxBuffer: 1000000, windowsHide: true }
        );
        const probe = JSON.parse(stdout) as { streams?: Array<{ codec_type?: string }>; format?: { duration?: string } };
        const hasVideo = probe.streams?.some((stream) => stream.codec_type === 'video');
        const duration = Number(probe.format?.duration);
        if (!hasVideo || !Number.isFinite(duration) || duration <= 0) {
            return false;
        }
        return true;
    } catch {
        return false;
    }
}

export async function removeUploadedFile(filePath?: string): Promise<void> {
    if (!filePath) return;
    await fsp.unlink(filePath).catch(() => undefined);
}
