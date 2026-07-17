/**
 * admin.ts — Painel Administrativo (CRUD Completo)
 *
 * Seções:
 * 1. USERS       → Listar, Criar, Editar, Deletar (com guard anti self-delete)
 * 2. COURSES     → Listar, Criar, Editar, Deletar (cascade + disk cleanup + thumbnailUrl)
 * 3. MODULES     → Criar, Editar, Deletar (cascade + disk cleanup)
 * 4. ENROLLMENTS → Matricular aluno em curso, Remover matrícula
 * 5. VIDEOS      → Listar, Editar (title/description/content/thumbnailUrl), Deletar (disk cleanup)
 * 6. IMAGES      → Upload de imagens (thumbnails + conteúdo rico) via Multer
 * 7. STATS       → Dashboard com contadores (alunos, cursos, vídeos por status)
 *
 * Acesso: Todas as rotas exigem role ADMIN (exceto algumas que aceitam TEACHER)
 * Validações: Role contra enum, email único, bcrypt 12 rounds
 */
import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import multer from 'multer';
import { randomUUID } from 'crypto';
import { authenticateToken, requireRole } from '../middleware/authMiddleware';
import { enqueueVideoProcessing } from '../config/pgBoss';
import prisma from '../lib/prisma';
import { invalidateConfigCache } from './config';
import logger from '../lib/logger';
import { uploadFileToStorage } from '../lib/storage';
import {
    isPdfFile,
    isSafeWebImage,
    isSpreadsheetFile,
    removeFileQuietly,
} from '../lib/fileValidation';
import {
    getEmailConfigurationStatus,
    isEmailConfigured,
    sendBulkEmails,
    sendGenericEmail,
    sendResetPasswordEmail
} from '../lib/email';
import ExcelJS from 'exceljs';
import {
    importStudentsFromWorkbook,
    isDeliverableEmailAddress,
    StudentImportInputError,
} from '../modules/admin/studentImport';
import { attemptEmailDelivery, auditLog } from '../modules/admin/adminSupport';
import { passwordValidationMessage } from '../modules/admin/userAdminPolicy';
import userAdminRouter from '../modules/admin/userAdminRouter';

// ============================================================
// HELPER: Verificar se TEACHER tem acesso ao curso
// ============================================================
// Retorna true se o usuário é ADMIN (acesso total) ou TEACHER matriculado como TEACHER no curso
async function canAccessCourse(userId: string, role: string, courseId: string): Promise<boolean> {
    if (role === 'ADMIN') return true;
    const enrollment = await prisma.courseEnrollment.findUnique({
        where: { userId_courseId: { userId, courseId } }
    });
    return enrollment?.enrollmentRole === 'TEACHER';
}

// Verifica acesso ao módulo via courseId do módulo
async function canAccessModule(userId: string, role: string, moduleId: string): Promise<boolean> {
    if (role === 'ADMIN') return true;
    const mod = await prisma.module.findUnique({ where: { id: moduleId }, select: { courseId: true } });
    if (!mod) return false;
    return canAccessCourse(userId, role, mod.courseId);
}

// Verifica acesso ao vídeo via moduleId → courseId
async function canAccessVideo(userId: string, role: string, videoId: string): Promise<boolean> {
    if (role === 'ADMIN') return true;
    const video = await prisma.video.findUnique({
        where: { id: videoId },
        select: { module: { select: { courseId: true } } }
    });
    if (!video) return false;
    return canAccessCourse(userId, role, video.module.courseId);
}

async function requireModuleAccess(req: Request, res: Response, moduleId: string): Promise<boolean> {
    if (await canAccessModule(req.user!.id, req.user!.role, moduleId)) return true;
    res.status(403).json({ message: 'Acesso negado a este módulo.' });
    return false;
}

async function requireLiveClass(id: string, res: Response) {
    const liveClass = await prisma.liveClass.findUnique({ where: { id } });
    if (!liveClass) res.status(404).json({ message: 'Aula ao vivo não encontrada.' });
    return liveClass;
}

function createUploadStorage(resolveDirectory: () => string): multer.StorageEngine {
    return multer.diskStorage({
        destination: (_req, _file, cb) => {
            const directory = resolveDirectory();
            if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
            cb(null, directory);
        },
        filename: (_req, file, cb) => {
            cb(null, randomUUID() + path.extname(file.originalname));
        },
    });
}

interface VideoFileReference {
    id: string;
    originalUrl: string | null;
}

async function cleanupVideoFiles(videos: VideoFileReference[]): Promise<void> {
    const hlsStorage = path.resolve(process.env.HLS_STORAGE_PATH || './uploads/hls');
    await Promise.all(videos.map(async (video) => {
        try {
            if (video.originalUrl) {
                await fsp.access(video.originalUrl).then(() => fsp.unlink(video.originalUrl!)).catch(() => {});
            }
            await fsp.rm(path.join(hlsStorage, video.id), { recursive: true, force: true }).catch(() => {});
        } catch (cleanupError) {
            console.error(`Aviso: falha ao limpar arquivos do vídeo ${video.id}:`, cleanupError);
        }
    }));
}

function pagination(query: Request['query'], defaultLimit: number, maximumLimit: number) {
    const page = Math.max(1, parseInt(query.page as string) || 1);
    const limit = Math.min(maximumLimit, Math.max(1, parseInt(query.limit as string) || defaultLimit));
    return { page, limit, skip: (page - 1) * limit };
}

// Image upload config
const imageStorage = createUploadStorage(
    () => path.resolve(process.env.IMAGE_STORAGE_PATH || './uploads/images'),
);
const uploadImage = multer({
    storage: imageStorage,
    fileFilter: (_req, file, cb) => {
        if (file.mimetype.startsWith('image/')) cb(null, true);
        else cb(new Error('Formato inválido. Apenas imagens são aceitas.'));
    },
    limits: { fileSize: 10 * 1024 * 1024 } // 10 MB
});

// Excel upload config (temp storage — file is read into memory then deleted)
const excelStorage = createUploadStorage(() => path.resolve('./uploads/temp'));
const uploadExcel = multer({
    storage: excelStorage,
    fileFilter: (_req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (ext === '.xlsx') cb(null, true);
        else cb(new Error('Formato inválido. Apenas arquivos .xlsx são aceitos.'));
    },
    limits: { fileSize: 10 * 1024 * 1024 }
});

// PDF upload config
const pdfStorage = createUploadStorage(
    () => path.resolve(process.env.PDF_STORAGE_PATH || './uploads/pdfs'),
);
const uploadPdf = multer({
    storage: pdfStorage,
    fileFilter: (_req, file, cb) => {
        if (file.mimetype === 'application/pdf') cb(null, true);
        else cb(new Error('Formato inválido. Apenas arquivos PDF são aceitos.'));
    },
    limits: { fileSize: 50 * 1024 * 1024 } // 50 MB
});

const router = Router();

router.get('/email/status', authenticateToken, requireRole(['ADMIN']), (_req: Request, res: Response): void => {
    res.json(getEmailConfigurationStatus());
});

// Gerenciamento de usuários é isolado para manter este roteador focado nos
// demais recursos administrativos. O sub-roteador preserva `/users/*`.
router.use('/users', userAdminRouter);

// ============================================================
// GERENCIAMENTO DE CURSOS
// ============================================================

// Listar cursos (com paginação)
router.get('/courses', authenticateToken, requireRole(['ADMIN', 'TEACHER']), async (req: Request, res: Response): Promise<void> => {
    try {
        const { page, limit, skip } = pagination(req.query, 20, 50);

        // TEACHER: filtra apenas cursos onde está matriculado como TEACHER
        const courseFilter = req.user!.role === 'TEACHER'
            ? { enrollments: { some: { userId: req.user!.id, enrollmentRole: 'TEACHER' as const } } }
            : {};

        const [courses, total] = await Promise.all([
            prisma.course.findMany({
                where: courseFilter,
                include: {
                    modules: { include: { videos: true }, orderBy: { order: 'asc' } },
                    enrollments: { include: { user: { select: { id: true, name: true, email: true, role: true } } } }
                },
                orderBy: { createdAt: 'desc' },
                skip,
                take: limit
            }),
            prisma.course.count({ where: courseFilter })
        ]);

        res.json({ data: courses, total, page, limit, totalPages: Math.ceil(total / limit) });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Erro ao listar cursos.' });
    }
});

// Criar curso
router.post('/courses', authenticateToken, requireRole(['ADMIN']), async (req: Request, res: Response): Promise<void> => {
    try {
        const { name, description, thumbnailUrl } = req.body;
        if (!name) {
            res.status(400).json({ message: 'Nome do curso é obrigatório.' });
            return;
        }
        const course = await prisma.course.create({ data: { name, description, thumbnailUrl } });
        await auditLog(req.user!.id, 'CREATE_COURSE', course.id, `Criou curso ${name}`);
        res.status(201).json(course);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Erro ao criar curso.' });
    }
});

// Reordenar cursos (DEVE vir antes de /courses/:id)
router.put('/courses/reorder', authenticateToken, requireRole(['ADMIN']), async (req: Request, res: Response): Promise<void> => {
    try {
        const { orders } = req.body; // [{ id: string, order: number }]
        if (!Array.isArray(orders)) {
            res.status(400).json({ message: 'Array de ordens é obrigatório.' });
            return;
        }

        await prisma.$transaction(
            orders.map((item: { id: string; order: number }) =>
                prisma.course.update({ where: { id: item.id }, data: { order: item.order } })
            )
        );

        res.json({ message: 'Ordem atualizada.' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Erro ao reordenar cursos.' });
    }
});

// Editar curso
router.put('/courses/:id', authenticateToken, requireRole(['ADMIN']), async (req: Request, res: Response): Promise<void> => {
    try {
        const id = req.params.id as string;
        const { name, description, thumbnailUrl, calendarUrl } = req.body;
        const data: Record<string, unknown> = {};
        if (name !== undefined) data.name = name;
        if (description !== undefined) data.description = description;
        if (thumbnailUrl !== undefined) data.thumbnailUrl = thumbnailUrl;
        if (calendarUrl !== undefined) data.calendarUrl = calendarUrl;
        const course = await prisma.course.update({ where: { id }, data });
        res.json(course);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Erro ao atualizar curso.' });
    }
});

// Deletar curso (transaction com cascade completo) — ISSUE-10/19: Disk cleanup fora da transaction
router.delete('/courses/:id', authenticateToken, requireRole(['ADMIN']), async (req: Request, res: Response): Promise<void> => {
    try {
        const id = req.params.id as string;

        // Coletar paths dos vídeos ANTES da transação
        const modules = await prisma.module.findMany({
            where: { courseId: id },
            select: { id: true }
        });
        const moduleIds = modules.map(m => m.id);

        let videosToClean: { id: string; originalUrl: string | null }[] = [];
        if (moduleIds.length > 0) {
            videosToClean = await prisma.video.findMany({
                where: { moduleId: { in: moduleIds } },
                select: { id: true, originalUrl: true }
            });
        }

        // Transação pura de banco (sem I/O)
        await prisma.$transaction(async (tx) => {
            if (moduleIds.length > 0) {
                await tx.videoHistory.deleteMany({
                    where: { video: { moduleId: { in: moduleIds } } }
                });
                await tx.video.deleteMany({
                    where: { moduleId: { in: moduleIds } }
                });
                await tx.module.deleteMany({ where: { courseId: id } });
            }
            await tx.courseEnrollment.deleteMany({ where: { courseId: id } });
            await tx.course.delete({ where: { id } });
        });

        // ISSUE-19: Cleanup de arquivos no disco FORA da transação (async)
        await cleanupVideoFiles(videosToClean);

        await auditLog(req.user!.id, 'DELETE_COURSE', id, `Deletou curso ${id} e ${videosToClean.length} vídeos`);
        res.json({ message: 'Curso e todos os dados associados foram removidos.' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Erro ao remover curso.' });
    }
});

// ============================================================
// GERENCIAMENTO DE MÓDULOS
// ============================================================

// Criar módulo dentro de um curso
router.post('/modules', authenticateToken, requireRole(['ADMIN', 'TEACHER']), async (req: Request, res: Response): Promise<void> => {
    try {
        const { name, courseId, order } = req.body;
        if (!name || !courseId) {
            res.status(400).json({ message: 'Nome e ID do curso são obrigatórios.' });
            return;
        }
        if (!await canAccessCourse(req.user!.id, req.user!.role, courseId)) {
            res.status(403).json({ message: 'Acesso negado a este curso.' });
            return;
        }
        const mod = await prisma.module.create({ data: { name, courseId, order: order || 0 } });
        res.status(201).json(mod);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Erro ao criar módulo.' });
    }
});

// Editar módulo
router.put('/modules/:id', authenticateToken, requireRole(['ADMIN', 'TEACHER']), async (req: Request, res: Response): Promise<void> => {
    try {
        const id = req.params.id as string;
        if (!await requireModuleAccess(req, res, id)) return;
        const { name, order, pdfUrl } = req.body;
        const data: Record<string, unknown> = {};
        if (name !== undefined) data.name = name;
        if (order !== undefined) data.order = order;
        if (pdfUrl !== undefined) data.pdfUrl = pdfUrl;
        const mod = await prisma.module.update({ where: { id }, data });
        res.json(mod);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Erro ao atualizar módulo.' });
    }
});

// ISSUE-16: Deletar módulo (com transaction + disk cleanup)
router.delete('/modules/:id', authenticateToken, requireRole(['ADMIN', 'TEACHER']), async (req: Request, res: Response): Promise<void> => {
    try {
        const id = req.params.id as string;
        if (!await requireModuleAccess(req, res, id)) return;
        // Coletar paths antes da transação
        const videosToClean = await prisma.video.findMany({
            where: { moduleId: id },
            select: { id: true, originalUrl: true }
        });

        await prisma.$transaction([
            prisma.videoHistory.deleteMany({ where: { video: { moduleId: id } } }),
            prisma.video.deleteMany({ where: { moduleId: id } }),
            prisma.module.delete({ where: { id } })
        ]);

        // Disk cleanup fora da transação (async)
        await cleanupVideoFiles(videosToClean);

        await auditLog(req.user!.id, 'DELETE_MODULE', id, `Removeu módulo e ${videosToClean.length} vídeos`);
        res.json({ message: 'Módulo removido com sucesso.' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Erro ao remover módulo.' });
    }
});

// ============================================================
// GERENCIAMENTO DE MATRÍCULAS (Enrollments)
// ============================================================

// Vincular aluno a curso
router.post('/enrollments', authenticateToken, requireRole(['ADMIN']), async (req: Request, res: Response): Promise<void> => {
    try {
        const { userId, courseId, enrollmentRole } = req.body;
        if (!userId || !courseId) {
            res.status(400).json({ message: 'ID do aluno e do curso são obrigatórios.' });
            return;
        }

        const validRoles = ['STUDENT', 'TEACHER'];
        const role = validRoles.includes(enrollmentRole) ? enrollmentRole : 'STUDENT';

        const existing = await prisma.courseEnrollment.findUnique({
            where: { userId_courseId: { userId, courseId } }
        });
        if (existing) {
            res.status(409).json({ message: 'Usuário já está matriculado neste curso.' });
            return;
        }

        // Se vinculando como TEACHER, garante que o user tem role TEACHER
        if (role === 'TEACHER') {
            const targetUser = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
            if (!targetUser || targetUser.role !== 'TEACHER') {
                res.status(400).json({ message: 'Apenas usuários com papel TEACHER podem ser vinculados como professor do curso.' });
                return;
            }
        }

        const enrollment = await prisma.courseEnrollment.create({
            data: { userId, courseId, enrollmentRole: role },
            include: { user: { select: { name: true, email: true } }, course: { select: { name: true } } }
        });

        const roleLabel = role === 'TEACHER' ? 'professor' : 'aluno';

        // Notificar
        await prisma.notification.create({
            data: { userId, title: 'Nova matrícula', message: `Você foi vinculado como ${roleLabel} no curso ${enrollment.course.name}.` }
        }).catch(() => {});

        const emailDelivery = await attemptEmailDelivery(() => sendGenericEmail(
            enrollment.user.email,
            `[${process.env.PLATFORM_NAME || 'EduVault'}] Nova matrícula`,
            `Olá, ${enrollment.user.name}!\n\nVocê foi vinculado como ${roleLabel} no curso ${enrollment.course.name}. Acesse a plataforma para consultar as aulas e atividades.`
        ), { action: 'ENROLL', userId, courseId }, enrollment.user.email);

        await auditLog(req.user!.id, 'ENROLL', `${userId}→${courseId}`, `Matriculou ${roleLabel} em curso`);
        res.status(201).json({ ...enrollment, emailDelivery });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Erro ao matricular.' });
    }
});

// Matricular TODOS os alunos em um curso
router.post('/enrollments/all', authenticateToken, requireRole(['ADMIN']), async (req: Request, res: Response): Promise<void> => {
    try {
        const { courseId } = req.body;
        if (!courseId) {
            res.status(400).json({ message: 'ID do curso é obrigatório.' });
            return;
        }

        const course = await prisma.course.findUnique({ where: { id: courseId } });
        if (!course) {
            res.status(404).json({ message: 'Curso não encontrado.' });
            return;
        }

        const students = await prisma.user.findMany({ where: { role: 'STUDENT' } });
        const existing = await prisma.courseEnrollment.findMany({
            where: { courseId },
            select: { userId: true }
        });
        const enrolledIds = new Set(existing.map(e => e.userId));
        const toEnroll = students.filter(s => !enrolledIds.has(s.id));

        if (toEnroll.length === 0) {
            res.json({ message: 'Todos os alunos já estão matriculados.', enrolled: 0 });
            return;
        }

        await prisma.courseEnrollment.createMany({
            data: toEnroll.map(s => ({ userId: s.id, courseId })),
            skipDuplicates: true
        });

        await prisma.notification.createMany({
            data: toEnroll.map(student => ({
                userId: student.id,
                title: 'Nova matrícula',
                message: `Você foi matriculado no curso ${course.name}.`
            }))
        });

        const configured = isEmailConfigured();
        const eligibleStudents = toEnroll.filter(student => isDeliverableEmailAddress(student.email));
        const emailResult = configured
            ? await sendBulkEmails(eligibleStudents.map(student => ({
                to: student.email,
                subject: `[${process.env.PLATFORM_NAME || 'EduVault'}] Nova matrícula`,
                message: `Olá, ${student.name}!\n\nVocê foi matriculado no curso ${course.name}. Acesse a plataforma para consultar as aulas e atividades.`
            })))
            : { attempted: 0, sent: 0, failed: 0 };

        await auditLog(req.user!.id, 'ENROLL_ALL', courseId, `Matriculou ${toEnroll.length} alunos em ${course.name}`);
        res.status(201).json({
            message: `${toEnroll.length} aluno(s) matriculado(s).`,
            enrolled: toEnroll.length,
            emailDelivery: { configured, eligible: eligibleStudents.length, ...emailResult }
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Erro ao matricular alunos.' });
    }
});

// Desvincular aluno de curso
router.delete('/enrollments/:id', authenticateToken, requireRole(['ADMIN']), async (req: Request, res: Response): Promise<void> => {
    try {
        const id = req.params.id as string;
        await prisma.courseEnrollment.delete({ where: { id } });
        res.json({ message: 'Matrícula removida com sucesso.' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Erro ao remover matrícula.' });
    }
});

// ============================================================
// MONITORAMENTO DE VÍDEOS (Status de Processamento)
// ============================================================

// Listar vídeos (com paginação)
router.get('/videos', authenticateToken, requireRole(['ADMIN', 'TEACHER']), async (req: Request, res: Response): Promise<void> => {
    try {
        const page = Math.max(1, parseInt(req.query.page as string) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 50));
        const skip = (page - 1) * limit;

        const [videos, total] = await Promise.all([
            prisma.video.findMany({
                include: { module: { include: { course: { select: { name: true } } } } },
                orderBy: { createdAt: 'desc' },
                skip,
                take: limit
            }),
            prisma.video.count()
        ]);

        res.json({ data: videos, total, page, limit, totalPages: Math.ceil(total / limit) });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Erro ao listar vídeos.' });
    }
});

// Editar vídeo (título, descrição, conteúdo textual, thumbnail)
router.put('/videos/:id', authenticateToken, requireRole(['ADMIN', 'TEACHER']), async (req: Request, res: Response): Promise<void> => {
    try {
        const id = req.params.id as string;
        if (!await canAccessVideo(req.user!.id, req.user!.role, id)) {
            res.status(403).json({ message: 'Acesso negado a este vídeo.' });
            return;
        }
        const { title, description, content, thumbnailUrl } = req.body;

        const data: Record<string, unknown> = {};
        if (title !== undefined) data.title = title;
        if (description !== undefined) data.description = description;
        if (content !== undefined) data.content = content;
        if (thumbnailUrl !== undefined) data.thumbnailUrl = thumbnailUrl;

        if (Object.keys(data).length === 0) {
            res.status(400).json({ message: 'Nenhum campo para atualizar.' });
            return;
        }

        const video = await prisma.video.update({
            where: { id },
            data
        });

        res.json(video);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Erro ao atualizar vídeo.' });
    }
});

// Deletar vídeo (com transaction) — ISSUE-09: Disk cleanup
router.delete('/videos/:id', authenticateToken, requireRole(['ADMIN']), async (req: Request, res: Response): Promise<void> => {
    try {
        const id = req.params.id as string;

        // ISSUE-09: Buscar paths antes de deletar
        const video = await prisma.video.findUnique({
            where: { id },
            select: { originalUrl: true }
        });

        await prisma.$transaction([
            prisma.videoHistory.deleteMany({ where: { videoId: id } }),
            prisma.video.delete({ where: { id } })
        ]);

        // Cleanup de arquivos no disco (async)
        await cleanupVideoFiles([{ id, originalUrl: video?.originalUrl ?? null }]);

        await auditLog(req.user!.id, 'DELETE_VIDEO', id, `Removeu vídeo ${id}`);
        res.json({ message: 'Vídeo removido com sucesso.' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Erro ao remover vídeo.' });
    }
});

// ============================================================
// REPROCESSAR VÍDEO COM ERRO
// ============================================================

router.post('/videos/:id/reprocess', authenticateToken, requireRole(['ADMIN']), async (req: Request, res: Response): Promise<void> => {
    try {
        const id = req.params.id as string;

        const video = await prisma.video.findUnique({
            where: { id },
            select: { id: true, originalUrl: true, status: true }
        });

        if (!video) {
            res.status(404).json({ message: 'Vídeo não encontrado.' });
            return;
        }

        if (!video.originalUrl) {
            res.status(400).json({ message: 'Arquivo original do vídeo não encontrado no disco.' });
            return;
        }

        try {
            await fsp.access(path.resolve(video.originalUrl));
        } catch {
            res.status(400).json({ message: 'Arquivo original do vídeo não encontrado no disco.' });
            return;
        }

        // Limpar HLS anterior se existir (async)
        const hlsStorage = path.resolve(process.env.HLS_STORAGE_PATH || './uploads/hls');
        const hlsDir = path.join(hlsStorage, id);
        await fsp.rm(hlsDir, { recursive: true, force: true }).catch(() => {});

        await prisma.video.update({
            where: { id },
            data: { status: 'PENDING', hlsUrl: null }
        });

        await enqueueVideoProcessing(id, video.originalUrl);

        res.json({ message: 'Vídeo reenfileirado para processamento.' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Erro ao reprocessar vídeo.' });
    }
});

// ============================================================
// UPLOAD DE IMAGENS (Thumbnails + Conteúdo Rico)
// ============================================================

router.post('/upload-image', authenticateToken, requireRole(['ADMIN', 'TEACHER']), uploadImage.single('image'), async (req: Request, res: Response): Promise<void> => {
    try {
        const file = req.file;
        if (!file) {
            res.status(400).json({ message: 'Nenhuma imagem enviada.' });
            return;
        }
        if (!await isSafeWebImage(file.path)) {
            await removeFileQuietly(file.path);
            res.status(400).json({ message: 'O arquivo enviado não é uma imagem válida.' });
            return;
        }
        const imageUrl = await uploadFileToStorage(file.path, 'images', file.filename, file.mimetype);
        res.json({ url: imageUrl, filename: file.filename });
    } catch (error) {
        await removeFileQuietly(req.file?.path);
        console.error(error);
        res.status(500).json({ message: 'Erro ao realizar upload de imagem.' });
    }
});

// ============================================================
// UPLOAD DE PDFs (Material do Módulo + Calendário)
// ============================================================

router.post('/upload-pdf', authenticateToken, requireRole(['ADMIN', 'TEACHER']), uploadPdf.single('pdf'), async (req: Request, res: Response): Promise<void> => {
    try {
        const file = req.file;
        if (!file) {
            res.status(400).json({ message: 'Nenhum PDF enviado.' });
            return;
        }
        if (!await isPdfFile(file.path)) {
            await removeFileQuietly(file.path);
            res.status(400).json({ message: 'O arquivo enviado não é um PDF válido.' });
            return;
        }
        const pdfUrl = await uploadFileToStorage(file.path, 'pdfs', file.filename, file.mimetype);
        res.json({ url: pdfUrl, filename: file.filename });
    } catch (error) {
        await removeFileQuietly(req.file?.path);
        console.error(error);
        res.status(500).json({ message: 'Erro ao realizar upload de PDF.' });
    }
});

// ============================================================
// DASHBOARD STATS
// ============================================================

router.get('/stats', authenticateToken, requireRole(['ADMIN']), async (_req: Request, res: Response): Promise<void> => {
    try {
        const [totalStudents, totalCourses, totalVideos, processingVideos, readyVideos, pendingVideos, errorVideos, totalEnrollments, totalModules, totalLiveClasses] = await Promise.all([
            prisma.user.count({ where: { role: 'STUDENT' } }),
            prisma.course.count(),
            prisma.video.count(),
            prisma.video.count({ where: { status: 'PROCESSING' } }),
            prisma.video.count({ where: { status: 'READY' } }),
            prisma.video.count({ where: { status: 'PENDING' } }),
            prisma.video.count({ where: { status: 'ERROR' } }),
            prisma.courseEnrollment.count({ where: { enrollmentRole: 'STUDENT' } }),
            prisma.module.count(),
            prisma.liveClass.count()
        ]);

        res.json({
            totalUsers: totalStudents,
            totalCourses,
            totalVideos,
            processingVideos,
            readyVideos,
            pendingVideos,
            errorVideos,
            totalEnrollments,
            totalModules,
            totalLiveClasses
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Erro ao buscar estatísticas.' });
    }
});

// ============================================================
// SISTEMA DE PRESENÇA / ATTENDANCE
// ============================================================

// Listar presença por módulo e data (com filtros)
router.get('/attendance', authenticateToken, requireRole(['ADMIN']), async (req: Request, res: Response): Promise<void> => {
    try {
        const { moduleId, date, courseId } = req.query;

        // Construir filtro
        const where: any = {};
        if (moduleId) where.moduleId = moduleId as string;
        if (date) {
            const d = new Date(date as string);
            d.setHours(0, 0, 0, 0);
            where.date = d;
        }
        if (courseId) {
            where.module = { courseId: courseId as string };
        }

        const attendances = await prisma.attendance.findMany({
            where,
            include: {
                user: { select: { id: true, name: true, email: true } },
                module: { select: { id: true, name: true, course: { select: { id: true, name: true } } } },
                edits: {
                    include: { editedBy: { select: { id: true, name: true } } },
                    orderBy: { createdAt: 'desc' }
                }
            },
            orderBy: [{ date: 'desc' }, { user: { name: 'asc' } }]
        });

        // Se filtrando por moduleId + date, incluir alunos ausentes (que não têm registro)
        if (moduleId && date) {
            const mod = await prisma.module.findUnique({ where: { id: moduleId as string }, select: { courseId: true } });
            if (mod) {
                const enrolledStudents = await prisma.courseEnrollment.findMany({
                    where: { courseId: mod.courseId, enrollmentRole: 'STUDENT' },
                    include: { user: { select: { id: true, name: true, email: true } } }
                });

                const attendedUserIds = new Set(attendances.map(a => a.userId));
                const d = new Date(date as string);
                d.setHours(0, 0, 0, 0);

                const absentStudents = enrolledStudents
                    .filter(e => !attendedUserIds.has(e.userId))
                    .map(e => ({
                        id: null,
                        userId: e.userId,
                        moduleId: moduleId as string,
                        date: d.toISOString(),
                        status: 'ABSENT' as const,
                        watchTimeSeconds: 0,
                        autoDetected: false,
                        user: e.user,
                        module: null,
                        edits: [],
                        createdAt: null,
                        updatedAt: null
                    }));

                res.json([...attendances, ...absentStudents]);
                return;
            }
        }

        res.json(attendances);
    } catch (error) {
        console.error('Erro ao buscar presenças:', error);
        res.status(500).json({ message: 'Erro ao buscar presenças.' });
    }
});

// Editar presença manualmente (com justificativa obrigatória + audit log)
router.put('/attendance/:id', authenticateToken, requireRole(['ADMIN']), async (req: Request, res: Response): Promise<void> => {
    try {
        const id = req.params.id as string;
        const { status, justification } = req.body;
        const adminId = req.user!.id;

        if (!status || !justification) {
            res.status(400).json({ message: 'Status e justificativa são obrigatórios.' });
            return;
        }

        if (!['PRESENT', 'ABSENT'].includes(status)) {
            res.status(400).json({ message: 'Status inválido. Use PRESENT ou ABSENT.' });
            return;
        }

        const attendance = await prisma.attendance.findUnique({
            where: { id },
            include: { user: { select: { name: true } }, module: { select: { name: true } } }
        }) as any;

        if (!attendance) {
            res.status(404).json({ message: 'Registro de presença não encontrado.' });
            return;
        }

        const oldStatus = attendance.status as string;

        // Atualizar presença + criar registro de edição em transação
        const [updated] = await prisma.$transaction([
            prisma.attendance.update({
                where: { id },
                data: { status, autoDetected: false }
            }),
            prisma.attendanceEdit.create({
                data: {
                    attendanceId: id,
                    editedByUserId: adminId,
                    oldStatus,
                    newStatus: status,
                    justification
                }
            })
        ]);

        // Audit log
        await auditLog(adminId, 'ATTENDANCE_EDIT', `attendance:${id}`,
            `Presença de ${attendance.user.name} no módulo ${attendance.module.name}: ${oldStatus} → ${status}. Justificativa: ${justification}`);

        res.json({ message: 'Presença atualizada.', attendance: updated });
    } catch (error) {
        console.error('Erro ao editar presença:', error);
        res.status(500).json({ message: 'Erro ao editar presença.' });
    }
});

// Criar presença manual (para alunos que não têm registro naquela data)
router.post('/attendance', authenticateToken, requireRole(['ADMIN']), async (req: Request, res: Response): Promise<void> => {
    try {
        const { userId, moduleId, date, status, justification } = req.body;
        const adminId = req.user!.id;

        if (!userId || !moduleId || !date || !status || !justification) {
            res.status(400).json({ message: 'userId, moduleId, date, status e justificativa são obrigatórios.' });
            return;
        }

        const d = new Date(date);
        d.setHours(0, 0, 0, 0);

        const attendance = await prisma.attendance.create({
            data: {
                userId,
                moduleId,
                date: d,
                status,
                watchTimeSeconds: 0,
                autoDetected: false
            }
        });

        // Registrar a edição manual
        await prisma.attendanceEdit.create({
            data: {
                attendanceId: attendance.id,
                editedByUserId: adminId,
                oldStatus: 'ABSENT',
                newStatus: status,
                justification
            }
        });

        await auditLog(adminId, 'ATTENDANCE_CREATE', `attendance:${attendance.id}`,
            `Presença manual criada. Status: ${status}. Justificativa: ${justification}`);

        res.status(201).json(attendance);
    } catch (error) {
        console.error('Erro ao criar presença:', error);
        res.status(500).json({ message: 'Erro ao criar presença.' });
    }
});

// ============================================================
// CONFIGURAÇÕES GLOBAIS (Branding)
// ============================================================

// Buscar configuração global no Admin
router.get('/config', authenticateToken, requireRole(['ADMIN']), async (req: Request, res: Response): Promise<void> => {
    try {
        let config = await prisma.platformConfig.findFirst();
        if (!config) {
            config = await prisma.platformConfig.create({
                data: {
                    platformName: 'EduVault',
                    namePart1: 'Edu',
                    namePart2: 'Vault',
                    nameColor1: '#e50914',
                    nameColor2: '#172033',
                    primaryColor: '#6366f1',
                    accentColor: '#ec4899',
                    logoUrl: null,
                    bannerUrl: null
                }
            });
        }
        res.json(config);
    } catch (error) {
        console.error('Erro ao buscar configurações globais:', error);
        res.status(500).json({ message: 'Erro ao buscar configurações globais.' });
    }
});

// Atualizar configuração global no Admin
router.put('/config', authenticateToken, requireRole(['ADMIN']), async (req: Request, res: Response): Promise<void> => {
    try {
        const { platformName, namePart1, namePart2, nameColor1, nameColor2, primaryColor, accentColor, logoUrl, bannerUrl,
                attendanceEnabled, attendanceMinMinutes, attendanceMode } = req.body;

        let config = await prisma.platformConfig.findFirst();

        if (config) {
            config = await prisma.platformConfig.update({
                where: { id: config.id },
                data: {
                    platformName: platformName !== undefined ? platformName : config.platformName,
                    namePart1: namePart1 !== undefined ? namePart1 : config.namePart1,
                    namePart2: namePart2 !== undefined ? namePart2 : config.namePart2,
                    nameColor1: nameColor1 !== undefined ? nameColor1 : config.nameColor1,
                    nameColor2: nameColor2 !== undefined ? nameColor2 : config.nameColor2,
                    primaryColor: primaryColor !== undefined ? primaryColor : config.primaryColor,
                    accentColor: accentColor !== undefined ? accentColor : config.accentColor,
                    logoUrl: logoUrl !== undefined ? logoUrl : config.logoUrl,
                    bannerUrl: bannerUrl !== undefined ? bannerUrl : config.bannerUrl,
                    attendanceEnabled: attendanceEnabled !== undefined ? attendanceEnabled : config.attendanceEnabled,
                    attendanceMinMinutes: attendanceMinMinutes !== undefined ? Number(attendanceMinMinutes) : config.attendanceMinMinutes,
                    attendanceMode: attendanceMode !== undefined ? attendanceMode : config.attendanceMode
                }
            });
        } else {
            config = await prisma.platformConfig.create({
                data: {
                    platformName: platformName || 'EduVault',
                    namePart1: namePart1 || 'Edu',
                    namePart2: namePart2 || 'Vault',
                    nameColor1: nameColor1 || '#e50914',
                    nameColor2: nameColor2 || '#172033',
                    primaryColor: primaryColor || '#6366f1',
                    accentColor: accentColor || '#ec4899',
                    logoUrl: logoUrl || null,
                    bannerUrl: bannerUrl || null
                }
            });
        }

        res.json({ message: 'Configurações atualizadas com sucesso.', config });
        invalidateConfigCache();
    } catch (error) {
        console.error('Erro ao atualizar configurações globais:', error);
        res.status(500).json({ message: 'Erro ao atualizar configurações globais.' });
    }
});

// ============================================================
// IMPORTAÇÃO DE ALUNOS VIA EXCEL
// ============================================================
router.post('/upload-students-excel', authenticateToken, requireRole(['ADMIN']), uploadExcel.single('file'), async (req: Request, res: Response): Promise<void> => {
    const filePath = req.file?.path;
    try {
        if (!filePath) {
            res.status(400).json({ message: 'Nenhum arquivo enviado.' });
            return;
        }
        if (!await isSpreadsheetFile(filePath)) {
            res.status(400).json({ message: 'O arquivo enviado não é uma planilha XLSX válida.' });
            return;
        }
        const result = await importStudentsFromWorkbook(filePath);
        const successful = result.results.filter((row) => !row.error).length;
        await auditLog(req.user!.id, 'EXCEL_IMPORT', `${result.results.length} linhas`, `Importou planilha: ${successful} OK, ${result.results.length - successful} erros`);
        res.json({
            message: `Importação concluída: ${successful} de ${result.results.length} alunos processados.`,
            ...result,
        });
    } catch (error) {
        if (error instanceof StudentImportInputError) {
            res.status(400).json({ message: error.message });
            return;
        }
        logger.error({ error, userId: req.user?.id }, 'Erro ao processar planilha de alunos');
        res.status(500).json({ message: 'Erro ao processar planilha.' });
    } finally {
        await removeFileQuietly(filePath);
    }
});

// ============================================================
// EXPORTAR ALUNOS PARA EXCEL
// ============================================================
router.get('/export-students', authenticateToken, requireRole(['ADMIN']), async (_req: Request, res: Response): Promise<void> => {
    try {
        const students = await prisma.user.findMany({
            where: { role: 'STUDENT' },
            select: {
                name: true,
                email: true,
                createdAt: true,
                enrollments: {
                    select: {
                        course: { select: { name: true } }
                    }
                },
                history: {
                    select: { completed: true }
                }
            },
            orderBy: { name: 'asc' }
        });

        const rows = students.map(s => ({
            Nome: s.name,
            Email: s.email,
            Cursos: s.enrollments.map(e => e.course.name).join(', ') || '—',
            'Aulas Concluídas': s.history.filter(h => h.completed).length,
            'Total Aulas Assistidas': s.history.length,
            'Data Cadastro': s.createdAt.toISOString().split('T')[0]
        }));

        const workbook = new ExcelJS.Workbook();
        workbook.creator = 'EduVault';
        workbook.created = new Date();
        const worksheet = workbook.addWorksheet('Alunos', {
            views: [{ state: 'frozen', ySplit: 1 }]
        });
        const keys = Object.keys(rows[0] || { Nome: '', Email: '', Cursos: '' });
        worksheet.columns = keys.map((key) => ({
            header: key,
            key,
            width: Math.max(15, Math.min(45, key.length + 4)),
        }));
        worksheet.addRows(rows);
        worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
        worksheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F46E5' } };
        worksheet.autoFilter = { from: 'A1', to: `${worksheet.getColumn(keys.length).letter}1` };

        const buffer = await workbook.xlsx.writeBuffer();
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=alunos-${new Date().toISOString().split('T')[0]}.xlsx`);
        res.send(Buffer.from(buffer));
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Erro ao exportar alunos.' });
    }
});

// Bloquear ou liberar acesso sem remover matrícula, progresso ou histórico.
router.patch('/users/:id/access', authenticateToken, requireRole(['ADMIN']), async (req: Request, res: Response): Promise<void> => {
    try {
        const id = req.params.id as string;
        const blocked = req.body?.blocked;
        const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 500) : '';

        if (id === req.user!.id) {
            res.status(403).json({ message: 'Não é possível bloquear sua própria conta.' });
            return;
        }
        if (typeof blocked !== 'boolean') {
            res.status(400).json({ message: 'O campo blocked deve ser booleano.' });
            return;
        }
        if (blocked && reason.length < 3) {
            res.status(400).json({ message: 'Informe o motivo do bloqueio.' });
            return;
        }

        const user = await prisma.user.update({
            where: { id },
            data: {
                accessBlocked: blocked,
                accessBlockedAt: blocked ? new Date() : null,
                accessBlockedReason: blocked ? reason : null,
                tokenVersion: { increment: 1 }
            },
            select: { id: true, name: true, email: true, role: true, accessBlocked: true, accessBlockedAt: true, accessBlockedReason: true, createdAt: true }
        });

        await auditLog(req.user!.id, blocked ? 'BLOCK_USER_ACCESS' : 'UNBLOCK_USER_ACCESS', id, blocked ? reason : `Liberou o acesso de ${user.email}`);
        res.json(user);
    } catch (error) {
        logger.error({ error }, 'Erro ao alterar bloqueio do usuário');
        res.status(500).json({ message: 'Erro ao alterar o acesso do usuário.' });
    }
});

router.post('/users/:id/revoke-sessions', authenticateToken, requireRole(['ADMIN']), async (req: Request, res: Response): Promise<void> => {
    try {
        const id = req.params.id as string;
        if (id === req.user!.id) {
            res.status(403).json({ message: 'Use o botão Sair para encerrar sua própria sessão.' });
            return;
        }
        const user = await prisma.user.update({
            where: { id },
            data: { tokenVersion: { increment: 1 } },
            select: { id: true, email: true }
        });
        await auditLog(req.user!.id, 'REVOKE_USER_SESSIONS', id, `Revogou todas as sessões de ${user.email}`);
        res.json({ message: 'Todas as sessões foram revogadas.' });
    } catch (error) {
        logger.error({ error }, 'Erro ao revogar sessões do usuário');
        res.status(500).json({ message: 'Erro ao revogar as sessões.' });
    }
});

router.post('/users/:id/reset-password', authenticateToken, requireRole(['ADMIN']), async (req: Request, res: Response): Promise<void> => {
    try {
        const id = req.params.id as string;
        if (id === req.user!.id) {
            res.status(403).json({ message: 'Altere sua própria senha em Configurações.' });
            return;
        }
        const password = req.body?.password;
        const passwordError = passwordValidationMessage(password);
        if (passwordError) {
            res.status(400).json({ message: passwordError });
            return;
        }

        const user = await prisma.user.update({
            where: { id },
            data: {
                password: await bcrypt.hash(password, 12),
                passwordChangedAt: new Date(),
                mustChangePassword: true,
                tokenVersion: { increment: 1 }
            },
            select: { id: true, email: true, name: true, username: true }
        });
        const emailDelivery = await attemptEmailDelivery(() => sendResetPasswordEmail({
            to: user.email,
            studentName: user.name,
            login: user.username || user.email,
            password
        }), { action: 'ADMIN_RESET_USER_PASSWORD', userId: id }, user.email);
        await auditLog(req.user!.id, 'ADMIN_RESET_USER_PASSWORD', id, `Redefiniu a senha de ${user.email} e exigiu troca no próximo acesso`);
        res.json({
            message: 'Senha redefinida. O usuário deverá trocá-la no próximo acesso.',
            emailDelivery
        });
    } catch (error) {
        logger.error({ error }, 'Erro ao redefinir senha do usuário');
        res.status(500).json({ message: 'Erro ao redefinir a senha.' });
    }
});

// ============================================================
// MONITORING & HEALTH
// ============================================================
import os from 'os';

router.get('/health', authenticateToken, requireRole(['ADMIN']), async (req: Request, res: Response): Promise<void> => {
    try {
        const uptime = process.uptime();
        const memory = process.memoryUsage();
        const cpus = os.cpus();

        const [dbStatus, storageStatus] = await Promise.all([
            prisma.$queryRaw`SELECT 1`.then(() => 'up').catch(() => 'down'),
            fsp.access(path.resolve(process.env.IMAGE_STORAGE_PATH || './uploads/images'))
                .then(() => 'up')
                .catch(() => 'down')
        ]);

        res.json({
            status: 'ok',
            uptime,
            memory: {
                total: os.totalmem(),
                free: os.freemem(),
                process: memory.rss
            },
            cpu: cpus.length,
            services: {
                database: dbStatus,
                storage: storageStatus
            }
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Erro ao coletar métricas de saúde.' });
    }
});

// ============================================================
// AUDIT LOG
// ============================================================
router.get('/audit-log', authenticateToken, requireRole(['ADMIN']), async (req: Request, res: Response): Promise<void> => {
    try {
        const { page, limit, skip } = pagination(req.query, 50, 100);

        const [logs, total] = await Promise.all([
            prisma.auditLog.findMany({
                include: { user: { select: { name: true, email: true } } },
                orderBy: { createdAt: 'desc' },
                skip,
                take: limit
            }),
            prisma.auditLog.count()
        ]);

        res.json({ data: logs, total, page, totalPages: Math.ceil(total / limit) });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Erro ao buscar audit log.' });
    }
});

// ============================================================
// RELATÓRIOS
// ============================================================
router.get('/reports', authenticateToken, requireRole(['ADMIN']), async (_req: Request, res: Response): Promise<void> => {
    try {
        const courses = await prisma.course.findMany({
            select: {
                id: true,
                name: true,
                enrollments: { select: { userId: true } },
                modules: {
                    select: {
                        videos: {
                            select: {
                                id: true,
                                history: { select: { completed: true, progress: true } }
                            }
                        }
                    }
                }
            }
        });

        const courseReports = courses.map(c => {
            const totalStudents = c.enrollments.length;
            const videos = c.modules.flatMap(m => m.videos);
            const totalVideos = videos.length;
            const allHistories = videos.flatMap(v => v.history);
            const completedCount = allHistories.filter(h => h.completed).length;
            const totalPossible = totalStudents * totalVideos;
            const completionRate = totalPossible > 0 ? Math.round((completedCount / totalPossible) * 100) : 0;

            return {
                id: c.id,
                name: c.name,
                totalStudents,
                totalVideos,
                completionRate,
                completedLessons: completedCount,
                totalPossibleLessons: totalPossible
            };
        });

        res.json(courseReports);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Erro ao gerar relatórios.' });
    }
});

// ============================================================
// NOTIFICAÇÕES (Admin cria para aluno ou broadcast)
// ============================================================
router.post('/notifications', authenticateToken, requireRole(['ADMIN']), async (req: Request, res: Response): Promise<void> => {
    try {
        const { title, message, userIds } = req.body;
        if (!title || !message) {
            res.status(400).json({ message: 'Título e mensagem são obrigatórios.' });
            return;
        }

        const targetUsers = await prisma.user.findMany({
            where: Array.isArray(userIds) && userIds.length > 0
                ? { id: { in: userIds } }
                : { role: 'STUDENT' },
            select: { id: true, name: true, email: true }
        });
        const targetIds = targetUsers.map(student => student.id);

        if (targetIds.length === 0) {
            res.status(400).json({ message: 'Nenhum aluno encontrado para receber a notificação.' });
            return;
        }

        await prisma.notification.createMany({
            data: targetIds.map((uid: string) => ({ userId: uid, title, message }))
        });

        const configured = isEmailConfigured();
        const emailRecipients = targetUsers.filter(student => isDeliverableEmailAddress(student.email));
        const emailResult = configured
            ? await sendBulkEmails(emailRecipients.map(student => ({
                to: student.email,
                subject: `[${process.env.PLATFORM_NAME || 'EduVault'}] ${title}`,
                message: `Olá, ${student.name}!\n\n${message}`
            })))
            : { attempted: 0, sent: 0, failed: 0 };

        if (emailResult.failed > 0) {
            logger.warn({ ...emailResult }, 'Parte dos e-mails de notificação não foi entregue');
        }

        const deliveryMessage = configured
            ? ` E-mail: ${emailResult.sent} entregue(s), ${emailResult.failed} falha(s).`
            : ' O aviso ficou disponível no painel; o SMTP ainda não está configurado.';
        res.status(201).json({
            message: `Notificação registrada para ${targetIds.length} aluno(s).${deliveryMessage}`,
            recipients: targetIds.length,
            emailDelivery: { configured, eligible: emailRecipients.length, ...emailResult }
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Erro ao enviar notificação.' });
    }
});

// ============================================================
// AULAS AO VIVO (Live Classes)
// ============================================================

// LIST all live classes
router.get('/live-classes', authenticateToken, requireRole(['ADMIN']), async (_req: Request, res: Response): Promise<void> => {
    try {
        const liveClasses = await prisma.liveClass.findMany({
            orderBy: { startAt: 'desc' },
            include: {
                course: { select: { id: true, name: true } },
                module: { select: { id: true, name: true } },
                recordingVideo: { select: { id: true, title: true } }
            }
        });
        res.json(liveClasses);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Erro ao listar aulas ao vivo.' });
    }
});

// CREATE live class
router.post('/live-classes', authenticateToken, requireRole(['ADMIN']), async (req: Request, res: Response): Promise<void> => {
    try {
        const { courseId, moduleId, title, description, startAt, endAt, zoomJoinUrl, zoomStartUrl, zoomMeetingId } = req.body;

        if (!courseId || !title || !startAt || !zoomJoinUrl) {
            res.status(400).json({ message: 'courseId, title, startAt e zoomJoinUrl são obrigatórios.' });
            return;
        }

        // Validate course exists
        const course = await prisma.course.findUnique({ where: { id: courseId } });
        if (!course) {
            res.status(404).json({ message: 'Curso não encontrado.' });
            return;
        }

        // Validate module if provided
        if (moduleId) {
            const mod = await prisma.module.findUnique({ where: { id: moduleId } });
            if (!mod || mod.courseId !== courseId) {
                res.status(400).json({ message: 'Módulo não pertence ao curso selecionado.' });
                return;
            }
        }

        const liveClass = await prisma.liveClass.create({
            data: {
                courseId,
                moduleId: moduleId || null,
                title,
                description: description || null,
                startAt: new Date(startAt),
                endAt: endAt ? new Date(endAt) : null,
                zoomJoinUrl,
                zoomStartUrl: zoomStartUrl || null,
                zoomMeetingId: zoomMeetingId || null
            }
        });

        await auditLog(req.user!.id, 'CREATE_LIVE_CLASS', liveClass.id, `Aula ao vivo: ${title}`);
        res.status(201).json(liveClass);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Erro ao criar aula ao vivo.' });
    }
});

// UPDATE live class
router.put('/live-classes/:id', authenticateToken, requireRole(['ADMIN']), async (req: Request, res: Response): Promise<void> => {
    try {
        const id = req.params.id as string;
        const { title, description, startAt, endAt, zoomJoinUrl, zoomStartUrl, zoomMeetingId, status, moduleId } = req.body;

        const existing = await requireLiveClass(id, res);
        if (!existing) return;

        const validStatuses = ['SCHEDULED', 'LIVE', 'ENDED', 'RECORDED'];
        if (status && !validStatuses.includes(status)) {
            res.status(400).json({ message: 'Status inválido.' });
            return;
        }

        const updated = await prisma.liveClass.update({
            where: { id },
            data: {
                ...(title !== undefined && { title }),
                ...(description !== undefined && { description }),
                ...(startAt !== undefined && { startAt: new Date(startAt) }),
                ...(endAt !== undefined && { endAt: endAt ? new Date(endAt) : null }),
                ...(zoomJoinUrl !== undefined && { zoomJoinUrl }),
                ...(zoomStartUrl !== undefined && { zoomStartUrl }),
                ...(zoomMeetingId !== undefined && { zoomMeetingId }),
                ...(status !== undefined && { status }),
                ...(moduleId !== undefined && { moduleId: moduleId || null })
            }
        });

        await auditLog(req.user!.id, 'UPDATE_LIVE_CLASS', id, `Atualizado: ${updated.title}`);
        res.json(updated);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Erro ao atualizar aula ao vivo.' });
    }
});

// DELETE live class
router.delete('/live-classes/:id', authenticateToken, requireRole(['ADMIN']), async (req: Request, res: Response): Promise<void> => {
    try {
        const id = req.params.id as string;

        const existing = await requireLiveClass(id, res);
        if (!existing) return;

        await prisma.liveClass.delete({ where: { id } });
        await auditLog(req.user!.id, 'DELETE_LIVE_CLASS', id, `Removida: ${existing.title}`);
        res.json({ message: 'Aula ao vivo removida.' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Erro ao remover aula ao vivo.' });
    }
});

// ATTACH RECORDING to live class
router.post('/live-classes/:id/attach-recording', authenticateToken, requireRole(['ADMIN']), async (req: Request, res: Response): Promise<void> => {
    try {
        const id = req.params.id as string;
        const { videoId } = req.body;

        const existing = await requireLiveClass(id, res);
        if (!existing) return;

        if (!videoId) {
            res.status(400).json({ message: 'videoId é obrigatório.' });
            return;
        }

        const video = await prisma.video.findUnique({ where: { id: videoId } });
        if (!video) {
            res.status(404).json({ message: 'Vídeo não encontrado.' });
            return;
        }

        const updated = await prisma.liveClass.update({
            where: { id },
            data: { recordingVideoId: videoId, status: 'RECORDED' }
        });

        await auditLog(req.user!.id, 'ATTACH_RECORDING', id, `Gravação vinculada: ${video.title}`);
        res.json(updated);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Erro ao vincular gravação.' });
    }
});

// ============================================================
// MODERAÇÃO DE COMENTÁRIOS
// ============================================================

// Listar comentários flagados/denunciados
router.get('/comments/flagged', authenticateToken, requireRole(['ADMIN']), async (req: Request, res: Response): Promise<void> => {
    try {
        const page = Math.max(1, parseInt(req.query.page as string) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 30));
        const skip = (page - 1) * limit;

        const [comments, total] = await Promise.all([
            prisma.lessonComment.findMany({
                where: {
                    OR: [
                        { flagged: true },
                        { reports: { some: {} } }
                    ]
                },
                orderBy: { createdAt: 'desc' },
                skip,
                take: limit,
                select: {
                    id: true,
                    text: true,
                    flagged: true,
                    createdAt: true,
                    user: { select: { id: true, name: true, role: true } },
                    video: { select: { id: true, title: true, module: { select: { course: { select: { name: true } } } } } },
                    reports: {
                        select: {
                            id: true,
                            reason: true,
                            createdAt: true,
                            user: { select: { name: true } }
                        }
                    },
                    _count: { select: { reports: true } }
                }
            }),
            prisma.lessonComment.count({
                where: {
                    OR: [
                        { flagged: true },
                        { reports: { some: {} } }
                    ]
                }
            })
        ]);

        res.json({ comments, total, page, totalPages: Math.ceil(total / limit) });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Erro ao buscar comentários flagados.' });
    }
});

// Deletar qualquer comentário (admin)
router.delete('/comments/:id', authenticateToken, requireRole(['ADMIN']), async (req: Request, res: Response): Promise<void> => {
    try {
        const commentId = req.params.id as string;
        const comment = await prisma.lessonComment.findUnique({
            where: { id: commentId },
            select: { text: true, user: { select: { name: true } } }
        });
        if (!comment) { res.status(404).json({ message: 'Comentário não encontrado.' }); return; }

        await prisma.lessonComment.delete({ where: { id: commentId } });
        await auditLog(req.user!.id, 'DELETE_COMMENT', commentId, `Comentário de ${comment.user.name} removido`);
        res.json({ message: 'Comentário removido.' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Erro ao deletar comentário.' });
    }
});

// Aprovar comentário (remove flag)
router.put('/comments/:id/approve', authenticateToken, requireRole(['ADMIN']), async (req: Request, res: Response): Promise<void> => {
    try {
        const commentId = req.params.id as string;
        const comment = await prisma.lessonComment.findUnique({ where: { id: commentId } });
        if (!comment) { res.status(404).json({ message: 'Comentário não encontrado.' }); return; }

        await prisma.lessonComment.update({ where: { id: commentId }, data: { flagged: false } });
        // Limpa denúncias associadas
        await prisma.commentReport.deleteMany({ where: { commentId } });
        res.json({ message: 'Comentário aprovado.' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Erro ao aprovar comentário.' });
    }
});

// Toggle comentários em uma aula (ativar/desativar)
router.put('/videos/:id/comments-toggle', authenticateToken, requireRole(['ADMIN']), async (req: Request, res: Response): Promise<void> => {
    try {
        const videoId = req.params.id as string;
        const video = await prisma.video.findUnique({ where: { id: videoId }, select: { commentsEnabled: true, title: true } });
        if (!video) { res.status(404).json({ message: 'Aula não encontrada.' }); return; }

        const updated = await prisma.video.update({
            where: { id: videoId },
            data: { commentsEnabled: !video.commentsEnabled }
        });

        await auditLog(req.user!.id, 'TOGGLE_COMMENTS', videoId, `Comentários ${updated.commentsEnabled ? 'habilitados' : 'desabilitados'} em: ${video.title}`);
        res.json({ commentsEnabled: updated.commentsEnabled });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Erro ao alterar configuração de comentários.' });
    }
});

// ============================================================
// SISTEMA DE PUNIÇÕES
// ============================================================

// Toggle sistema de punição
router.put('/punishment-toggle', authenticateToken, requireRole(['ADMIN']), async (req: Request, res: Response): Promise<void> => {
    try {
        const config = await prisma.platformConfig.findFirst();
        if (!config) { res.status(500).json({ message: 'Config não encontrada.' }); return; }

        const updated = await prisma.platformConfig.update({
            where: { id: config.id },
            data: { forumPunishmentEnabled: !config.forumPunishmentEnabled }
        });

        await auditLog(req.user!.id, 'TOGGLE_PUNISHMENT', config.id, `Sistema de punição ${updated.forumPunishmentEnabled ? 'ativado' : 'desativado'}`);
        res.json({ forumPunishmentEnabled: updated.forumPunishmentEnabled });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Erro ao alterar sistema de punição.' });
    }
});

// Listar todas as violações
router.get('/violations', authenticateToken, requireRole(['ADMIN']), async (req: Request, res: Response): Promise<void> => {
    try {
        const violations = await prisma.forumViolation.findMany({
            orderBy: { createdAt: 'desc' },
            take: 100,
            include: {
                user: { select: { id: true, name: true, email: true } }
            }
        });
        res.json(violations);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Erro ao buscar violações.' });
    }
});

// Listar todos os bans
router.get('/bans', authenticateToken, requireRole(['ADMIN']), async (req: Request, res: Response): Promise<void> => {
    try {
        const bans = await prisma.forumBan.findMany({
            orderBy: { createdAt: 'desc' },
            take: 100,
            include: {
                user: { select: { id: true, name: true, email: true } }
            }
        });
        res.json(bans);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Erro ao buscar bans.' });
    }
});

// Revogar ban manualmente
router.put('/bans/:id/lift', authenticateToken, requireRole(['ADMIN']), async (req: Request, res: Response): Promise<void> => {
    try {
        const banId = req.params.id as string;
        const ban = await prisma.forumBan.findUnique({ where: { id: banId } });
        if (!ban) { res.status(404).json({ message: 'Ban não encontrado.' }); return; }
        if (!ban.active) { res.status(400).json({ message: 'Ban já está inativo.' }); return; }

        await prisma.forumBan.update({
            where: { id: banId },
            data: { active: false, liftedBy: req.user!.id, liftedAt: new Date() }
        });

        await auditLog(req.user!.id, 'LIFT_BAN', banId, `Ban revogado para usuário ${ban.userId}`);
        res.json({ message: 'Ban revogado com sucesso.' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Erro ao revogar ban.' });
    }
});

// Aplicar ban manualmente
router.post('/bans', authenticateToken, requireRole(['ADMIN']), async (req: Request, res: Response): Promise<void> => {
    try {
        const { userId, reason, banType } = req.body;
        if (!userId || !reason?.trim() || !banType) {
            res.status(400).json({ message: 'userId, reason e banType são obrigatórios.' });
            return;
        }

        const validTypes = ['TEMP_1D', 'TEMP_2D', 'TEMP_10D', 'PERMANENT'];
        if (!validTypes.includes(banType)) {
            res.status(400).json({ message: 'banType inválido.' });
            return;
        }

        const user = await prisma.user.findUnique({ where: { id: userId } });
        if (!user) { res.status(404).json({ message: 'Usuário não encontrado.' }); return; }

        const banDaysMap: Record<string, number | null> = {
            'TEMP_1D': 1, 'TEMP_2D': 2, 'TEMP_10D': 10, 'PERMANENT': null
        };
        const days = banDaysMap[banType];
        const expiresAt = days ? new Date(Date.now() + days * 24 * 60 * 60 * 1000) : null;

        const ban = await prisma.forumBan.create({
            data: { userId, reason: reason.trim(), banType, expiresAt }
        });

        await auditLog(req.user!.id, 'MANUAL_BAN', ban.id, `Ban manual ${banType} aplicado a ${user.name}: ${reason.trim()}`);
        res.status(201).json(ban);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Erro ao aplicar ban.' });
    }
});

// Listar recursos (appeals) pendentes
router.get('/appeals', authenticateToken, requireRole(['ADMIN']), async (req: Request, res: Response): Promise<void> => {
    try {
        const status = req.query.status as string || 'PENDING';
        const appeals = await prisma.forumAppeal.findMany({
            where: { status },
            orderBy: { createdAt: 'desc' },
            take: 100,
            include: {
                user: { select: { id: true, name: true, email: true } }
            }
        });
        res.json(appeals);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Erro ao buscar recursos.' });
    }
});

// Aprovar ou rejeitar recurso
router.put('/appeals/:id', authenticateToken, requireRole(['ADMIN']), async (req: Request, res: Response): Promise<void> => {
    try {
        const appealId = req.params.id as string;
        const { status, adminNote } = req.body;

        if (!['APPROVED', 'REJECTED'].includes(status)) {
            res.status(400).json({ message: 'Status deve ser APPROVED ou REJECTED.' });
            return;
        }

        const appeal = await prisma.forumAppeal.findUnique({ where: { id: appealId } });
        if (!appeal) { res.status(404).json({ message: 'Recurso não encontrado.' }); return; }
        if (appeal.status !== 'PENDING') { res.status(400).json({ message: 'Recurso já foi processado.' }); return; }

        await prisma.forumAppeal.update({
            where: { id: appealId },
            data: { status, adminNote: adminNote?.trim() || null }
        });

        // Se aprovado, revoga ban ativo do aluno
        if (status === 'APPROVED') {
            await prisma.forumBan.updateMany({
                where: { userId: appeal.userId, active: true },
                data: { active: false, liftedBy: req.user!.id, liftedAt: new Date() }
            });
        }

        await auditLog(req.user!.id, 'REVIEW_APPEAL', appealId, `Recurso ${status === 'APPROVED' ? 'aprovado' : 'rejeitado'} para usuário ${appeal.userId}`);
        res.json({ message: `Recurso ${status === 'APPROVED' ? 'aprovado' : 'rejeitado'}.` });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Erro ao processar recurso.' });
    }
});

export default router;
