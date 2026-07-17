/**
 * VideoPlayer.tsx — Player de Vídeo Seguro com HLS Streaming
 *
 * Funcionalidades:
 * - Inicializa video.js com source HLS (.m3u8) autenticada via stream-token
 * - Restaura progresso de visualização anterior (GET /api/student/progress)
 * - Salva progresso a cada 10 segundos (POST /api/student/progress)
 * - Renova stream token automaticamente a cada 4 minutos (expira em 5)
 *
 * Proteções e rastreabilidade:
 * - Marca d'água dinâmica (nome + email) flutuando a cada 15s
 * - Token HLS curto e vinculado à aula
 * - Presença opcional por heartbeat durante reprodução real
 */
import { useEffect, useRef } from 'react';
import videojs from 'video.js';
import 'video.js/dist/video-js.css';
import { useAuth } from '../context/AuthContext';
import { useConfig } from '../context/ConfigContext';
import api from '../lib/api';
import { API_BASE_URL, resolveMediaUrl } from '../lib/urls';
import type Player from 'video.js/dist/types/player';

interface VhsRequestOptions {
    headers?: Record<string, string>;
    [key: string]: unknown;
}

interface VhsXhrHooks {
    onRequest: (hook: (options: VhsRequestOptions) => VhsRequestOptions) => void;
    offRequest: (hook: (options: VhsRequestOptions) => VhsRequestOptions) => void;
}

interface VhsTech {
    vhs?: { xhr?: VhsXhrHooks };
}

interface VideoPlayerProps {
    videoId: string;
    hlsUrl: string;
    moduleId?: string;
}

export default function VideoPlayer({ videoId, hlsUrl, moduleId }: VideoPlayerProps) {
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const playerRef = useRef<Player | null>(null);
    const watermarkRef = useRef<HTMLDivElement | null>(null);
    const { user } = useAuth();
    const { config } = useConfig();

    useEffect(() => {
        if (!videoRef.current) return;

        const videoElement = videoRef.current;
        let progressInterval: ReturnType<typeof setInterval> | undefined;
        let attendanceInterval: ReturnType<typeof setInterval> | undefined;
        let tokenRefreshInterval: ReturnType<typeof setInterval> | undefined;
        let flushOnPageHide: (() => void) | undefined;
        const abortController = new AbortController();
        let streamToken = '';
        let requestHookRegistered = false;
        let lastSentPosition = -1;

        const saveProgress = (player: Player, keepalive = false) => {
            if (player.isDisposed()) return;
            const current = Math.max(0, player.currentTime() || 0);
            if (!keepalive && Math.abs(current - lastSentPosition) < 0.75) return;
            lastSentPosition = current;
            const payload = JSON.stringify({ videoId, progress: current });

            if (keepalive) {
                const csrf = document.cookie
                    .split('; ')
                    .find((item) => item.startsWith('XSRF-TOKEN='))
                    ?.split('=').slice(1).join('=');
                void fetch(`${API_BASE_URL}/api/student/progress`, {
                    method: 'POST',
                    credentials: 'include',
                    keepalive: true,
                    headers: {
                        'Content-Type': 'application/json',
                        ...(csrf ? { 'X-XSRF-TOKEN': decodeURIComponent(csrf) } : {})
                    },
                    body: payload
                }).catch(() => undefined);
                return;
            }

            void api.post('/api/student/progress', { videoId, progress: current })
                .catch(() => undefined);
        };

        const initPlayer = async () => {
            const hlsSrc = resolveMediaUrl(hlsUrl);
            const sourceType = hlsSrc.includes('.m3u8') ? 'application/x-mpegURL' : 'video/mp4';
            const hlsTarget = new URL(hlsSrc, window.location.origin);
            const apiOrigin = new URL(API_BASE_URL || window.location.origin, window.location.origin).origin;
            const requiresStreamToken = sourceType === 'application/x-mpegURL'
                && hlsTarget.origin === apiOrigin
                && hlsTarget.pathname.startsWith('/hls/');

            // 1. Fetch initial progress
            let initialTime = 0;
            try {
                const res = await api.get(`/api/student/progress/${videoId}`, {
                    signal: abortController.signal
                });
                if (res.data && res.data.progress) {
                    initialTime = res.data.progress;
                }
            } catch (e) {
                if (!abortController.signal.aborted) console.error('Error fetching progress', e);
            }

            if (abortController.signal.aborted) return;

            if (requiresStreamToken) {
                const streamResponse = await api.get('/api/auth/stream-token', {
                    params: { videoId },
                    signal: abortController.signal
                });
                streamToken = streamResponse.data.streamToken;
            }

            // 2. Initialize video.js
            const player = playerRef.current = videojs(videoElement, {
                controls: true,
                fluid: true,
                playbackRates: [0.5, 1, 1.25, 1.5, 2],
                html5: { vhs: { overrideNative: true } }
            });

            const requestHook = (options: VhsRequestOptions): VhsRequestOptions => ({
                ...options,
                headers: {
                    ...options.headers,
                    ...(streamToken ? { Authorization: `Bearer ${streamToken}` } : {})
                }
            });
            const registerRequestHook = () => {
                const xhr = (player.tech() as unknown as VhsTech)?.vhs?.xhr;
                if (xhr && !requestHookRegistered) {
                    xhr.onRequest(requestHook);
                    requestHookRegistered = true;
                }
            };
            player.on('xhr-hooks-ready', registerRequestHook);
            player.src({ src: hlsSrc, type: sourceType });

            player.ready(() => {
                if (initialTime > 0) {
                    player.currentTime(initialTime);
                }
            });

            // 3. Save progress periodically
            progressInterval = setInterval(() => {
                if (player && !player.paused()) {
                    saveProgress(player);
                }
            }, 10000);

            player.on('pause', () => saveProgress(player));
            player.on('ended', () => saveProgress(player));
            flushOnPageHide = () => saveProgress(player, true);
            window.addEventListener('pagehide', flushOnPageHide);

            if (config.attendanceEnabled && moduleId) {
                attendanceInterval = setInterval(() => {
                    if (!player.isDisposed() && !player.paused()) {
                        void api.post('/api/student/attendance/heartbeat', { moduleId }, { signal: abortController.signal })
                            .catch(() => undefined);
                    }
                }, 30_000);
            }

            if (requiresStreamToken) {
                tokenRefreshInterval = setInterval(() => {
                    void api.get('/api/auth/stream-token', { params: { videoId } })
                        .then(response => { streamToken = response.data.streamToken; })
                        .catch(() => undefined);
                }, 45 * 1000);
            }

        };

        void initPlayer().catch((error) => {
            if (!abortController.signal.aborted) console.error('Falha ao inicializar player seguro', error);
        });

        // Marca d'água dinâmica; movimento desabilitado para reduced-motion.
        let moveInterval: ReturnType<typeof setInterval> | undefined;
        if (watermarkRef.current && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            moveInterval = setInterval(() => {
                if (watermarkRef.current) {
                    const top = Math.random() * 80;
                    const left = Math.random() * 80;
                    watermarkRef.current.style.top = `${top}%`;
                    watermarkRef.current.style.left = `${left}%`;
                }
            }, 15000);
        }

        return () => {
            if (playerRef.current && !playerRef.current.isDisposed()) saveProgress(playerRef.current, true);
            abortController.abort();
            if (playerRef.current && !playerRef.current.isDisposed()) {
                playerRef.current.dispose();
            }
            clearInterval(moveInterval);
            clearInterval(progressInterval);
            clearInterval(attendanceInterval);
            clearInterval(tokenRefreshInterval);
            if (flushOnPageHide) window.removeEventListener('pagehide', flushOnPageHide);
        };
    }, [config.attendanceEnabled, hlsUrl, moduleId, videoId]);

    return (
        <div style={{ position: 'relative', width: '100%', borderRadius: '0', overflow: 'hidden' }}>

            {/* Container do Vídeo */}
            <div data-vjs-player>
                <video ref={videoRef} className="video-js vjs-theme-city vjs-big-play-centered" />
            </div>

            {/* Marca D'Água Dinâmica */}
            <div
                ref={watermarkRef}
                style={{
                    position: 'absolute',
                    top: '10%',
                    left: '10%',
                    opacity: 0.35,
                    color: 'white',
                    backgroundColor: 'rgba(0,0,0,0.4)',
                    padding: '4px 8px',
                    borderRadius: '4px',
                    fontSize: '12px',
                    pointerEvents: 'none',
                    zIndex: 99,
                    transition: 'top 2s ease-in-out, left 2s ease-in-out',
                    userSelect: 'none'
                }}
            >
                {user?.name} <br />
                {user?.email} <br />
                {new Date().toLocaleDateString('pt-BR')} - Confidencial
            </div>
        </div>
    );
}
