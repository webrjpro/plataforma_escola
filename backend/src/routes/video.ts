/**
 * video.ts — Upload e Listagem de Vídeos
 *
 * Endpoints:
 * - POST /upload           → Upload de vídeo (Admin/Teacher), enfileira processamento FFmpeg
 * - GET  /module/:moduleId → Lista vídeos de um módulo (valida enrollment para STUDENT)
 *
 * Fluxo de upload: Multer salva mp4 → cria registro PENDING → pg-boss enfileira → FFmpeg converte HLS
 */
import { Router, Request, Response } from 'express';
import { authenticateToken, requireRole } from '../middleware/authMiddleware';
import { removeUploadedFile, uploadVideo, validateUploadedVideo } from '../middleware/uploadMiddleware';
import { enqueueVideoProcessing } from '../config/pgBoss';
import prisma from '../lib/prisma';
import logger from '../lib/logger';

const router = Router();

// Only ADMIN or TEACHER can upload videos
router.post('/upload',
    authenticateToken,
    requireRole(['ADMIN', 'TEACHER']),
    uploadVideo.single('video'),
    async (req: Request, res: Response): Promise<void> => {
        let persisted = false;
        let persistedVideoId: string | null = null;
        try {
            const { title, description, moduleId } = req.body;
            const file = req.file;

            if (!file) {
                res.status(400).json({ message: 'O arquivo de vídeo é obrigatório. req.file está undefined.' });
                return;
            }

            if (typeof title !== 'string' || typeof moduleId !== 'string'
                || !title.trim() || title.trim().length > 200 || moduleId.length > 64) {
                await removeUploadedFile(file.path);
                res.status(400).json({ message: 'Título e ID do módulo são obrigatórios e devem estar em formato válido.' });
                return;
            }
            if (description !== undefined && (typeof description !== 'string' || description.length > 5000)) {
                await removeUploadedFile(file.path);
                res.status(400).json({ message: 'Descrição inválida (máximo de 5.000 caracteres).' });
                return;
            }

            if (!await validateUploadedVideo(file.path)) {
                await removeUploadedFile(file.path);
                res.status(415).json({ message: 'O conteúdo do arquivo não corresponde a um formato de vídeo aceito.' });
                return;
            }

            const targetModule = await prisma.module.findUnique({
                where: { id: moduleId },
                select: { id: true, courseId: true }
            });
            if (!targetModule) {
                await removeUploadedFile(file.path);
                res.status(404).json({ message: 'Módulo não encontrado.' });
                return;
            }
            if (req.user!.role === 'TEACHER') {
                const assignment = await prisma.courseEnrollment.findUnique({
                    where: { userId_courseId: { userId: req.user!.id, courseId: targetModule.courseId } },
                    select: { id: true, enrollmentRole: true }
                });
                if (assignment?.enrollmentRole !== 'TEACHER') {
                    await removeUploadedFile(file.path);
                    res.status(403).json({ message: 'Professor não está atribuído ao curso deste módulo.' });
                    return;
                }
            }

            // 1. Criar registro do vídeo no banco com status PENDING
            const video = await prisma.video.create({
                data: {
                    title: title.trim(),
                    description: typeof description === 'string' ? description.trim() || null : null,
                    moduleId,
                    originalUrl: file.path,
                    status: 'PENDING'
                }
            });
            persisted = true;
            persistedVideoId = video.id;

            // 2. Colocar na fila do pg-boss
            await enqueueVideoProcessing(video.id, file.path);

            res.status(201).json({
                message: 'Vídeo enviado com sucesso e adicionado à fila de processamento.',
                video
            });
        } catch (error) {
            if (!persisted) await removeUploadedFile(req.file?.path);
            if (persistedVideoId) {
                await prisma.video.update({
                    where: { id: persistedVideoId },
                    data: { status: 'ERROR' }
                }).catch(() => undefined);
            }
            logger.error({ error, userId: req.user?.id }, 'Falha no upload de vídeo');
            res.status(500).json({ message: 'Erro ao realizar upload do vídeo.' });
        }
    });

// Listar vídeos de um módulo específico (com verificação de enrollment)
router.get('/module/:moduleId', authenticateToken, async (req: Request, res: Response): Promise<void> => {
    try {
        const moduleId = req.params.moduleId as string;
        const userId = req.user!.id;
        const userRole = req.user!.role;

        if (userRole === 'STUDENT') {
            // Verificar se o aluno está matriculado no curso que contém este módulo
            const moduleWithCourse = await prisma.module.findUnique({
                where: { id: moduleId },
                select: { courseId: true }
            });

            if (!moduleWithCourse) {
                res.status(404).json({ message: 'Módulo não encontrado.' });
                return;
            }

            const enrollment = await prisma.courseEnrollment.findUnique({
                where: { userId_courseId: { userId, courseId: moduleWithCourse.courseId } }
            });

            if (!enrollment) {
                res.status(403).json({ message: 'Acesso negado. Você não está matriculado neste curso.' });
                return;
            }
        } else if (userRole === 'TEACHER') {
            const moduleWithCourse = await prisma.module.findUnique({
                where: { id: moduleId },
                select: { courseId: true }
            });
            if (!moduleWithCourse) {
                res.status(404).json({ message: 'Módulo não encontrado.' });
                return;
            }
            const assignment = await prisma.courseEnrollment.findUnique({
                where: { userId_courseId: { userId, courseId: moduleWithCourse.courseId } },
                select: { id: true, enrollmentRole: true }
            });
            if (assignment?.enrollmentRole !== 'TEACHER') {
                res.status(403).json({ message: 'Professor não está atribuído a este curso.' });
                return;
            }
        }

        const videos = await prisma.video.findMany({
            where: { moduleId },
            orderBy: { order: 'asc' }
        });

        res.json(videos);
    } catch (error) {
        res.status(500).json({ message: 'Erro ao listar vídeos.' });
    }
});

export default router;
