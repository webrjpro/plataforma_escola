import crypto from 'crypto';
import { NextFunction, Request, Response } from 'express';

export const SESSION_COOKIE = 'eduvault_session';
export const CSRF_COOKIE = 'XSRF-TOKEN';
const DEFAULT_TTL_HOURS = 8;

function parseCookies(header?: string): Record<string, string> {
    const cookies: Record<string, string> = Object.create(null) as Record<string, string>;
    if (!header) return cookies;

    return header.split(';').reduce<Record<string, string>>((parsed, part) => {
        const separator = part.indexOf('=');
        if (separator <= 0) return parsed;
        const key = part.slice(0, separator).trim();
        // Mantém o primeiro cookie quando há nomes duplicados, como fazem os
        // parsers HTTP usuais. Isso evita que um valor posterior e ambíguo
        // sobrescreva silenciosamente o cookie selecionado pelo navegador.
        if (!key || Object.prototype.hasOwnProperty.call(parsed, key)) return parsed;
        const rawValue = part.slice(separator + 1).trim();
        try {
            parsed[key] = decodeURIComponent(rawValue);
        } catch {
            parsed[key] = rawValue;
        }
        return parsed;
    }, cookies);
}

export function authTtlHours(): number {
    const configured = Number(process.env.AUTH_TTL_HOURS || DEFAULT_TTL_HOURS);
    return Number.isFinite(configured) ? Math.min(24, Math.max(1, Math.floor(configured))) : DEFAULT_TTL_HOURS;
}

function secureCookies(): boolean {
    return process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production';
}

export function sessionCookieFromRequest(req: Request): string | null {
    return parseCookies(req.headers.cookie)[SESSION_COOKIE] ?? null;
}

export function sessionTokenFromRequest(req: Request): string | null {
    const cookieToken = sessionCookieFromRequest(req);
    const bearerToken = bearerTokenFromHeader(req.headers.authorization);

    // Um Authorization explícito é a credencial escolhida por clientes de
    // integração; o SPA usa somente o cookie HttpOnly.
    return bearerToken || cookieToken;
}

export function bearerTokenFromHeader(header?: string): string | null {
    if (!header) return null;
    const match = /^\s*Bearer[\t ]+([^\s,]+)\s*$/i.exec(header);
    return match?.[1] ?? null;
}

export function issueSessionCookies(res: Response, token: string): void {
    const maxAge = authTtlHours() * 60 * 60 * 1000;
    const base = cookieOptions(maxAge);

    res.cookie(SESSION_COOKIE, token, { ...base, httpOnly: true });
    res.cookie(CSRF_COOKIE, csrfTokenForSession(token), { ...base, httpOnly: false });
}

export function synchronizeCsrfCookie(req: Request, res: Response, token: string, expiresAt?: number): void {
    const expected = csrfTokenForSession(token);
    if (safeEqual(parseCookies(req.headers.cookie)[CSRF_COOKIE], expected)) return;

    const remainingMs = expiresAt
        ? Math.max(1_000, (expiresAt * 1_000) - Date.now())
        : authTtlHours() * 60 * 60 * 1000;
    res.cookie(CSRF_COOKIE, expected, { ...cookieOptions(remainingMs), httpOnly: false });
}

export function clearSessionCookies(res: Response): void {
    const base = { secure: secureCookies(), sameSite: 'lax' as const, path: '/' };
    res.clearCookie(SESSION_COOKIE, { ...base, httpOnly: true });
    res.clearCookie(CSRF_COOKIE, { ...base, httpOnly: false });
}

export function csrfTokenForSession(token: string): string {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error('JWT_SECRET ausente ao derivar token CSRF.');
    return crypto.createHmac('sha256', secret)
        .update('eduvault:csrf:v1\0', 'utf8')
        .update(token, 'utf8')
        .digest('base64url');
}

function cookieOptions(maxAge: number) {
    return {
        secure: secureCookies(),
        sameSite: 'lax' as const,
        path: '/',
        maxAge,
    };
}

function safeEqual(left?: string, right?: string): boolean {
    if (!left || !right) return false;
    const leftHash = crypto.createHash('sha256').update(left).digest();
    const rightHash = crypto.createHash('sha256').update(right).digest();
    return crypto.timingSafeEqual(leftHash, rightHash);
}

export function requireCsrf(req: Request, res: Response, next: NextFunction): void {
    const requestPath = req.originalUrl.split('?', 1)[0].replace(/\/+$/, '');
    const isLogin = req.method === 'POST' && requestPath === '/api/auth/login';
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) || isLogin) {
        next();
        return;
    }

    const cookies = parseCookies(req.headers.cookie);
    const bearerToken = bearerTokenFromHeader(req.headers.authorization);
    if (!cookies[SESSION_COOKIE] || bearerToken) {
        // Clientes de integração que usam Bearer continuam suportados.
        next();
        return;
    }

    const header = req.headers['x-xsrf-token'];
    const headerValue = Array.isArray(header) ? header[0] : header;
    const expected = csrfTokenForSession(cookies[SESSION_COOKIE]);
    if (!safeEqual(cookies[CSRF_COOKIE], headerValue)
        || !safeEqual(cookies[CSRF_COOKIE], expected)) {
        // Mesmo uma sessão expirada/corrompida deve poder desaparecer do
        // navegador. A revogação no banco só ocorre quando o par CSRF é válido.
        if (requestPath === '/api/auth/logout') clearSessionCookies(res);
        res.status(403).json({ message: 'Token CSRF ausente ou inválido.' });
        return;
    }
    next();
}
