/**
 * auth.ts — Rotas de Autenticação e Perfil
 *
 * Endpoints:
 * - POST /login          → Autentica por username/e-mail e emite cookie HttpOnly
 * - GET  /me             → Retorna dados do usuário logado (validação de sessão)
 * - PUT  /profile        → Altera username e/ou senha (requer senha atual)
 * - GET  /stream-token   → Gera JWT de curta duração (1min) para streaming HLS
 *
 * Segurança: bcrypt (12 rounds), JWT HS256, cookie HttpOnly e double-submit CSRF
 */
import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { authenticateToken, revokeSessionToken } from '../middleware/authMiddleware';
import prisma from '../lib/prisma';
import logger from '../lib/logger';
import {
    authTtlHours,
    clearSessionCookies,
    issueSessionCookies,
    sessionTokenFromRequest,
} from '../lib/sessionCookies';

const router = Router();
const DUMMY_PASSWORD_HASH = '$2b$12$Apt1ZD1ooseUXRbizszi5e3UN47aUaUREEBQY2ND5peDE9tA5CL7m';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Credenciais, perfil e tokens de mídia nunca devem ser reutilizados por
// caches do navegador, CDN ou proxy intermediário.
router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Pragma', 'no-cache');
    next();
});

// Login endpoint - aceita username ou email
router.post('/login', async (req: Request, res: Response): Promise<void> => {
    try {
        const { login, email, password } = req.body;

        // Suporte a campo 'login' (username ou email) ou campo 'email' direto
        const rawIdentifier = login || email;
        if (typeof rawIdentifier !== 'string' || typeof password !== 'string') {
            res.status(400).json({ message: 'Usuário/email e senha são obrigatórios.' });
            return;
        }
        const identifier = rawIdentifier.trim();
        if (!identifier || identifier.length > 254 || password.length > 256) {
            res.status(400).json({ message: 'Usuário/email ou senha em formato inválido.' });
            return;
        }

        // Busca por username OU email
        const user = await prisma.user.findFirst({
            where: {
                OR: [
                    { username: { equals: identifier, mode: 'insensitive' } },
                    { email: { equals: identifier, mode: 'insensitive' } }
                ]
            }
        });

        // Executa o mesmo custo de hash quando o usuário não existe para não
        // criar um oráculo de enumeração por tempo de resposta.
        const passwordMatch = await bcrypt.compare(password, user?.password ?? DUMMY_PASSWORD_HASH);
        if (!user || !passwordMatch) {
            res.status(401).json({ message: 'Credenciais inválidas.' });
            return;
        }

        if (user.accessBlocked) {
            res.status(403).json({ message: 'Acesso bloqueado pela instituição. Procure a administração escolar.' });
            return;
        }

        // Gerar token
        const token = jwt.sign(
            { id: user.id, username: user.username, email: user.email, role: user.role, name: user.name, ver: user.tokenVersion },
            process.env.JWT_SECRET as string,
            { algorithm: 'HS256', expiresIn: authTtlHours() * 60 * 60 }
        );
        issueSessionCookies(res, token);

        res.json({
            user: {
                id: user.id,
                name: user.name,
                username: user.username,
                email: user.email,
                role: user.role,
                mustChangePassword: user.mustChangePassword,
                passwordChangedAt: user.passwordChangedAt
            }
        });
    } catch (error) {
        logger.error({ error }, 'Falha inesperada no login');
        res.status(500).json({ message: 'Erro interno no servidor' });
    }
});

// Get current user profile
router.get('/me', authenticateToken, async (req: Request, res: Response): Promise<void> => {
    try {
        const userId = req.user!.id;
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: {
                id: true,
                username: true,
                name: true,
                email: true,
                role: true,
                createdAt: true,
                mustChangePassword: true,
                passwordChangedAt: true
            }
        });

        if (!user) {
            res.status(404).json({ message: 'Usuário não encontrado' });
            return;
        }

        res.json(user);
    } catch (error) {
        res.status(500).json({ message: 'Erro interno no servidor' });
    }
});

// Atualizar credenciais do próprio perfil (username e/ou senha)
router.put('/profile', authenticateToken, async (req: Request, res: Response): Promise<void> => {
    try {
        const userId = req.user!.id;
        const { currentPassword, newUsername, newPassword } = req.body;

        if (typeof currentPassword !== 'string' || !currentPassword || currentPassword.length > 256) {
            res.status(400).json({ message: 'Senha atual é obrigatória para alterar credenciais.' });
            return;
        }

        // Validar senha atual
        const user = await prisma.user.findUnique({ where: { id: userId } });
        if (!user) {
            res.status(404).json({ message: 'Usuário não encontrado.' });
            return;
        }

        const passwordMatch = await bcrypt.compare(currentPassword, user.password);
        if (!passwordMatch) {
            res.status(401).json({ message: 'Senha atual incorreta.' });
            return;
        }

        // Preparar dados para atualização
        const updateData: Record<string, unknown> = {};

        if (newUsername && newUsername !== user.username) {
            if (typeof newUsername !== 'string' || !/^[a-zA-Z0-9._-]{3,50}$/.test(newUsername.trim())) {
                res.status(400).json({ message: 'Nome de usuário deve ter 3–50 caracteres (letras, números, ponto, hífen ou sublinhado).' });
                return;
            }
            const normalizedUsername = newUsername.trim().toLowerCase();
            // Verificar se username já existe
            const existingUser = await prisma.user.findFirst({
                where: {
                    id: { not: userId },
                    username: { equals: normalizedUsername, mode: 'insensitive' }
                }
            });
            if (existingUser) {
                res.status(409).json({ message: 'Este nome de usuário já está em uso.' });
                return;
            }
            updateData.username = normalizedUsername;
        }

        if (user.mustChangePassword && !newPassword) {
            res.status(400).json({ message: 'É obrigatório definir uma nova senha antes de continuar.' });
            return;
        }

        if (newPassword) {
            if (typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 128) {
                res.status(400).json({ message: 'A nova senha deve ter pelo menos 8 caracteres.' });
                return;
            }
            if (!/[A-Z]/.test(newPassword) || !/[a-z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
                res.status(400).json({ message: 'A senha deve conter letras maiúsculas, minúsculas e números.' });
                return;
            }
            updateData.password = await bcrypt.hash(newPassword, 12);
            updateData.mustChangePassword = false;
            updateData.passwordChangedAt = new Date();
            updateData.tokenVersion = { increment: 1 };
        }

        if (Object.keys(updateData).length === 0) {
            res.status(400).json({ message: 'Nenhuma alteração informada.' });
            return;
        }

        // Atualizar no banco
        const updatedUser = await prisma.user.update({
            where: { id: userId },
            data: updateData,
            select: {
                id: true,
                username: true,
                name: true,
                email: true,
                role: true,
                mustChangePassword: true,
                passwordChangedAt: true,
                tokenVersion: true
            }
        });

        // Gerar novo token com dados atualizados
        const newToken = jwt.sign(
            { id: updatedUser.id, username: updatedUser.username, email: updatedUser.email, role: updatedUser.role, name: updatedUser.name, ver: updatedUser.tokenVersion },
            process.env.JWT_SECRET as string,
            { algorithm: 'HS256', expiresIn: authTtlHours() * 60 * 60 }
        );
        issueSessionCookies(res, newToken);

        res.json({
            message: 'Credenciais atualizadas com sucesso!',
            user: updatedUser
        });
    } catch (error) {
        logger.error({ error, userId: req.user?.id }, 'Falha ao atualizar credenciais');
        res.status(500).json({ message: 'Erro ao atualizar credenciais.' });
    }
});

export async function logoutHandler(req: Request, res: Response): Promise<void> {
    let revocationFailed = false;
    try {
        const token = sessionTokenFromRequest(req);
        if (token) await revokeSessionToken(token);
    } catch (error) {
        revocationFailed = true;
        logger.error({ error }, 'Falha ao revogar sessão durante logout');
    } finally {
        clearSessionCookies(res);
    }

    if (revocationFailed) {
        res.status(503).json({ message: 'Sessão local encerrada; revogação remota temporariamente indisponível.' });
        return;
    }
    res.status(204).send();
}

router.post('/logout', logoutHandler);

// Token de streaming de 1 min: bloqueios administrativos interrompem a
// renovação imediatamente e limitam a janela residual sem consultar o banco
// em cada segmento HLS.
router.get('/stream-token', authenticateToken, async (req: Request, res: Response): Promise<void> => {
    try {
        const videoId = typeof req.query.videoId === 'string' ? req.query.videoId : '';
        if (!UUID_PATTERN.test(videoId)) {
            res.status(400).json({ message: 'videoId válido é obrigatório.' });
            return;
        }
        const video = await prisma.video.findUnique({
            where: { id: videoId },
            select: { module: { select: { courseId: true } } }
        });
        if (!video) {
            res.status(404).json({ message: 'Vídeo não encontrado.' });
            return;
        }
        if (req.user!.role === 'STUDENT') {
            const enrollment = await prisma.courseEnrollment.findUnique({
                where: { userId_courseId: { userId: req.user!.id, courseId: video.module.courseId } },
                select: { id: true }
            });
            if (!enrollment) {
                res.status(403).json({ message: 'Você não está matriculado neste curso.' });
                return;
            }
        } else if (req.user!.role === 'TEACHER') {
            const assignment = await prisma.courseEnrollment.findUnique({
                where: { userId_courseId: { userId: req.user!.id, courseId: video.module.courseId } },
                select: { id: true, enrollmentRole: true }
            });
            if (assignment?.enrollmentRole !== 'TEACHER') {
                res.status(403).json({ message: 'Professor não está atribuído a este curso.' });
                return;
            }
        } else if (req.user!.role === 'GUARDIAN') {
            const dependentAccess = await prisma.guardianLink.findFirst({
                where: {
                    guardianId: req.user!.id,
                    student: {
                        schoolEnrollments: {
                            some: { status: 'ACTIVE', schoolClass: { courseId: video.module.courseId } }
                        }
                    }
                },
                select: { id: true }
            });
            if (!dependentAccess) {
                res.status(403).json({ message: 'Responsável não possui dependente matriculado neste curso.' });
                return;
            }
        } else if (req.user!.role !== 'ADMIN') {
            res.status(403).json({ message: 'Seu perfil não autoriza acesso direto a esta mídia.' });
            return;
        }
        const streamToken = jwt.sign(
            {
                id: req.user!.id,
                role: req.user!.role,
                purpose: 'stream',
                videoId,
                ver: req.user!.ver
            },
            process.env.JWT_SECRET as string,
            { algorithm: 'HS256', expiresIn: '1m' }
        );
        res.json({ streamToken });
    } catch (error) {
        logger.error({ error, userId: req.user?.id }, 'Falha ao gerar token de streaming');
        res.status(500).json({ message: 'Erro ao gerar token de streaming.' });
    }
});

export default router;
