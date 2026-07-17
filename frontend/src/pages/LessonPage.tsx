/**
 * LessonPage.tsx — Página da Aula (Folha Branca + Blocos)
 *
 * Video em tela cheia no topo → folha branca render blocos JSON do editor
 * Suporta conteúdo HTML legado (ReactQuill).
 */
import { Suspense, lazy, useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useConfig } from '../context/ConfigContext';
import { BlockRenderer, parseContentField } from '../components/BlockEditor';
import LessonComments from '../components/LessonComments';
import {
    ChevronLeft, LayoutDashboard, Loader2, BookOpen,
    FileText, Pause, Play, AlertCircle,
    ChevronRight, Sparkles, Layers, StickyNote, Save,
    FileDown, CalendarDays, Award, Radio, ExternalLink, Bot, MessageSquare
} from 'lucide-react';
import axios from 'axios';
import api from '../lib/api';
import DOMPurify from 'dompurify';
import { resolveMediaUrl } from '../lib/urls';
const LazyVideoPlayer = lazy(() => import('../components/VideoPlayer'));

interface LessonData {
    id: string;
    title: string;
    description: string | null;
    content: string | null;
    thumbnailUrl: string | null;
    hlsUrl: string | null;
    status: string;
    module: {
        id: string;
        name: string;
        pdfUrl: string | null;
        course: { id: string; name: string; calendarUrl: string | null };
    };
    nextVideo?: { id: string; title: string } | null;
    prevVideo?: { id: string; title: string } | null;
}

interface LessonQuizQuestion {
    id: string;
    question: string;
    options: string[];
    difficulty: string;
}

type TabKey = 'content' | 'notes' | 'downloads' | 'comments';

function escapeCertificateHtml(value: unknown): string {
    return String(value ?? '').replace(/[&<>'"]/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    })[character] as string);
}

interface LiveClassData {
    title: string;
    status: string;
    startAt: string;
    meetingJoinUrl?: string | null;
    zoomJoinUrl?: string | null;
}

function trustedQrUrl(value: unknown): string {
    try {
        const url = new URL(String(value));
        return url.protocol === 'https:' && url.hostname === 'api.qrserver.com' ? url.toString() : '';
    } catch {
        return '';
    }
}

export default function LessonPage() {
    const { videoId } = useParams<{ videoId: string }>();
    const { user } = useAuth();
    const { config } = useConfig();
    const navigate = useNavigate();

    const [lesson, setLesson] = useState<LessonData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [activeTab, setActiveTab] = useState<TabKey>('content');
    const [notes, setNotes] = useState('');
    const [notesSaved, setNotesSaved] = useState(false);
    const [isPaused, setIsPaused] = useState(false);
    const [certLoading, setCertLoading] = useState(false);
    const [liveClass, setLiveClass] = useState<LiveClassData | null>(null);
    const [quiz, setQuiz] = useState<LessonQuizQuestion[]>([]);
    const [quizAnswers, setQuizAnswers] = useState<Record<string, string>>({});
    const [quizResult, setQuizResult] = useState<{ score: number; totalAnswers: number; percent: number; feedback: string } | null>(null);
    const [quizLoading, setQuizLoading] = useState(false);
    const [downloading, setDownloading] = useState<string | null>(null);

    useEffect(() => {
        const fetchLesson = async () => {
            try {
                setLoading(true);
                setError(null);
                const response = await api.get(`/api/student/lesson/${videoId}`);
                setLesson(response.data);
            } catch (err: unknown) {
                console.error('Erro ao buscar aula', err);
                if (axios.isAxiosError(err)) {
                    setError(err.response?.data?.message || 'Erro ao carregar a aula. Verifique sua matrícula.');
                } else {
                    setError('Erro ao carregar a aula.');
                }
            } finally {
                setLoading(false);
            }
        };
        if (videoId) fetchLesson();
    }, [videoId]);

    const notesStorageKey = user?.id && videoId ? `eduvault_notes_${user.id}_${videoId}` : null;

    useEffect(() => {
        setNotes(notesStorageKey ? localStorage.getItem(notesStorageKey) ?? '' : '');
        setNotesSaved(false);
        if (videoId) localStorage.removeItem(`eduvault_notes_${videoId}`);
    }, [notesStorageKey, videoId]);

    useEffect(() => {
        const fetchQuiz = async () => {
            try {
                const response = await api.get(`/api/student/lesson/${videoId}/quiz`);
                setQuiz(response.data || []);
                setQuizAnswers({});
                setQuizResult(null);
            } catch {
                setQuiz([]);
            }
        };
        if (videoId) fetchQuiz();
    }, [videoId]);

    // Fetch live class for current course
    useEffect(() => {
        if (!lesson) return;
        const fetchLive = async () => {
            try {
                const res = await api.get(`/api/student/live-classes/${lesson.module.course.id}`);
                const upcoming = (res.data as LiveClassData[]).find(
                    (item) => item.status === 'LIVE' || item.status === 'SCHEDULED'
                );
                if (upcoming) setLiveClass(upcoming);
            } catch { /* ignore */ }
        };
        fetchLive();
    }, [lesson]);

    const handleSaveNotes = () => {
        if (notesStorageKey) {
            localStorage.setItem(notesStorageKey, notes);
            setNotesSaved(true);
            setTimeout(() => setNotesSaved(false), 2000);
        }
    };

    const handleTogglePause = () => {
        const videoEl = document.querySelector('video');
        if (videoEl) {
            if (videoEl.paused) { videoEl.play(); setIsPaused(false); }
            else { videoEl.pause(); setIsPaused(true); }
        }
    };

    const handleCertificate = async () => {
        if (!lesson) return;
        setCertLoading(true);
        try {
            const res = await api.get(`/api/student/certificate/${lesson.module.course.id}`);
            const { studentName, courseName, completedAt, totalLessons, certificateCode, verifyUrl, qrUrl } = res.data;
            const date = new Date(completedAt).toLocaleDateString('pt-BR');
            const safeStudentName = escapeCertificateHtml(studentName);
            const safeCourseName = escapeCertificateHtml(courseName);
            const safeTotalLessons = escapeCertificateHtml(Number(totalLessons) || 0);
            const safeDate = escapeCertificateHtml(date);
            const safeCertificateCode = escapeCertificateHtml(certificateCode);
            const safeVerifyUrl = escapeCertificateHtml(verifyUrl);
            const safeQrUrl = escapeCertificateHtml(trustedQrUrl(qrUrl));

            // Generate certificate HTML and print
            const certWindow = window.open('', '_blank');
            if (certWindow) {
                certWindow.opener = null;
                certWindow.document.write(`<!DOCTYPE html><html><head><title>Certificado</title>
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https://api.qrserver.com; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
                <style>
                    @page { size: landscape; margin: 0; }
                    body { margin: 0; display: flex; justify-content: center; align-items: center; min-height: 100vh; background: #f5f5f5; font-family: 'Georgia', serif; }
                    .cert { width: 900px; padding: 60px; background: white; border: 3px double #c8a96e; position: relative; text-align: center; }
                    .cert::before { content: ''; position: absolute; inset: 8px; border: 1px solid #c8a96e; pointer-events: none; }
                    .cert h1 { font-size: 2.2rem; color: #1a365d; margin-bottom: 0.5rem; letter-spacing: 2px; }
                    .cert h2 { font-size: 1.1rem; color: #666; font-weight: normal; margin-bottom: 2rem; }
                    .cert .name { font-size: 2rem; color: #1a365d; font-style: italic; border-bottom: 2px solid #c8a96e; display: inline-block; padding: 0.5rem 2rem; margin: 1rem 0; }
                    .cert .course { font-size: 1.3rem; color: #333; margin: 1.5rem 0; }
                    .cert .details { font-size: 0.95rem; color: #666; margin-top: 2rem; }
                    .cert .verify { margin-top: 1.2rem; font-size: 0.8rem; color: #475569; }
                    .cert .qr { margin-top: 0.75rem; }
                    .cert .qr img { width: 120px; height: 120px; }
                </style></head><body>
                    <div class="cert">
                        <h1>CERTIFICADO DE CONCLUSÃO</h1>
                        <h2>Este certificado é concedido a</h2>
                        <div class="name">${safeStudentName}</div>
                        <div class="course">por concluir com sucesso o curso<br/><strong>${safeCourseName}</strong></div>
                        <div class="details">${safeTotalLessons} aulas concluídas &bull; ${safeDate}</div>
                        <div class="verify">
                            Código: <strong>${safeCertificateCode}</strong><br/>
                            Verificar: ${safeVerifyUrl}
                        </div>
                        ${safeQrUrl ? `<div class="qr"><img src="${safeQrUrl}" alt="QR de validação" /></div>` : ''}
                    </div>
                    <script>setTimeout(()=>window.print(),500)</script>
                </body></html>`);
                certWindow.document.close();
            }
        } catch (err: unknown) {
            if (axios.isAxiosError(err)) {
                alert(err.response?.data?.message || 'Erro ao gerar certificado.');
            } else {
                alert('Erro ao gerar certificado.');
            }
        } finally {
            setCertLoading(false);
        }
    };

    const handleSubmitQuiz = async () => {
        if (!videoId) return;
        try {
            setQuizLoading(true);
            const res = await api.post(`/api/student/lesson/${videoId}/quiz-attempt`, {
                answers: quizAnswers
            });
            setQuizResult(res.data);
        } catch {
            alert('Erro ao enviar quiz.');
        } finally {
            setQuizLoading(false);
        }
    };

    const handleProtectedDownload = async (resourceUrl: string, filename: string) => {
        setDownloading(resourceUrl);
        try {
            const response = await api.get(resourceUrl, {
                responseType: 'blob'
            });
            const objectUrl = window.URL.createObjectURL(response.data as Blob);
            const anchor = document.createElement('a');
            anchor.href = objectUrl;
            anchor.download = filename;
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
            window.setTimeout(() => window.URL.revokeObjectURL(objectUrl), 1000);
        } catch {
            alert('Não foi possível baixar este material. Tente novamente.');
        } finally {
            setDownloading(null);
        }
    };

    // Parse content — supports both JSON blocks and legacy HTML
    const lessonContent = lesson?.content ?? null;
    const contentData = useMemo(() => {
        if (!lessonContent) return null;
        const parsed = parseContentField(lessonContent);
        if (parsed.isBlocks) return { type: 'blocks' as const, blocks: parsed.blocks };
        const sanitized = DOMPurify.sanitize(lessonContent, {
            ADD_TAGS: ['figure', 'figcaption'],
            ADD_ATTR: ['class', 'style']
        });
        return { type: 'html' as const, html: sanitized };
    }, [lessonContent]);

    const liveJoinUrl = liveClass?.meetingJoinUrl || liveClass?.zoomJoinUrl || '';

    if (loading) {
        return (
            <div className="lp-loading">
                <div className="lp-loading-inner">
                    <Loader2 className="spinner" size={48} />
                    <span>Carregando aula...</span>
                </div>
            </div>
        );
    }

    if (error || !lesson) {
        return (
            <div className="lp-error">
                <div className="lp-error-card">
                    <AlertCircle size={56} />
                    <h2>Acesso Negado ou Aula Não Encontrada</h2>
                    <p>{error}</p>
                    <button onClick={() => navigate('/student/dashboard')} className="lp-error-btn">
                        <LayoutDashboard size={18} /> Voltar ao Dashboard
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className="lp-root">
            {/* ===== HEADER ===== */}
            <header className="lp-header">
                <div className="lp-header-left">
                    <button onClick={() => navigate('/student/dashboard')} className="lp-back-btn" title="Voltar">
                        <ChevronLeft size={20} />
                    </button>
                    {config.logoUrl && (
                        <img src={resolveMediaUrl(config.logoUrl)} alt={config.platformName} className="lp-logo-img" />
                    )}
                    <div className="lp-header-info">
                        <span className="lp-header-breadcrumb">{lesson.module.course.name}</span>
                        <span className="lp-header-separator">/</span>
                        <span className="lp-header-breadcrumb">{lesson.module.name}</span>
                    </div>
                </div>
                <div className="lp-header-right">
                    <button
                        className="lp-header-action lp-tutor-action"
                        onClick={() => navigate(`/student/tutor?courseId=${encodeURIComponent(lesson.module.course.id)}&videoId=${encodeURIComponent(lesson.id)}`)}
                        title="Perguntar ao Tutor IA sobre esta aula"
                        aria-label="Abrir Tutor IA com o contexto desta aula"
                    >
                        <Bot size={16} /> <span>Tutor IA</span>
                    </button>
                    <button
                        className="lp-header-action"
                        onClick={handleCertificate}
                        disabled={certLoading}
                        title="Certificado de Conclusão"
                    >
                        <Award size={16} />
                    </button>
                    <button
                        className={`lp-header-action ${isPaused ? 'active' : ''}`}
                        onClick={handleTogglePause}
                        title={isPaused ? 'Reproduzir' : 'Pausar'}
                    >
                        {isPaused ? <Play size={16} /> : <Pause size={16} />}
                    </button>
                </div>
            </header>

            {/* ===== LIVE BANNER ===== */}
            {liveClass && liveJoinUrl && (
                <div className={`lp-live-banner ${liveClass.status === 'LIVE' ? 'is-live' : ''}`}>
                    <div className="lp-live-banner-info">
                        {liveClass.status === 'LIVE' ? (
                            <span className="lp-live-badge"><span className="lp-live-dot" /> AO VIVO AGORA</span>
                        ) : (
                            <span className="lp-live-badge"><Radio size={14} /> Aula ao Vivo Agendada</span>
                        )}
                        <strong>{liveClass.title}</strong>
                        <span>{new Date(liveClass.startAt).toLocaleString('pt-BR')}</span>
                    </div>
                    <a
                        href={liveJoinUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="lp-live-banner-btn"
                    >
                        <ExternalLink size={16} /> Entrar na aula
                    </a>
                </div>
            )}

            {/* ===== VIDEO ===== */}
            <section className="lp-cinema">
                <div className="lp-cinema-inner">
                    {lesson.status === 'READY' && lesson.hlsUrl ? (
                        <Suspense fallback={<div className="lp-video-status-msg"><Loader2 className="spinner" size={48} /><h3>Preparando player...</h3></div>}>
                            <LazyVideoPlayer videoId={lesson.id} hlsUrl={lesson.hlsUrl} moduleId={lesson.module.id} />
                        </Suspense>
                    ) : (
                        <div className="lp-video-status-msg">
                            {lesson.status === 'PROCESSING' ? (
                                <>
                                    <Loader2 className="spinner" size={48} />
                                    <h3>Vídeo em processamento...</h3>
                                    <p>Atualize a página em alguns minutos.</p>
                                </>
                            ) : lesson.status === 'ERROR' ? (
                                <>
                                    <AlertCircle size={48} color="#ef4444" />
                                    <h3>Erro no processamento</h3>
                                </>
                            ) : (
                                <>
                                    <Loader2 className="spinner" size={48} />
                                    <h3>Aguardando processamento</h3>
                                </>
                            )}
                        </div>
                    )}
                </div>
            </section>

            {/* ===== WHITE SHEET ===== */}
            <div className="lp-sheet-container">
                <div className="lp-sheet">
                    {/* Title */}
                    <div className="lp-sheet-header">
                        <h1 className="lp-lesson-title">{lesson.title}</h1>
                        <div className="lp-sheet-meta">
                            <span className="lp-meta-badge">
                                <Layers size={14} />
                                {lesson.module.name}
                            </span>
                        </div>
                    </div>

                    {/* Tabs */}
                    <div className="lp-tabs">
                        <button
                            className={`lp-tab ${activeTab === 'content' ? 'active' : ''}`}
                            onClick={() => setActiveTab('content')}
                        >
                            <BookOpen size={16} />
                            Material da Aula
                        </button>
                        <button
                            className={`lp-tab ${activeTab === 'notes' ? 'active' : ''}`}
                            onClick={() => setActiveTab('notes')}
                        >
                            <StickyNote size={16} />
                            Minhas Anotações
                        </button>
                        <button className={`lp-tab ${activeTab === 'comments' ? 'active' : ''}`} onClick={() => setActiveTab('comments')}>
                            <MessageSquare size={16} /> Discussão
                        </button>
                        {(lesson.module.pdfUrl || lesson.module.course.calendarUrl) && (
                            <button
                                className={`lp-tab ${activeTab === 'downloads' ? 'active' : ''}`}
                                onClick={() => setActiveTab('downloads')}
                            >
                                <FileDown size={16} />
                                Downloads
                            </button>
                        )}
                    </div>

                    {/* Content */}
                    {activeTab === 'content' && (
                        <div className="lp-sheet-content">
                            {contentData?.type === 'blocks' ? (
                                <BlockRenderer blocks={contentData.blocks} />
                            ) : contentData?.type === 'html' ? (
                                <div className="lp-rich-content" dangerouslySetInnerHTML={{ __html: contentData.html }} />
                            ) : lesson.description ? (
                                <div className="lp-rich-content">
                                    <p>{lesson.description}</p>
                                </div>
                            ) : (
                                <div className="lp-empty-content">
                                    <Sparkles size={48} />
                                    <h3>Foco no Vídeo</h3>
                                    <p>Assista o vídeo acima. Não há material adicional para esta aula.</p>
                                </div>
                            )}

                            {quiz.length > 0 && (
                                <div className="admin-card" style={{ marginTop: '1.5rem' }}>
                                    <h3 style={{ marginBottom: '0.75rem' }}>Quiz da Aula</h3>
                                    <div style={{ display: 'grid', gap: '0.75rem' }}>
                                        {quiz.map((q, idx) => (
                                            <div key={q.id} style={{ border: '1px solid #e2e8f0', borderRadius: '10px', padding: '0.9rem' }}>
                                                <strong>{idx + 1}. {q.question}</strong>
                                                <div style={{ display: 'grid', gap: '0.35rem', marginTop: '0.5rem' }}>
                                                    {q.options.map((opt, i) => (
                                                        <label key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                                            <input
                                                                type="radio"
                                                                name={q.id}
                                                                value={opt}
                                                                checked={quizAnswers[q.id] === opt}
                                                                onChange={(e) => setQuizAnswers(prev => ({ ...prev, [q.id]: e.target.value }))}
                                                            />
                                                            {opt}
                                                        </label>
                                                    ))}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                    <button className="admin-btn-primary" style={{ marginTop: '0.9rem' }} onClick={handleSubmitQuiz} disabled={quizLoading}>
                                        {quizLoading ? 'Corrigindo...' : 'Enviar quiz'}
                                    </button>
                                    {quizResult && (
                                        <div style={{ marginTop: '0.75rem', fontSize: '0.95rem', color: '#334155' }}>
                                            <strong>Resultado:</strong> {quizResult.score}/{quizResult.totalAnswers} ({quizResult.percent}%)
                                            <div style={{ marginTop: '0.35rem' }}>{quizResult.feedback}</div>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    )}

                    {activeTab === 'notes' && (
                        <div className="lp-notes-panel">
                            <div className="lp-notes-header">
                                <div className="lp-notes-title">
                                    <FileText size={20} />
                                    <h3>Suas Anotações</h3>
                                </div>
                                <button onClick={handleSaveNotes} className="lp-notes-save">
                                    <Save size={14} />
                                    {notesSaved ? 'Salvo!' : 'Salvar'}
                                </button>
                            </div>
                            <textarea
                                className="lp-notes-textarea"
                                value={notes}
                                onChange={(e) => setNotes(e.target.value)}
                                placeholder="Escreva suas anotações sobre esta aula..."
                                rows={12}
                            />
                        </div>
                    )}

                    {activeTab === 'downloads' && (
                        <div className="lp-downloads-panel">
                            <div className="lp-downloads-title">
                                <FileDown size={22} />
                                <h3>Materiais para Download</h3>
                            </div>
                            <div className="lp-downloads-grid">
                                {lesson.module.pdfUrl && (
                                    <button
                                        type="button"
                                        onClick={() => void handleProtectedDownload(lesson.module.pdfUrl!, `${lesson.module.name}-material.pdf`)}
                                        disabled={downloading === lesson.module.pdfUrl}
                                        className="lp-download-card"
                                    >
                                        <div className="lp-download-icon material">
                                            <FileText size={28} />
                                        </div>
                                        <div className="lp-download-info">
                                            <span className="lp-download-label">Material do Módulo</span>
                                            <span className="lp-download-sub">{lesson.module.name}</span>
                                        </div>
                                        {downloading === lesson.module.pdfUrl ? <Loader2 size={18} className="spinner lp-download-arrow" /> : <FileDown size={18} className="lp-download-arrow" />}
                                    </button>
                                )}
                                {lesson.module.course.calendarUrl && (
                                    <button
                                        type="button"
                                        onClick={() => void handleProtectedDownload(lesson.module.course.calendarUrl!, `${lesson.module.course.name}-calendario.pdf`)}
                                        disabled={downloading === lesson.module.course.calendarUrl}
                                        className="lp-download-card"
                                    >
                                        <div className="lp-download-icon calendar">
                                            <CalendarDays size={28} />
                                        </div>
                                        <div className="lp-download-info">
                                            <span className="lp-download-label">Calendário de Aulas</span>
                                            <span className="lp-download-sub">{lesson.module.course.name}</span>
                                        </div>
                                        {downloading === lesson.module.course.calendarUrl ? <Loader2 size={18} className="spinner lp-download-arrow" /> : <FileDown size={18} className="lp-download-arrow" />}
                                    </button>
                                )}
                            </div>
                        </div>
                    )}

                    {activeTab === 'comments' && <LessonComments videoId={lesson.id} />}

                    {/* Navigation */}
                    {(lesson.prevVideo || lesson.nextVideo) && (
                        <div className="lp-nav-section">
                            {lesson.prevVideo ? (
                                <button onClick={() => navigate(`/student/lesson/${lesson.prevVideo!.id}`)} className="lp-nav-btn prev">
                                    <ChevronLeft size={20} />
                                    <div>
                                        <span className="lp-nav-label">Aula anterior</span>
                                        <span className="lp-nav-title">{lesson.prevVideo.title}</span>
                                    </div>
                                </button>
                            ) : <div />}
                            {lesson.nextVideo && (
                                <button onClick={() => navigate(`/student/lesson/${lesson.nextVideo!.id}`)} className="lp-nav-btn next">
                                    <div>
                                        <span className="lp-nav-label">Próxima aula</span>
                                        <span className="lp-nav-title">{lesson.nextVideo.title}</span>
                                    </div>
                                    <ChevronRight size={20} />
                                </button>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
