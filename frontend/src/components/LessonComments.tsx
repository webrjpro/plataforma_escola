/**
 * LessonComments.tsx — Fórum de Comentários por Aula
 *
 * - Polling a cada 5s (quase tempo real)
 * - Respostas com 1 nível de profundidade
 * - Botão de denunciar
 * - Badge "Professor" para ADMIN/TEACHER
 * - Pausa polling quando aba está inativa
 * - Sistema de violações e ban com recurso
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { MessageSquare, Send, Reply, Flag, Trash2, ChevronDown, ChevronUp, ShieldCheck, AlertTriangle, Ban, Scale } from 'lucide-react';
import axios from 'axios';
import api from '../lib/api';

interface CommentUser {
    id: string;
    name: string;
    role: 'ADMIN' | 'TEACHER' | 'STUDENT';
}

interface CommentData {
    id: string;
    text: string;
    flagged: boolean;
    createdAt: string;
    userId: string;
    user: CommentUser;
    replies?: CommentData[];
    _count?: { reports: number };
}

interface Props {
    videoId: string;
}

function errorPayload(error: unknown): Record<string, unknown> {
    const value = axios.isAxiosError(error) ? error.response?.data : null;
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function payloadText(payload: Record<string, unknown>, key: string, fallback = ''): string {
    const value = payload[key];
    return typeof value === 'string' ? value : fallback;
}

function mergeCommentRoots(current: CommentData[], incoming: CommentData[]): CommentData[] {
    const byId = new Map(current.map((comment) => [comment.id, comment]));
    incoming.forEach((comment) => byId.set(comment.id, comment));
    return [...byId.values()].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}

function latestCommentTimestamp(comments: CommentData[], fallback: string): string {
    let latest = Date.parse(fallback);
    comments.forEach((comment) => {
        latest = Math.max(latest, Date.parse(comment.createdAt) || 0);
        comment.replies?.forEach((reply) => { latest = Math.max(latest, Date.parse(reply.createdAt) || 0); });
    });
    return new Date(latest).toISOString();
}

export default function LessonComments({ videoId }: Props) {
    const { user } = useAuth();
    const [comments, setComments] = useState<CommentData[]>([]);
    const [commentsEnabled, setCommentsEnabled] = useState(true);
    const [newComment, setNewComment] = useState('');
    const [replyingTo, setReplyingTo] = useState<string | null>(null);
    const [replyText, setReplyText] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [expandedReplies, setExpandedReplies] = useState<Set<string>>(new Set());
    const [reportingId, setReportingId] = useState<string | null>(null);
    const [reportReason, setReportReason] = useState('');
    const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const pollingInFlightRef = useRef(false);
    const lastSyncRef = useRef('');
    const lastFullRefreshRef = useRef(0);

    // Estados do sistema de punição
    const [forumBan, setForumBan] = useState<{ banType: string; expiresAt: string | null; reason: string } | null>(null);
    const [violationModal, setViolationModal] = useState<{ message: string; severity: string; matchedWord: string; action: string } | null>(null);
    const [appealText, setAppealText] = useState('');
    const [showAppealForm, setShowAppealForm] = useState(false);
    const [appealSubmitting, setAppealSubmitting] = useState(false);
    const [appealSuccess, setAppealSuccess] = useState(false);

    const fetchComments = useCallback(async (mode: 'full' | 'incremental' = 'full') => {
        try {
            const url = `/api/student/comments/${videoId}`;
            const incremental = mode === 'incremental' && Boolean(lastSyncRef.current);
            const cursorFallback = new Date(Date.now() - 30_000).toISOString();
            const res = await api.get(url, {
                params: incremental ? { after: lastSyncRef.current } : undefined
            });
            const received = Array.isArray(res.data.comments) ? res.data.comments as CommentData[] : [];
            setCommentsEnabled(res.data.commentsEnabled);
            setComments((current) => incremental ? mergeCommentRoots(current, received) : received);
            lastSyncRef.current = latestCommentTimestamp(received, cursorFallback);
            if (!incremental) lastFullRefreshRef.current = Date.now();
            // Atualiza status do ban
            if (res.data.forumBan) {
                setForumBan(res.data.forumBan);
            } else {
                setForumBan(null);
            }
        } catch {
            // silencioso no polling
        }
    }, [videoId]);

    // Fetch inicial
    useEffect(() => {
        lastSyncRef.current = '';
        lastFullRefreshRef.current = 0;
        void fetchComments('full');
    }, [fetchComments]);

    // Polling incremental enquanto a aba está visível. Uma leitura completa
    // periódica reconcilia exclusões e ações de moderação.
    useEffect(() => {
        const poll = () => {
            if (document.visibilityState !== 'visible' || pollingInFlightRef.current) return;
            pollingInFlightRef.current = true;
            const needsFullRefresh = Date.now() - lastFullRefreshRef.current >= 120_000;
            void fetchComments(needsFullRefresh ? 'full' : 'incremental')
                .finally(() => { pollingInFlightRef.current = false; });
        };

        const startPolling = () => {
            if (pollingRef.current) clearInterval(pollingRef.current);
            pollingRef.current = setInterval(poll, 15_000);
        };

        startPolling();

        const handleVisibility = () => {
            if (document.visibilityState === 'visible') {
                poll();
                startPolling();
            }
        };
        document.addEventListener('visibilitychange', handleVisibility);

        return () => {
            if (pollingRef.current) clearInterval(pollingRef.current);
            document.removeEventListener('visibilitychange', handleVisibility);
        };
    }, [fetchComments]);

    const handleSubmit = async (parentId?: string) => {
        const text = parentId ? replyText : newComment;
        if (!text.trim() || submitting) return;

        setSubmitting(true);
        setError(null);

        try {
            await api.post('/api/student/comments', {
                videoId,
                text: text.trim(),
                parentId: parentId || undefined
            });

            if (parentId) {
                setReplyText('');
                setReplyingTo(null);
            } else {
                setNewComment('');
            }

            // Recarrega comentários
            await fetchComments();
        } catch (err: unknown) {
            const data = errorPayload(err);
            // Se é violação, mostra modal especial
            if (data.violation) {
                const severity = payloadText(data, 'severity');
                const matchedWord = payloadText(data, 'matchedWord');
                if (severity && matchedWord) {
                    setViolationModal({
                        message: payloadText(data, 'message', 'O comentário viola as regras da comunidade.'),
                        severity,
                        matchedWord,
                        action: payloadText(data, 'action', 'WARNING')
                    });
                } else {
                    // Ban existente
                    setForumBan({
                        banType: payloadText(data, 'banType', 'UNKNOWN'),
                        expiresAt: payloadText(data, 'expiresAt') || null,
                        reason: payloadText(data, 'message', 'Acesso ao fórum suspenso.')
                    });
                }
            } else {
                setError(payloadText(data, 'message', 'Erro ao enviar comentário.'));
                setTimeout(() => setError(null), 4000);
            }
        } finally {
            setSubmitting(false);
        }
    };

    const handleDelete = async (commentId: string) => {
        try {
            await api.delete(`/api/student/comments/${commentId}`);
            await fetchComments();
        } catch {
            setError('Erro ao deletar comentário.');
            setTimeout(() => setError(null), 3000);
        }
    };

    const handleReport = async (commentId: string) => {
        if (!reportReason.trim()) return;
        try {
            await api.post(`/api/student/comments/${commentId}/report`, {
                reason: reportReason.trim()
            });
            setReportingId(null);
            setReportReason('');
            setError(null);
        } catch (err: unknown) {
            const msg = payloadText(errorPayload(err), 'message', 'Erro ao denunciar.');
            setError(msg);
            setTimeout(() => setError(null), 3000);
        }
    };

    const toggleReplies = (commentId: string) => {
        setExpandedReplies(prev => {
            const next = new Set(prev);
            if (next.has(commentId)) next.delete(commentId);
            else next.add(commentId);
            return next;
        });
    };

    const formatTime = (dateStr: string) => {
        const date = new Date(dateStr);
        const now = new Date();
        const diffMs = now.getTime() - date.getTime();
        const diffMin = Math.floor(diffMs / 60000);
        const diffH = Math.floor(diffMin / 60);
        const diffD = Math.floor(diffH / 24);

        if (diffMin < 1) return 'agora';
        if (diffMin < 60) return `${diffMin}min`;
        if (diffH < 24) return `${diffH}h`;
        if (diffD < 7) return `${diffD}d`;
        return date.toLocaleDateString('pt-BR');
    };

    const isTeacher = (role: string) => role === 'ADMIN' || role === 'TEACHER';

    const handleAppealSubmit = async () => {
        if (!appealText.trim() || appealText.trim().length < 10 || appealSubmitting) return;
        setAppealSubmitting(true);
        try {
            await api.post('/api/student/forum/appeal', { reason: appealText.trim() });
            setAppealSuccess(true);
            setShowAppealForm(false);
            setAppealText('');
        } catch (err: unknown) {
            setError(payloadText(errorPayload(err), 'message', 'Erro ao enviar recurso.'));
            setTimeout(() => setError(null), 4000);
        } finally {
            setAppealSubmitting(false);
        }
    };

    const getSeverityLabel = (severity: string) => {
        switch (severity) {
            case 'LIGHT': return 'LEVE';
            case 'MEDIUM': return 'MÉDIA';
            case 'SEVERE': return 'GRAVE';
            default: return severity;
        }
    };

    const getSeverityClass = (severity: string) => {
        switch (severity) {
            case 'LIGHT': return 'lc-severity-light';
            case 'MEDIUM': return 'lc-severity-medium';
            case 'SEVERE': return 'lc-severity-severe';
            default: return '';
        }
    };

    const renderComment = (comment: CommentData, isReply = false) => (
        <div key={comment.id} className={`lc-comment ${isReply ? 'lc-reply' : ''} ${comment.flagged ? 'lc-flagged' : ''}`}>
            <div className="lc-comment-header">
                <div className="lc-comment-author">
                    <span className="lc-avatar">
                        {comment.user.name.charAt(0).toUpperCase()}
                    </span>
                    <span className="lc-name">{comment.user.name}</span>
                    {isTeacher(comment.user.role) && (
                        <span className="lc-badge-teacher">
                            <ShieldCheck size={12} /> Professor
                        </span>
                    )}
                    <span className="lc-time">{formatTime(comment.createdAt)}</span>
                </div>
                <div className="lc-comment-actions">
                    {comment.userId === user?.id && (
                        <button onClick={() => handleDelete(comment.id)} className="lc-action-btn lc-delete" title="Excluir">
                            <Trash2 size={14} />
                        </button>
                    )}
                    {comment.userId !== user?.id && (
                        <button
                            onClick={() => setReportingId(reportingId === comment.id ? null : comment.id)}
                            className="lc-action-btn lc-report"
                            title="Denunciar"
                        >
                            <Flag size={14} />
                        </button>
                    )}
                    {!isReply && (
                        <button
                            onClick={() => { setReplyingTo(replyingTo === comment.id ? null : comment.id); setReplyText(''); }}
                            className="lc-action-btn"
                            title="Responder"
                        >
                            <Reply size={14} />
                        </button>
                    )}
                </div>
            </div>

            <p className="lc-comment-text">{comment.text}</p>

            {/* Report form */}
            {reportingId === comment.id && (
                <div className="lc-report-form">
                    <input
                        type="text"
                        value={reportReason}
                        onChange={(e) => setReportReason(e.target.value)}
                        placeholder="Motivo da denúncia..."
                        className="lc-report-input"
                        maxLength={200}
                    />
                    <button onClick={() => handleReport(comment.id)} className="lc-report-submit" disabled={!reportReason.trim()}>
                        Denunciar
                    </button>
                    <button onClick={() => { setReportingId(null); setReportReason(''); }} className="lc-report-cancel">
                        Cancelar
                    </button>
                </div>
            )}

            {/* Replies toggle + list */}
            {!isReply && comment.replies && comment.replies.length > 0 && (
                <div className="lc-replies-section">
                    <button onClick={() => toggleReplies(comment.id)} className="lc-toggle-replies">
                        {expandedReplies.has(comment.id) ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                        {comment.replies.length} {comment.replies.length === 1 ? 'resposta' : 'respostas'}
                    </button>
                    {expandedReplies.has(comment.id) && (
                        <div className="lc-replies-list">
                            {comment.replies.map(r => renderComment(r, true))}
                        </div>
                    )}
                </div>
            )}

            {/* Reply input */}
            {!isReply && replyingTo === comment.id && (
                <div className="lc-reply-form">
                    <input
                        type="text"
                        value={replyText}
                        onChange={(e) => setReplyText(e.target.value)}
                        placeholder="Escreva sua resposta..."
                        className="lc-reply-input"
                        maxLength={2000}
                        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit(comment.id); } }}
                    />
                    <button
                        onClick={() => handleSubmit(comment.id)}
                        className="lc-reply-send"
                        disabled={!replyText.trim() || submitting}
                    >
                        <Send size={14} />
                    </button>
                </div>
            )}
        </div>
    );

    return (
        <div className="lc-container">
            <div className="lc-header">
                <MessageSquare size={20} />
                <h3>Discussão da Aula</h3>
                <span className="lc-count">{comments.length}</span>
            </div>

            {/* Modal de violação */}
            {violationModal && (
                <div className="lc-violation-overlay">
                    <div className={`lc-violation-modal ${getSeverityClass(violationModal.severity)}`}>
                        <div className="lc-violation-icon">
                            <AlertTriangle size={40} />
                        </div>
                        <h3 className="lc-violation-title">
                            Violação {getSeverityLabel(violationModal.severity)}
                        </h3>
                        <div className="lc-violation-body">
                            {violationModal.message.split('\n').map((line, i) => (
                                <p key={i}>{line}</p>
                            ))}
                        </div>
                        <button
                            className="lc-violation-close"
                            onClick={() => {
                                setViolationModal(null);
                                setNewComment('');
                                setReplyText('');
                                // Recarrega para pegar ban atualizado
                                fetchComments();
                            }}
                        >
                            Entendi
                        </button>
                    </div>
                </div>
            )}

            {/* Banner de ban */}
            {forumBan && (
                <div className="lc-ban-banner">
                    <Ban size={22} />
                    <div className="lc-ban-info">
                        <strong>Você está suspenso do fórum</strong>
                        <p>
                            {forumBan.expiresAt
                                ? `Seu acesso retorna em ${new Date(forumBan.expiresAt).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}`
                                : 'Suspensão permanente'}
                            {forumBan.banType === 'TEMP_10D' && ' — Caso em análise pela comissão'}
                        </p>
                    </div>
                    {!showAppealForm && !appealSuccess && (
                        <button className="lc-appeal-btn" onClick={() => setShowAppealForm(true)}>
                            <Scale size={14} /> Enviar Recurso
                        </button>
                    )}
                    {appealSuccess && (
                        <span className="lc-appeal-sent">✓ Recurso enviado</span>
                    )}
                </div>
            )}

            {/* Formulário de recurso */}
            {showAppealForm && (
                <div className="lc-appeal-form">
                    <h4><Scale size={16} /> Enviar Recurso</h4>
                    <p className="lc-appeal-hint">Explique por que sua punição deve ser reconsiderada. Mínimo 10 caracteres.</p>
                    <textarea
                        value={appealText}
                        onChange={(e) => setAppealText(e.target.value)}
                        placeholder="Escreva seu recurso aqui..."
                        className="lc-appeal-textarea"
                        rows={3}
                        maxLength={1000}
                    />
                    <div className="lc-appeal-actions">
                        <button
                            onClick={handleAppealSubmit}
                            className="lc-appeal-submit"
                            disabled={appealText.trim().length < 10 || appealSubmitting}
                        >
                            {appealSubmitting ? 'Enviando...' : 'Enviar Recurso'}
                        </button>
                        <button onClick={() => { setShowAppealForm(false); setAppealText(''); }} className="lc-appeal-cancel">
                            Cancelar
                        </button>
                    </div>
                </div>
            )}

            {error && <div className="lc-error">{error}</div>}

            {commentsEnabled ? (
                <>
                    {/* New comment input — esconde se está banido */}
                    {!forumBan && (
                        <div className="lc-new-comment">
                            <div className="lc-new-avatar">
                                {user?.name?.charAt(0).toUpperCase() || '?'}
                            </div>
                            <div className="lc-new-input-wrap">
                                <textarea
                                    value={newComment}
                                    onChange={(e) => setNewComment(e.target.value)}
                                    placeholder="Escreva um comentário ou dúvida..."
                                    className="lc-new-textarea"
                                    rows={2}
                                    maxLength={2000}
                                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit(); } }}
                                />
                                <button
                                    onClick={() => handleSubmit()}
                                    className="lc-send-btn"
                                    disabled={!newComment.trim() || submitting}
                                >
                                    <Send size={16} />
                                    {submitting ? 'Enviando...' : 'Enviar'}
                                </button>
                            </div>
                        </div>
                    )}

                    {/* Comments list */}
                    <div className="lc-list">
                        {comments.length === 0 ? (
                            <div className="lc-empty">
                                <MessageSquare size={32} />
                                <p>Nenhum comentário ainda. Seja o primeiro!</p>
                            </div>
                        ) : (
                            comments.map(c => renderComment(c))
                        )}
                    </div>
                </>
            ) : (
                <div className="lc-disabled">
                    <MessageSquare size={32} />
                    <p>Os comentários estão desabilitados nesta aula.</p>
                </div>
            )}
        </div>
    );
}
