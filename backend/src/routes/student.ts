/**
 * student.ts — Área do Aluno (Cursos, Aulas, Progresso)
 *
 * Endpoints:
 * - GET  /my-courses         → Lista cursos matriculados com progresso agregado
 * - GET  /available-courses  → Lista cursos disponíveis (não matriculado)
 * - GET  /lesson/:videoId    → Busca aula individual com conteúdo completo (valida enrollment)
 * - POST /progress           → Salva progresso de visualização (valida enrollment)
 * - GET  /progress/:videoId  → Busca progresso salvo para um vídeo específico
 *
 * Segurança: Todas as rotas validam matrícula antes de retornar dados
 */
import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { authenticateToken, requireRole } from '../middleware/authMiddleware';
import prisma from '../lib/prisma';
import { checkProfanity } from '../lib/profanityFilter';
import { calculateProgressUpdate } from '../services/progressPolicy';
import { checkForumBan, recordForumViolation } from '../modules/forum/moderation';
import {
    attendanceDate,
    hasScheduledClassOnLocalDate,
    normalizeStudentLiveClass,
} from '../modules/learning/liveClasses';

const router = Router();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function buildAIQuizFeedback(score: number, total: number): string {
    if (total <= 0) return 'Sem respostas enviadas.';
    const ratio = score / total;
    if (ratio >= 0.8) return 'Excelente desempenho. Continue para o próximo módulo.';
    if (ratio >= 0.5) return 'Bom progresso. Revise os tópicos em que houve erro para fixação.';
    return 'Desempenho abaixo do esperado. Reassista a aula e refaça o quiz em seguida.';
}

function generateCertificateCode(): string {
    return crypto.randomBytes(16).toString('hex').toUpperCase();
}

function isIdentifier(value: unknown): value is string {
    return typeof value === 'string' && UUID_PATTERN.test(value);
}

const videoCourseSelect = {
    module: { select: { courseId: true } },
} as const;

const studentLiveClassSelect = {
    id: true,
    title: true,
    description: true,
    startAt: true,
    endAt: true,
    status: true,
    provider: true,
    meetingJoinUrl: true,
    zoomJoinUrl: true,
    module: { select: { id: true, name: true } },
} as const;

const commentAuthorSelect = { id: true, name: true, role: true } as const;
const commentFieldsSelect = {
    id: true,
    text: true,
    flagged: true,
    createdAt: true,
    userId: true,
    user: { select: commentAuthorSelect },
    _count: { select: { reports: true } },
} as const;

async function hasCourseEnrollment(userId: string, courseId: string): Promise<boolean> {
    const enrollment = await prisma.courseEnrollment.findUnique({
        where: { userId_courseId: { userId, courseId } },
        select: { id: true },
    });
    return enrollment !== null;
}

function studentEnrollmentWhere(userId: string) {
    return { userId, enrollmentRole: 'STUDENT' as const };
}

async function requireQuizVideoAccess(userId: string, videoId: string, res: Response): Promise<boolean> {
    const video = await prisma.video.findUnique({
        where: { id: videoId },
        select: videoCourseSelect,
    });
    if (!video) {
        res.status(404).json({ message: 'Aula não encontrada.' });
        return false;
    }
    if (!await hasCourseEnrollment(userId, video.module.courseId)) {
        res.status(403).json({ message: 'Acesso negado.' });
        return false;
    }
    return true;
}

function findActiveLiveClasses(courseId: string | { in: string[] }, includeCourse = false) {
    return prisma.liveClass.findMany({
        where: { courseId, status: { in: ['SCHEDULED', 'LIVE'] } },
        orderBy: { startAt: 'asc' },
        select: {
            ...studentLiveClassSelect,
            ...(includeCourse ? { course: { select: { id: true, name: true } } } : {}),
        },
    });
}

// This router owns student state (progress, attempts, attendance, comments and
// certificates). Fixing the role at the boundary prevents a teacher account
// from reusing its course enrollment to enter student-only flows.
router.use(authenticateToken, requireRole(['STUDENT']));

// ============================================================
// CURSOS MATRICULADOS (com progresso agregado)
// ============================================================
router.get('/my-courses', async (req: Request, res: Response): Promise<void> => {
    try {
        const userId = req.user!.id;

        const enrollments = await prisma.courseEnrollment.findMany({
            where: studentEnrollmentWhere(userId),
            select: {
                course: {
                    select: {
                        id: true,
                        name: true,
                        description: true,
                        thumbnailUrl: true,
                        modules: {
                            orderBy: { order: 'asc' },
                            select: {
                                id: true,
                                name: true,
                                order: true,
                                videos: {
                                    orderBy: { order: 'asc' },
                                    select: {
                                        id: true,
                                        title: true,
                                        thumbnailUrl: true,
                                        status: true,
                                        order: true,
                                    }
                                }
                            }
                        }
                    }
                }
            }
        });

        // Calcular progresso por curso (batch único — evita N+1)
        const allVideoIds = enrollments.flatMap((e: any) => e.course.modules.flatMap((m: any) => m.videos.map((v: any) => v.id)));

        const allHistories = allVideoIds.length > 0
            ? await prisma.videoHistory.findMany({
                where: { userId, videoId: { in: allVideoIds } }
            })
            : [];

        // Indexar por videoId para lookup O(1)
        const historyMap = new Map(allHistories.map((h: any) => [h.videoId, h]));

        const coursesWithProgress = enrollments.map((e: any) => {
            const course = e.course;
            const courseVideoIds = course.modules.flatMap((m: any) => m.videos.map((v: any) => v.id));
            const totalVideos = courseVideoIds.length;

            let completedVideos = 0;
            let lastWatchedVideo: { id: string; title: string; thumbnailUrl: string | null; progress: number; moduleName: string } | null = null;
            let lastWatchedAt: Date | null = null;

            if (totalVideos > 0) {
                const courseHistories = courseVideoIds
                    .map((id: any) => historyMap.get(id))
                    .filter((h: any): h is NonNullable<typeof h> => h != null);

                completedVideos = courseHistories.filter((h: any) => h.completed).length;

                // Encontrar o último vídeo assistido
                if (courseHistories.length > 0) {
                    const sorted = [...courseHistories].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
                    const lastHistory = sorted[0];
                    lastWatchedAt = lastHistory.updatedAt;
                    for (const mod of course.modules) {
                        const foundVideo = mod.videos.find((v: any) => v.id === lastHistory.videoId);
                        if (foundVideo) {
                            lastWatchedVideo = {
                                id: foundVideo.id,
                                title: foundVideo.title,
                                thumbnailUrl: foundVideo.thumbnailUrl,
                                progress: lastHistory.progress,
                                moduleName: mod.name
                            };
                            break;
                        }
                    }
                }
            }

            const progressPercent = totalVideos > 0 ? Math.round((completedVideos / totalVideos) * 100) : 0;

            return {
                id: course.id,
                name: course.name,
                description: course.description,
                thumbnailUrl: course.thumbnailUrl,
                modules: course.modules,
                progressPercent,
                totalVideos,
                completedVideos,
                lastWatchedVideo,
                lastWatchedAt
            };
        });

        res.json(coursesWithProgress);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Erro ao buscar cursos.' });
    }
});

// ============================================================
// TRILHA INTELIGENTE (RECOMENDAÇÕES)
// ============================================================
router.get('/recommendations', async (req: Request, res: Response): Promise<void> => {
    try {
        const userId = req.user!.id;

        const enrollments = await prisma.courseEnrollment.findMany({
            where: studentEnrollmentWhere(userId),
            select: {
                course: {
                    select: {
                        id: true,
                        name: true,
                        modules: {
                            orderBy: { order: 'asc' },
                            select: {
                                id: true,
                                name: true,
                                videos: {
                                    orderBy: { order: 'asc' },
                                    select: { id: true, title: true, status: true, durationSeconds: true }
                                }
                            }
                        }
                    }
                }
            }
        });

        const allVideos = enrollments.flatMap((e: any) => e.course.modules.flatMap((m: any) => m.videos.map((v: any) => v.id)));
        const histories = allVideos.length > 0
            ? await prisma.videoHistory.findMany({ where: { userId, videoId: { in: allVideos } } })
            : [];
        const historyMap = new Map(histories.map((h: any) => [h.videoId, h]));

        const recommendations: { courseId: string; courseName: string; videoId: string; videoTitle: string; reason: string; moduleName: string; priorityScore: number; riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' }[] = [];

        for (const enrollment of enrollments) {
            const course = enrollment.course;
            const courseVideos = course.modules.flatMap((m: any) => m.videos.map((v: any) => ({ ...v, moduleName: m.name })));
            if (courseVideos.length === 0) continue;

            const weakVideo = courseVideos.find((v: any) => {
                const h: any = historyMap.get(v.id);
                const progressPercent = h && v.durationSeconds
                    ? Math.min(100, (h.progress / v.durationSeconds) * 100)
                    : Math.min(100, h?.progress ?? 0);
                return h && !h.completed && progressPercent > 0 && progressPercent < 60;
            });

            if (weakVideo) {
                const h: any = historyMap.get(weakVideo.id);
                const progressPercent = h && weakVideo.durationSeconds
                    ? Math.min(100, (h.progress / weakVideo.durationSeconds) * 100)
                    : Math.min(100, h?.progress ?? 0);
                const progressGap = Math.max(0, 100 - progressPercent);
                const priorityScore = Math.round(55 + progressGap * 0.45);
                const riskLevel = priorityScore >= 85 ? 'CRITICAL' : priorityScore >= 70 ? 'HIGH' : priorityScore >= 45 ? 'MEDIUM' : 'LOW';
                recommendations.push({
                    courseId: course.id,
                    courseName: course.name,
                    videoId: weakVideo.id,
                    videoTitle: weakVideo.title,
                    moduleName: weakVideo.moduleName,
                    reason: 'Você iniciou essa aula, mas ainda não consolidou o conteúdo.',
                    priorityScore,
                    riskLevel
                });
                continue;
            }

            const nextVideo = courseVideos.find((v: any) => {
                const h = historyMap.get(v.id);
                return v.status === 'READY' && (!h || !(h as any).completed);
            });

            if (nextVideo) {
                const priorityScore = 42;
                const riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' = 'MEDIUM';
                recommendations.push({
                    courseId: course.id,
                    courseName: course.name,
                    videoId: nextVideo.id,
                    videoTitle: nextVideo.title,
                    moduleName: nextVideo.moduleName,
                    reason: 'Próxima aula recomendada para manter ritmo de evolução.',
                    priorityScore,
                    riskLevel
                });
            }
        }

        recommendations.sort((a, b) => b.priorityScore - a.priorityScore);
        res.json(recommendations.slice(0, 6));
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Erro ao montar trilha inteligente.' });
    }
});

// ============================================================
// AULA INDIVIDUAL
// ============================================================
router.get('/lesson/:videoId', async (req: Request, res: Response): Promise<void> => {
    try {
        const userId = req.user!.id;
        const videoId = req.params.videoId as string;

        const video = await prisma.video.findUnique({
            where: { id: videoId },
            select: {
                id: true,
                title: true,
                description: true,
                content: true,
                thumbnailUrl: true,
                hlsUrl: true,
                status: true,
                order: true,
                moduleId: true,
                module: {
                    select: {
                        id: true,
                        name: true,
                        order: true,
                        pdfUrl: true,
                        course: { select: { id: true, name: true, calendarUrl: true } }
                    }
                }
            }
        });

        if (!video) {
            res.status(404).json({ message: 'Aula não encontrada.' });
            return;
        }

        // Enrollment check + prev/next em paralelo (ambos precisam do courseId)
        const courseId = video.module.course.id;
        const [enrollment, allModules] = await Promise.all([
            prisma.courseEnrollment.findUnique({
                where: { userId_courseId: { userId, courseId } }
            }),
            prisma.module.findMany({
                where: { courseId },
                orderBy: { order: 'asc' },
                select: {
                    videos: {
                        orderBy: { order: 'asc' },
                        select: { id: true, title: true }
                    }
                }
            })
        ]);

        if (!enrollment || enrollment.enrollmentRole !== 'STUDENT') {
            res.status(403).json({ message: 'Acesso negado. Você não está matriculado neste curso.' });
            return;
        }

        const allVideos = allModules.flatMap((m: any) => m.videos);
        const currentIndex = allVideos.findIndex((v: any) => v.id === videoId);
        const prevVideo = currentIndex > 0 ? allVideos[currentIndex - 1] : null;
        const nextVideo = currentIndex < allVideos.length - 1 ? allVideos[currentIndex + 1] : null;

        res.json({
            ...video,
            prevVideo,
            nextVideo
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Erro ao buscar aula.' });
    }
});

// ============================================================
// PROGRESSO
// ============================================================

// Salvar progresso de visualização
router.post('/progress', async (req: Request, res: Response): Promise<void> => {
    try {
        const userId = req.user!.id;
        const { videoId, progress } = req.body;

        if (!videoId) {
            res.status(400).json({ message: 'ID do vídeo é obrigatório.' });
            return;
        }

        const requestedPosition = Number(progress);
        if (!Number.isFinite(requestedPosition) || requestedPosition < 0 || requestedPosition > 24 * 60 * 60) {
            res.status(400).json({ message: 'Posição do vídeo inválida.' });
            return;
        }

        const video = await prisma.video.findUnique({
            where: { id: videoId },
            select: {
                durationSeconds: true,
                ...videoCourseSelect,
            }
        });

        if (!video) {
            res.status(404).json({ message: 'Vídeo não encontrado.' });
            return;
        }

        if (!await hasCourseEnrollment(userId, video.module.courseId)) {
            res.status(403).json({ message: 'Acesso negado. Você não está matriculado neste curso.' });
            return;
        }

        const previous = await prisma.videoHistory.findUnique({
            where: { userId_videoId: { userId, videoId } }
        });

        const policy = calculateProgressUpdate({
            requestedPosition,
            durationSeconds: video.durationSeconds,
            previous: previous ? {
                position: previous.progress,
                watchedSeconds: previous.watchedSeconds,
                lastPositionAt: previous.lastPositionAt,
                completed: previous.completed,
                completedAt: previous.completedAt
            } : null
        });

        const history = await prisma.videoHistory.upsert({
            where: { userId_videoId: { userId, videoId } },
            update: {
                progress: policy.position,
                watchedSeconds: policy.watchedSeconds,
                lastPositionAt: policy.lastPositionAt,
                completed: policy.completed,
                completedAt: policy.completedAt
            },
            create: {
                userId,
                videoId,
                progress: policy.position,
                watchedSeconds: policy.watchedSeconds,
                lastPositionAt: policy.lastPositionAt,
                completed: policy.completed,
                completedAt: policy.completedAt
            }
        });

        res.json({
            ...history,
            durationSeconds: video.durationSeconds,
            completionManagedByServer: true
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Erro ao salvar progresso.' });
    }
});

// Buscar progresso do aluno para um vídeo específico
router.get('/progress/:videoId', async (req: Request, res: Response): Promise<void> => {
    try {
        const userId = req.user!.id;
        const videoId = req.params.videoId as string;

        const history = await prisma.videoHistory.findUnique({
            where: { userId_videoId: { userId, videoId } }
        });

        res.json(history || { progress: 0, completed: false });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Erro ao buscar progresso.' });
    }
});

// ============================================================
// CERTIFICADO
// ============================================================
router.get('/certificate/:courseId', async (req: Request, res: Response): Promise<void> => {
    try {
        const userId = req.user!.id;
        const courseId = req.params.courseId as string;

        // Valida matrícula
        if (!await hasCourseEnrollment(userId, courseId)) {
            res.status(403).json({ message: 'Acesso negado.' });
            return;
        }

        // Busca curso + vídeos + progresso
        const course = await prisma.course.findUnique({
            where: { id: courseId },
            select: {
                name: true,
                modules: {
                    select: { videos: { select: { id: true } } }
                }
            }
        });

        if (!course) {
            res.status(404).json({ message: 'Curso não encontrado.' });
            return;
        }

        const videoIds = course.modules.flatMap((m: any) => m.videos.map((v: any) => v.id));
        if (videoIds.length === 0) {
            res.status(400).json({ message: 'Curso sem aulas.' });
            return;
        }

        const completedCount = await prisma.videoHistory.count({
            where: {
                userId,
                videoId: { in: videoIds },
                completed: true,
                completedAt: { not: null }
            }
        });

        if (completedCount < videoIds.length) {
            res.status(400).json({
                message: `Progresso incompleto: ${completedCount}/${videoIds.length} aulas concluídas.`
            });
            return;
        }

        // Busca nome do aluno
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { name: true }
        });

        const certificate = await prisma.certificate.upsert({
            where: { userId_courseId: { userId, courseId } },
            update: {},
            create: {
                userId,
                courseId,
                completedAt: new Date(),
                code: generateCertificateCode()
            }
        });

        const verifyUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/verify-certificate/${certificate.code}`;
        const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(verifyUrl)}`;

        // Retorna dados para o frontend gerar o certificado
        res.json({
            studentName: user!.name,
            courseName: course.name,
            completedAt: certificate.completedAt.toISOString(),
            totalLessons: videoIds.length,
            certificateCode: certificate.code,
            verifyUrl,
            qrUrl
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Erro ao gerar certificado.' });
    }
});

// ============================================================
// QUIZ POR AULA
// ============================================================
router.get('/lesson/:videoId/quiz', async (req: Request, res: Response): Promise<void> => {
    try {
        const userId = req.user!.id;
        const videoId = req.params.videoId as string;

        if (!await requireQuizVideoAccess(userId, videoId, res)) return;

        const questions = await prisma.quizQuestion.findMany({
            where: { videoId, active: true },
            orderBy: { order: 'asc' }
        });

        res.json(questions.map((q: any) => ({
            id: q.id,
            question: q.question,
            options: JSON.parse(q.optionsJson),
            difficulty: q.difficulty
        })));
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Erro ao carregar quiz da aula.' });
    }
});

router.post('/lesson/:videoId/quiz-attempt', async (req: Request, res: Response): Promise<void> => {
    try {
        const userId = req.user!.id;
        const videoId = req.params.videoId as string;
        const { answers } = req.body as { answers: Record<string, string> };

        if (!answers || typeof answers !== 'object') {
            res.status(400).json({ message: 'answers é obrigatório.' });
            return;
        }

        if (!await requireQuizVideoAccess(userId, videoId, res)) return;

        const questions = await prisma.quizQuestion.findMany({
            where: { videoId, active: true }
        });

        const details = questions.map((q: any) => {
            const selected = answers[q.id] || null;
            const correct = selected === q.correctAnswer;
            return {
                questionId: q.id,
                selected,
                correctAnswer: q.correctAnswer,
                correct,
                explanation: q.explanation || null
            };
        });

        const score = details.filter((d: any) => d.correct).length;
        const totalAnswers = questions.length;
        const feedback = buildAIQuizFeedback(score, totalAnswers);

        await prisma.quizAttempt.create({
            data: {
                userId,
                videoId,
                score,
                totalAnswers,
                feedback,
                answersJson: JSON.stringify(details)
            }
        });

        res.json({
            score,
            totalAnswers,
            percent: totalAnswers > 0 ? Math.round((score / totalAnswers) * 100) : 0,
            feedback,
            details
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Erro ao corrigir quiz.' });
    }
});

// ============================================================
// NOTIFICAÇÕES
// ============================================================
router.get('/notifications', async (req: Request, res: Response): Promise<void> => {
    try {
        const userId = req.user!.id;
        const notifications = await prisma.notification.findMany({
            where: { userId },
            orderBy: { createdAt: 'desc' },
            take: 50
        });
        res.json(notifications);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Erro ao buscar notificações.' });
    }
});

router.put('/notifications/read-all', async (req: Request, res: Response): Promise<void> => {
    try {
        const userId = req.user!.id;
        await prisma.notification.updateMany({
            where: { userId, read: false },
            data: { read: true }
        });
        res.json({ message: 'Todas marcadas como lidas.' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Erro ao marcar notificações.' });
    }
});

router.put('/notifications/:id/read', async (req: Request, res: Response): Promise<void> => {
    try {
        const userId = req.user!.id;
        const notifId = req.params.id as string;

        const notif = await prisma.notification.findUnique({ where: { id: notifId } });
        if (!notif || notif.userId !== userId) {
            res.status(404).json({ message: 'Notificação não encontrada.' });
            return;
        }

        await prisma.notification.update({ where: { id: notifId }, data: { read: true } });
        res.json({ message: 'Marcada como lida.' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Erro ao marcar notificação.' });
    }
});

// ============================================================
// AULAS AO VIVO (Live Classes)
// ============================================================

// LIST live classes for a course (enrolled students only)
router.get('/live-classes/:courseId', async (req: Request, res: Response): Promise<void> => {
    try {
        const userId = req.user!.id;
        const courseId = req.params.courseId as string;

        // Validate enrollment
        if (!await hasCourseEnrollment(userId, courseId)) {
            res.status(403).json({ message: 'Você não está matriculado neste curso.' });
            return;
        }

        const liveClasses = await findActiveLiveClasses(courseId);

        res.json(liveClasses.map((lc: any) => normalizeStudentLiveClass(lc)));
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Erro ao buscar aulas ao vivo.' });
    }
});

// GET live classes across all enrolled courses (for dashboard)
router.get('/my-live-classes', async (req: Request, res: Response): Promise<void> => {
    try {
        const userId = req.user!.id;

        const enrollments = await prisma.courseEnrollment.findMany({
            where: studentEnrollmentWhere(userId),
            select: { courseId: true }
        });
        const courseIds = enrollments.map((e: any) => e.courseId);

        const liveClasses = await findActiveLiveClasses({ in: courseIds }, true);

        res.json(liveClasses.map((lc: any) => normalizeStudentLiveClass(lc)));
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Erro ao buscar aulas ao vivo.' });
    }
});

// ============================================================
// COMENTÁRIOS DA AULA E MODERAÇÃO PREVENTIVA
// ============================================================

router.get('/comments/:videoId', async (req: Request, res: Response): Promise<void> => {
    try {
        const userId = req.user!.id;
        const videoId = req.params.videoId as string;
        if (!isIdentifier(videoId)) {
            res.status(400).json({ message: 'Aula inválida.' });
            return;
        }

        let afterDate: Date | undefined;
        if (req.query.after !== undefined) {
            if (typeof req.query.after !== 'string') {
                res.status(400).json({ message: 'Parâmetro after inválido.' });
                return;
            }
            afterDate = new Date(req.query.after);
            if (Number.isNaN(afterDate.getTime())) {
                res.status(400).json({ message: 'Parâmetro after deve ser uma data válida.' });
                return;
            }
        }

        const video = await prisma.video.findUnique({
            where: { id: videoId },
            select: { commentsEnabled: true, ...videoCourseSelect }
        });
        if (!video) {
            res.status(404).json({ message: 'Aula não encontrada.' });
            return;
        }

        if (!await hasCourseEnrollment(userId, video.module.courseId)) {
            res.status(403).json({ message: 'Acesso negado.' });
            return;
        }

        const banStatus = await checkForumBan(userId);
        const comments = await prisma.lessonComment.findMany({
            where: {
                videoId,
                parentId: null,
                ...(afterDate ? {
                    OR: [
                        { createdAt: { gt: afterDate } },
                        { replies: { some: { createdAt: { gt: afterDate } } } }
                    ]
                } : {})
            },
            orderBy: { createdAt: 'desc' },
            take: 100,
            select: {
                ...commentFieldsSelect,
                replies: {
                    orderBy: { createdAt: 'asc' },
                    take: 100,
                    select: commentFieldsSelect,
                },
            }
        });

        res.json({
            commentsEnabled: video.commentsEnabled,
            comments,
            forumBan: banStatus.banned ? {
                banType: banStatus.ban.banType,
                expiresAt: banStatus.ban.expiresAt,
                reason: banStatus.ban.reason
            } : null
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Erro ao buscar comentários.' });
    }
});

router.post('/comments', async (req: Request, res: Response): Promise<void> => {
    try {
        const userId = req.user!.id;
        const { videoId, text, parentId } = req.body ?? {};

        if (!isIdentifier(videoId) || typeof text !== 'string' || !text.trim()) {
            res.status(400).json({ message: 'Vídeo e texto são obrigatórios.' });
            return;
        }
        const normalizedText = text.trim();
        if (normalizedText.length > 2000) {
            res.status(400).json({ message: 'Comentário muito longo (máx. 2000 caracteres).' });
            return;
        }
        if (parentId !== undefined && parentId !== null && !isIdentifier(parentId)) {
            res.status(400).json({ message: 'Comentário pai inválido.' });
            return;
        }

        const banStatus = await checkForumBan(userId);
        if (banStatus.banned) {
            res.status(403).json({
                message: banStatus.ban.expiresAt
                    ? 'Seu acesso ao fórum está temporariamente suspenso.'
                    : 'Seu acesso ao fórum está suspenso permanentemente.',
                violation: true,
                banType: banStatus.ban.banType,
                expiresAt: banStatus.ban.expiresAt
            });
            return;
        }

        const video = await prisma.video.findUnique({
            where: { id: videoId },
            select: { commentsEnabled: true, ...videoCourseSelect }
        });
        if (!video) {
            res.status(404).json({ message: 'Aula não encontrada.' });
            return;
        }
        if (!video.commentsEnabled) {
            res.status(403).json({ message: 'Comentários desabilitados nesta aula.' });
            return;
        }

        if (!await hasCourseEnrollment(userId, video.module.courseId)) {
            res.status(403).json({ message: 'Acesso negado.' });
            return;
        }

        if (parentId) {
            const parent = await prisma.lessonComment.findUnique({
                where: { id: parentId },
                select: { videoId: true, parentId: true }
            });
            if (!parent || parent.videoId !== videoId || parent.parentId !== null) {
                res.status(400).json({ message: 'Comentário pai inválido.' });
                return;
            }
        }

        const filterResult = checkProfanity(normalizedText);
        if (filterResult.blocked && filterResult.severity && filterResult.matchedWord) {
            const punishment = await recordForumViolation(
                userId,
                filterResult.severity,
                filterResult.matchedWord,
                normalizedText
            );
            res.status(422).json({
                message: punishment.message,
                violation: true,
                severity: filterResult.severity,
                matchedWord: filterResult.matchedWord,
                action: punishment.action
            });
            return;
        }

        const comment = await prisma.lessonComment.create({
            data: { text: normalizedText, userId, videoId, parentId: parentId || null },
            select: {
                id: true,
                text: true,
                flagged: true,
                createdAt: true,
                userId: true,
                user: { select: { id: true, name: true, role: true } }
            }
        });
        res.status(201).json(comment);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Erro ao criar comentário.' });
    }
});

router.delete('/comments/:id', async (req: Request, res: Response): Promise<void> => {
    try {
        const commentId = req.params.id as string;
        if (!isIdentifier(commentId)) {
            res.status(400).json({ message: 'Comentário inválido.' });
            return;
        }
        const comment = await prisma.lessonComment.findUnique({
            where: { id: commentId },
            select: { userId: true }
        });
        if (!comment) {
            res.status(404).json({ message: 'Comentário não encontrado.' });
            return;
        }
        if (comment.userId !== req.user!.id) {
            res.status(403).json({ message: 'Sem permissão.' });
            return;
        }
        await prisma.lessonComment.delete({ where: { id: commentId } });
        res.json({ message: 'Comentário removido.' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Erro ao deletar comentário.' });
    }
});

router.post('/comments/:id/report', async (req: Request, res: Response): Promise<void> => {
    try {
        const userId = req.user!.id;
        const commentId = req.params.id as string;
        const reason = req.body?.reason;
        if (!isIdentifier(commentId) || typeof reason !== 'string') {
            res.status(400).json({ message: 'Comentário e motivo são obrigatórios.' });
            return;
        }
        const normalizedReason = reason.trim();
        if (normalizedReason.length < 3 || normalizedReason.length > 500) {
            res.status(400).json({ message: 'O motivo deve ter entre 3 e 500 caracteres.' });
            return;
        }

        const comment = await prisma.lessonComment.findUnique({
            where: { id: commentId },
            select: {
                userId: true,
                video: { select: { module: { select: { courseId: true } } } }
            }
        });
        if (!comment) {
            res.status(404).json({ message: 'Comentário não encontrado.' });
            return;
        }
        if (comment.userId === userId) {
            res.status(400).json({ message: 'Não é possível denunciar seu próprio comentário.' });
            return;
        }

        const enrollment = await prisma.courseEnrollment.findUnique({
            where: {
                userId_courseId: {
                    userId,
                    courseId: comment.video.module.courseId
                }
            },
            select: { id: true }
        });
        if (!enrollment) {
            res.status(403).json({ message: 'Acesso negado.' });
            return;
        }

        await prisma.$transaction(async (tx) => {
            await tx.commentReport.create({
                data: { commentId, userId, reason: normalizedReason }
            });
            const reportCount = await tx.commentReport.count({ where: { commentId } });
            if (reportCount >= 2) {
                await tx.lessonComment.update({ where: { id: commentId }, data: { flagged: true } });
            }
        });
        res.status(201).json({ message: 'Denúncia registrada.' });
    } catch (error: unknown) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002') {
            res.status(409).json({ message: 'Você já denunciou este comentário.' });
            return;
        }
        console.error(error);
        res.status(500).json({ message: 'Erro ao denunciar.' });
    }
});

// ============================================================
// STATUS, RECURSOS E PRESENÇA DO ALUNO
// ============================================================

router.get('/forum/my-status', async (req: Request, res: Response): Promise<void> => {
    try {
        const userId = req.user!.id;
        const [violations, totalViolations, banStatus, appeals] = await Promise.all([
            prisma.forumViolation.findMany({
                where: { userId },
                orderBy: { createdAt: 'desc' },
                take: 20,
                select: { id: true, word: true, severity: true, autoAction: true, createdAt: true }
            }),
            prisma.forumViolation.count({ where: { userId } }),
            checkForumBan(userId),
            prisma.forumAppeal.findMany({
                where: { userId },
                orderBy: { createdAt: 'desc' },
                take: 10,
                select: { id: true, reason: true, status: true, adminNote: true, createdAt: true, updatedAt: true }
            })
        ]);

        res.json({
            violations,
            totalViolations,
            ban: banStatus.banned ? {
                banType: banStatus.ban.banType,
                expiresAt: banStatus.ban.expiresAt,
                reason: banStatus.ban.reason,
                createdAt: banStatus.ban.createdAt
            } : null,
            appeals
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Erro ao buscar status do fórum.' });
    }
});

router.post('/forum/appeal', async (req: Request, res: Response): Promise<void> => {
    try {
        const reason = req.body?.reason;
        if (typeof reason !== 'string' || reason.trim().length < 10 || reason.trim().length > 2000) {
            res.status(400).json({ message: 'O recurso deve ter entre 10 e 2000 caracteres.' });
            return;
        }

        const userId = req.user!.id;
        const pendingAppeal = await prisma.forumAppeal.findFirst({
            where: { userId, status: 'PENDING' },
            select: { id: true }
        });
        if (pendingAppeal) {
            res.status(409).json({ message: 'Você já tem um recurso pendente aguardando análise.' });
            return;
        }

        const appeal = await prisma.forumAppeal.create({
            data: { userId, reason: reason.trim() },
            select: { id: true, reason: true, status: true, createdAt: true }
        });
        res.status(201).json(appeal);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Erro ao enviar recurso.' });
    }
});

router.post('/attendance/heartbeat', async (req: Request, res: Response): Promise<void> => {
    try {
        if (req.user!.role !== 'STUDENT') {
            res.status(403).json({ message: 'A presença automática é exclusiva para alunos.' });
            return;
        }

        const moduleId = req.body?.moduleId;
        if (!isIdentifier(moduleId)) {
            res.status(400).json({ message: 'moduleId é obrigatório.' });
            return;
        }

        const config = await prisma.platformConfig.findFirst({
            select: { attendanceEnabled: true, attendanceMinMinutes: true, attendanceMode: true }
        });
        if (!config?.attendanceEnabled) {
            res.json({ message: 'Sistema de presença desativado.', tracked: false });
            return;
        }

        const mod = await prisma.module.findUnique({
            where: { id: moduleId },
            select: { courseId: true }
        });
        if (!mod) {
            res.status(404).json({ message: 'Módulo não encontrado.' });
            return;
        }

        const userId = req.user!.id;
        const enrollment = await prisma.courseEnrollment.findUnique({
            where: { userId_courseId: { userId, courseId: mod.courseId } },
            select: { enrollmentRole: true }
        });
        if (!enrollment || enrollment.enrollmentRole !== 'STUDENT') {
            res.status(403).json({ message: 'Não matriculado neste curso como aluno.' });
            return;
        }

        const now = new Date();
        if (config.attendanceMode === 'DATE_ONLY' && !await hasScheduledClassOnLocalDate(moduleId, now)) {
            res.json({
                tracked: false,
                message: 'A presença deste módulo só pode ser registrada na data de uma aula ao vivo agendada.'
            });
            return;
        }

        const date = attendanceDate(now);
        const threshold = Math.max(1, Math.min(1440, config.attendanceMinMinutes)) * 60;
        let attendance = await prisma.attendance.findUnique({
            where: { userId_moduleId_date: { userId, moduleId, date } }
        });

        if (!attendance) {
            try {
                attendance = await prisma.attendance.create({
                    data: {
                        userId,
                        moduleId,
                        date,
                        status: 'ABSENT',
                        watchTimeSeconds: 0,
                        autoDetected: false
                    }
                });
            } catch (error: unknown) {
                if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002')) {
                    throw error;
                }
                attendance = await prisma.attendance.findUnique({
                    where: { userId_moduleId_date: { userId, moduleId, date } }
                });
            }
        }

        if (!attendance) {
            throw new Error('Falha ao inicializar presença');
        }

        // Credit only elapsed foreground time. Rapid/replayed requests earn zero,
        // and long background gaps are capped so they cannot manufacture presence.
        const elapsedSeconds = Math.max(0, Math.floor((now.getTime() - attendance.updatedAt.getTime()) / 1000));
        const creditedSeconds = Math.min(45, elapsedSeconds);
        if (creditedSeconds > 0) {
            const projected = attendance.watchTimeSeconds + creditedSeconds;
            const markPresent = attendance.status !== 'PRESENT' && projected >= threshold;
            const result = await prisma.attendance.updateMany({
                where: { id: attendance.id, updatedAt: attendance.updatedAt },
                data: {
                    watchTimeSeconds: { increment: creditedSeconds },
                    ...(markPresent ? { status: 'PRESENT', autoDetected: true } : {})
                }
            });
            if (result.count > 0) {
                attendance = await prisma.attendance.findUnique({ where: { id: attendance.id } }) ?? attendance;
            } else {
                attendance = await prisma.attendance.findUnique({ where: { id: attendance.id } }) ?? attendance;
            }
        }

        res.json({
            tracked: true,
            creditedSeconds,
            watchTimeSeconds: attendance.watchTimeSeconds,
            status: attendance.status,
            threshold
        });
    } catch (error) {
        console.error('Erro no heartbeat de presença:', error);
        res.status(500).json({ message: 'Erro ao registrar presença.' });
    }
});

export default router;
