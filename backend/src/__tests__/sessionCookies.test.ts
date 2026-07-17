import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import {
    CSRF_COOKIE,
    SESSION_COOKIE,
    authTtlHours,
    bearerTokenFromHeader,
    clearSessionCookies,
    csrfTokenForSession,
    issueSessionCookies,
    requireCsrf,
    sessionTokenFromRequest,
    synchronizeCsrfCookie,
} from '../lib/sessionCookies';

const SECRET = 'unit-test-secret-that-is-long-enough-for-hmac';

function request(headers: Record<string, string> = {}, method = 'GET', originalUrl = '/api/test'): Request {
    return { headers, method, originalUrl } as unknown as Request;
}

function responseDouble() {
    const response = {
        cookie: vi.fn(),
        clearCookie: vi.fn(),
        setHeader: vi.fn(),
        status: vi.fn(),
        json: vi.fn(),
    };
    response.status.mockReturnValue(response);
    return response as unknown as Response & typeof response;
}

beforeEach(() => {
    vi.stubEnv('JWT_SECRET', SECRET);
});

afterEach(() => {
    vi.unstubAllEnvs();
});

describe('session cookie transport', () => {
    it('accepts a case-insensitive Bearer scheme with horizontal whitespace', () => {
        expect(bearerTokenFromHeader('  bearer\tjwt-token  ')).toBe('jwt-token');
        expect(bearerTokenFromHeader('Bearer token extra')).toBeNull();
        expect(bearerTokenFromHeader('Basic token')).toBeNull();
    });

    it('lets an explicit real Bearer token override a stale browser cookie', () => {
        const req = request({
            cookie: `${SESSION_COOKIE}=stale-cookie`,
            authorization: 'Bearer integration-jwt',
        });
        expect(sessionTokenFromRequest(req)).toBe('integration-jwt');
    });

    it('uses the HttpOnly cookie when the SPA sends no Authorization header', () => {
        const req = request({ cookie: `${SESSION_COOKIE}=real-cookie-jwt` });
        expect(sessionTokenFromRequest(req)).toBe('real-cookie-jwt');
    });

    it('keeps the first cookie value when duplicate names are received', () => {
        const req = request({ cookie: `${SESSION_COOKIE}=first; ${SESSION_COOKIE}=second` });
        expect(sessionTokenFromRequest(req)).toBe('first');
    });

    it('clamps the configured session lifetime and emits matching cookies', () => {
        vi.stubEnv('NODE_ENV', 'test');
        vi.stubEnv('COOKIE_SECURE', 'false');
        vi.stubEnv('AUTH_TTL_HOURS', '72');
        expect(authTtlHours()).toBe(24);

        const res = responseDouble();
        issueSessionCookies(res, 'signed-jwt');

        expect(res.cookie).toHaveBeenCalledTimes(2);
        expect(res.cookie).toHaveBeenCalledWith(SESSION_COOKIE, 'signed-jwt', expect.objectContaining({
            httpOnly: true,
            sameSite: 'lax',
            secure: false,
            maxAge: 24 * 60 * 60 * 1000,
        }));
        expect(res.cookie).toHaveBeenCalledWith(CSRF_COOKIE, expect.any(String), expect.objectContaining({
            httpOnly: false,
        }));
        const csrfCall = res.cookie.mock.calls.find(([name]) => name === CSRF_COOKIE);
        expect(csrfCall?.[1]).toBe(csrfTokenForSession('signed-jwt'));
    });

    it('clears both cookies with the same security attributes', () => {
        vi.stubEnv('NODE_ENV', 'production');
        const res = responseDouble();
        clearSessionCookies(res);
        expect(res.clearCookie).toHaveBeenCalledWith(SESSION_COOKIE, expect.objectContaining({ secure: true, httpOnly: true }));
        expect(res.clearCookie).toHaveBeenCalledWith(CSRF_COOKIE, expect.objectContaining({ secure: true, httpOnly: false }));
    });

    it('binds the readable CSRF value to the exact HttpOnly session token', () => {
        expect(csrfTokenForSession('session-a')).not.toBe(csrfTokenForSession('session-b'));
        expect(csrfTokenForSession('session-a')).toBe(csrfTokenForSession('session-a'));
    });

    it('upgrades an old CSRF cookie once and preserves a current signed cookie', () => {
        const token = 'existing-session';
        const res = responseDouble();
        synchronizeCsrfCookie(
            request({ cookie: `${SESSION_COOKIE}=${token}; ${CSRF_COOKIE}=legacy-random` }),
            res,
            token,
            Math.floor(Date.now() / 1000) + 300,
        );
        expect(res.cookie).toHaveBeenCalledWith(
            CSRF_COOKIE,
            csrfTokenForSession(token),
            expect.objectContaining({ httpOnly: false, maxAge: expect.any(Number) }),
        );

        const currentResponse = responseDouble();
        synchronizeCsrfCookie(
            request({ cookie: `${SESSION_COOKIE}=${token}; ${CSRF_COOKIE}=${csrfTokenForSession(token)}` }),
            currentResponse,
            token,
        );
        expect(currentResponse.cookie).not.toHaveBeenCalled();
    });
});

describe('CSRF middleware', () => {
    it('accepts a state-changing cookie session only with the matching header', () => {
        const next = vi.fn() as NextFunction;
        const res = responseDouble();
        const signedCsrf = csrfTokenForSession('jwt');
        const req = request({
            cookie: `${SESSION_COOKIE}=jwt; ${CSRF_COOKIE}=${signedCsrf}`,
            'x-xsrf-token': signedCsrf,
        }, 'PATCH');

        requireCsrf(req, res, next);
        expect(next).toHaveBeenCalledOnce();
        expect(res.status).not.toHaveBeenCalled();
    });

    it('rejects a missing or mismatched CSRF token for cookie sessions', () => {
        const next = vi.fn() as NextFunction;
        const res = responseDouble();
        const req = request({ cookie: `${SESSION_COOKIE}=jwt; ${CSRF_COOKIE}=${csrfTokenForSession('jwt')}` }, 'DELETE');

        requireCsrf(req, res, next);
        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(403);
    });

    it('rejects cookie-tossing even when the attacker-controlled cookie and header match', () => {
        const next = vi.fn() as NextFunction;
        const res = responseDouble();
        const req = request({
            cookie: `${SESSION_COOKIE}=real-session; ${CSRF_COOKIE}=attacker-known-value`,
            'x-xsrf-token': 'attacker-known-value',
        }, 'POST');

        requireCsrf(req, res, next);
        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(403);
    });

    it('keeps stateless Bearer clients compatible when no session cookie exists', () => {
        const next = vi.fn() as NextFunction;
        const res = responseDouble();
        const req = request({ authorization: 'Bearer integration-jwt' }, 'POST');

        requireCsrf(req, res, next);
        expect(next).toHaveBeenCalledOnce();
    });

    it('uses Bearer semantics when an integration client also carries a stale cookie', () => {
        const next = vi.fn() as NextFunction;
        const res = responseDouble();
        const req = request({
            cookie: `${SESSION_COOKIE}=stale-cookie`,
            authorization: 'Bearer integration-jwt',
        }, 'PUT');

        requireCsrf(req, res, next);
        expect(next).toHaveBeenCalledOnce();
        expect(res.status).not.toHaveBeenCalled();
    });

    it('exempts only the exact login route', () => {
        const loginNext = vi.fn() as NextFunction;
        requireCsrf(
            request({ cookie: `${SESSION_COOKIE}=jwt` }, 'POST', '/api/auth/login?continue=1'),
            responseDouble(),
            loginNext,
        );
        expect(loginNext).toHaveBeenCalledOnce();

        const otherNext = vi.fn() as NextFunction;
        const otherResponse = responseDouble();
        requireCsrf(
            request({ cookie: `${SESSION_COOKIE}=jwt` }, 'POST', '/api/auth/login/anything'),
            otherResponse,
            otherNext,
        );
        expect(otherNext).not.toHaveBeenCalled();
        expect(otherResponse.status).toHaveBeenCalledWith(403);
    });

    it('clears local cookies when a logout request fails CSRF validation', () => {
        const res = responseDouble();
        requireCsrf(
            request({ cookie: `${SESSION_COOKIE}=invalid-session; ${CSRF_COOKIE}=tossed` }, 'POST', '/api/auth/logout'),
            res,
            vi.fn(),
        );
        expect(res.status).toHaveBeenCalledWith(403);
        expect(res.clearCookie).toHaveBeenCalledWith(SESSION_COOKIE, expect.any(Object));
        expect(res.clearCookie).toHaveBeenCalledWith(CSRF_COOKIE, expect.any(Object));
    });
});
