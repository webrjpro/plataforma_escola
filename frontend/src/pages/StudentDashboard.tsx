/**
 * StudentDashboard.tsx — Painel do Aluno (Design Premium Produção)
 *
 * Layout com 2 seções tipo carrossel:
 * 1. "Continuar estudando" — Cards grandes com thumbnail + overlay de info
 * 2. "Cursos em Andamento" — Cards médios com thumbnail full + badge de progresso
 *
 * Só mostra cursos em que o aluno está MATRICULADO (pelo admin)
 */
import { useState, useEffect, useRef, useMemo } from 'react';
import { useAuth } from '../context/AuthContext';
import { useConfig } from '../context/ConfigContext';
import {
    LogOut, Search, ShieldCheck, Loader2, ChevronRight,
    PlayCircle, BookOpen, GraduationCap, TrendingUp, LayoutDashboard,
    Flag, Bell, Radio, ExternalLink, KeyRound, Bot, CalendarDays,
    ClipboardCheck, Award, StickyNote, MessageCircle, Settings, Rocket,
    Trophy, Target, CircleCheckBig
    // GraduationCap kept for empty state
} from 'lucide-react';
import api from '../lib/api';
import { Link, useNavigate } from 'react-router-dom';
import axios from 'axios';
import { resolveMediaUrl } from '../lib/urls';
import './StudentDashboard.css';

interface Video {
    id: string;
    title: string;
    description: string | null;
    thumbnailUrl: string | null;
    hlsUrl: string;
    status: string;
    order: number;
}

interface Module {
    id: string;
    name: string;
    videos: Video[];
}

interface CourseWithProgress {
    id: string;
    name: string;
    description: string | null;
    thumbnailUrl: string | null;
    modules: Module[];
    progressPercent: number;
    totalVideos: number;
    completedVideos: number;
    lastWatchedVideo: {
        id: string;
        title: string;
        thumbnailUrl: string | null;
        progress: number;
        moduleName: string;
    } | null;
    lastWatchedAt: string | null;
}

interface Recommendation {
    courseId: string;
    courseName: string;
    videoId: string;
    videoTitle: string;
    reason: string;
    moduleName: string;
    priorityScore: number;
    riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
}

interface StudentNotification {
    id: string;
    title: string;
    message: string;
    createdAt: string;
    read: boolean;
}

interface StudentLiveClass {
    id: string;
    title: string;
    status: string;
    startAt: string;
    provider?: string | null;
    meetingJoinUrl?: string | null;
    zoomJoinUrl?: string | null;
    course?: { name: string } | null;
    module?: { name: string } | null;
}

type StudentView = 'dashboard' | 'courses' | 'schedule' | 'activities' | 'progress' | 'track';

export default function StudentDashboard() {
    const { user, logout, login: doLogin } = useAuth();
    const { config } = useConfig();
    const [courses, setCourses] = useState<CourseWithProgress[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchQuery, setSearchQuery] = useState('');
    const [activeView, setActiveView] = useState<StudentView>('dashboard');
    const navigate = useNavigate();

    // Notifications
    const [notifications, setNotifications] = useState<StudentNotification[]>([]);
    const [showNotifs, setShowNotifs] = useState(false);

    // Live classes
    const [liveClasses, setLiveClasses] = useState<StudentLiveClass[]>([]);
    const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
    const [forcePasswordError, setForcePasswordError] = useState('');
    const [forcePasswordLoading, setForcePasswordLoading] = useState(false);
    const [forcePasswordForm, setForcePasswordForm] = useState({
        currentPassword: '',
        newPassword: '',
        confirmPassword: ''
    });
    const prefetchedLessonsRef = useRef<Set<string>>(new Set());
    const prefetchedChunksRef = useRef(false);

    useEffect(() => {
        const fetchData = async () => {
            try {
                if (user?.mustChangePassword) {
                    setLoading(false);
                    return;
                }

                const [myRes, notifRes, liveRes, recRes] = await Promise.all([
                    api.get('/api/student/my-courses'),
                    api.get('/api/student/notifications'),
                    api.get('/api/student/my-live-classes'),
                    api.get('/api/student/recommendations')
                ]);
                setCourses(myRes.data);
                setNotifications(notifRes.data);
                setLiveClasses(liveRes.data);
                setRecommendations(recRes.data || []);
            } catch (error) {
                console.error('Erro ao buscar cursos', error);
            } finally {
                setLoading(false);
            }
        };
        if (user) fetchData();
    }, [user]);

    const handleForcePasswordChange = async (e: React.FormEvent) => {
        e.preventDefault();
        setForcePasswordError('');

        if (forcePasswordForm.newPassword !== forcePasswordForm.confirmPassword) {
            setForcePasswordError('As senhas não coincidem.');
            return;
        }

        setForcePasswordLoading(true);
        try {
            const res = await api.put('/api/auth/profile', {
                currentPassword: forcePasswordForm.currentPassword,
                newPassword: forcePasswordForm.newPassword
            });

            doLogin(res.data.user);
            setForcePasswordForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
            window.location.reload();
        } catch (err: unknown) {
            if (axios.isAxiosError(err)) {
                setForcePasswordError(err.response?.data?.message || 'Erro ao atualizar senha.');
            } else {
                setForcePasswordError('Erro ao atualizar senha.');
            }
        } finally {
            setForcePasswordLoading(false);
        }
    };

    // Dark mode toggle
    useEffect(() => {
        document.body.classList.remove('dark');
        localStorage.removeItem('darkMode');
    }, []);

    const unreadCount = notifications.filter((notification) => !notification.read).length;

    const handleMarkAllRead = async () => {
        try {
            await api.put('/api/student/notifications/read-all', {});
            setNotifications(prev => prev.map(n => ({ ...n, read: true })));
        } catch { /* ignore */ }
    };

    const handleLessonClick = (videoId: string) => {
        prefetchLessonResources(videoId);
        navigate(`/student/lesson/${videoId}`);
    };

    const getPreferredVideoId = (course: CourseWithProgress): string | null => {
        if (course.lastWatchedVideo?.id) return course.lastWatchedVideo.id;
        const allVideos = course.modules.flatMap(m => m.videos);
        const readyVideo = allVideos.find(v => v.status === 'READY');
        return readyVideo?.id || allVideos[0]?.id || null;
    };

    const prefetchLessonResources = (videoId?: string | null) => {
        if (!prefetchedChunksRef.current) {
            prefetchedChunksRef.current = true;
            import('./LessonPage');
            import('../components/VideoPlayer');
        }

        if (!videoId || prefetchedLessonsRef.current.has(videoId)) return;
        prefetchedLessonsRef.current.add(videoId);

        api.get(`/api/student/lesson/${videoId}`).catch(() => {
            prefetchedLessonsRef.current.delete(videoId);
        });
    };

    const handleCourseClick = (course: CourseWithProgress) => {
        if (course.lastWatchedVideo) {
            handleLessonClick(course.lastWatchedVideo.id);
            return;
        }
        // Prefere vídeo READY, mas aceita qualquer um para não bloquear navegação
        const allVideos = course.modules.flatMap(m => m.videos);
        const readyVideo = allVideos.find(v => v.status === 'READY');
        const firstVideo = readyVideo || allVideos[0];
        if (firstVideo) handleLessonClick(firstVideo.id);
    };



    // Cursos em andamento (progresso > 0 e < 100)
    const inProgressCourses = useMemo(() =>
        courses.filter(c => c.progressPercent > 0 && c.progressPercent < 100),
        [courses]
    );

    // Cursos para "Continuar estudando" (que têm lastWatchedVideo)
    const continueCourses = useMemo(() =>
        courses.filter(c => c.lastWatchedVideo !== null)
            .sort((a, b) => {
                const dateA = a.lastWatchedAt ? new Date(a.lastWatchedAt).getTime() : 0;
                const dateB = b.lastWatchedAt ? new Date(b.lastWatchedAt).getTime() : 0;
                return dateB - dateA;
            }),
        [courses]
    );

    // Progresso global
    const globalProgress = useMemo(() => {
        if (courses.length === 0) return 0;
        const total = courses.reduce((s, c) => s + c.totalVideos, 0);
        const completed = courses.reduce((s, c) => s + c.completedVideos, 0);
        return total > 0 ? Math.round((completed / total) * 100) : 0;
    }, [courses]);

    // Filtro de busca
    const filteredCourses = useMemo(() => {
        if (!searchQuery.trim()) return courses;
        const q = searchQuery.toLowerCase();
        return courses.filter(c => c.name.toLowerCase().includes(q));
    }, [courses, searchQuery]);

    const dashboardCourses = useMemo(() => {
        if (searchQuery.trim()) return filteredCourses;
        const continuedIds = new Set(continueCourses.map(course => course.id));
        return [...continueCourses, ...courses.filter(course => !continuedIds.has(course.id))];
    }, [continueCourses, courses, filteredCourses, searchQuery]);

    const completedLessons = useMemo(
        () => courses.reduce((total, course) => total + course.completedVideos, 0),
        [courses]
    );

    const totalLessons = useMemo(
        () => courses.reduce((total, course) => total + course.totalVideos, 0),
        [courses]
    );

    const formattedDate = useMemo(() => {
        const value = new Intl.DateTimeFormat('pt-BR', {
            weekday: 'long', day: '2-digit', month: 'long', year: 'numeric'
        }).format(new Date());
        return value.charAt(0).toUpperCase() + value.slice(1);
    }, []);

    const selectView = (view: StudentView) => {
        setActiveView(view);
        window.scrollTo({ top: 0, behavior: 'smooth' });
    };

    if (loading) {
        return (
            <div className="sd-loading">
                <Loader2 className="spinner" size={48} color="var(--primary)" />
            </div>
        );
    }

    return (
        <div className="sd-root">
            {user?.mustChangePassword && (
                <div style={{
                    position: 'fixed',
                    inset: 0,
                    background: 'rgba(2, 6, 23, 0.85)',
                    zIndex: 3000,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: '1rem'
                }}>
                    <form
                        onSubmit={handleForcePasswordChange}
                        style={{
                            width: '100%',
                            maxWidth: '460px',
                            background: 'rgba(15, 23, 42, 0.96)',
                            border: '1px solid rgba(148, 163, 184, 0.3)',
                            borderRadius: '16px',
                            padding: '1.5rem',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '0.85rem'
                        }}
                    >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#f8fafc' }}>
                            <KeyRound size={18} />
                            <strong>Troca obrigatória de senha</strong>
                        </div>
                        <p style={{ margin: 0, color: '#cbd5e1', fontSize: '0.9rem' }}>
                            Por segurança, altere sua senha temporária antes de acessar os cursos.
                        </p>
                        <input
                            type="password"
                            placeholder="Senha atual"
                            value={forcePasswordForm.currentPassword}
                            onChange={(e) => setForcePasswordForm(prev => ({ ...prev, currentPassword: e.target.value }))}
                            className="admin-input"
                            required
                        />
                        <input
                            type="password"
                            placeholder="Nova senha (mínimo 8 caracteres)"
                            value={forcePasswordForm.newPassword}
                            onChange={(e) => setForcePasswordForm(prev => ({ ...prev, newPassword: e.target.value }))}
                            className="admin-input"
                            required
                        />
                        <input
                            type="password"
                            placeholder="Confirmar nova senha"
                            value={forcePasswordForm.confirmPassword}
                            onChange={(e) => setForcePasswordForm(prev => ({ ...prev, confirmPassword: e.target.value }))}
                            className="admin-input"
                            required
                        />
                        {forcePasswordError && <small style={{ color: '#fca5a5' }}>{forcePasswordError}</small>}
                        <button type="submit" className="admin-btn-primary" disabled={forcePasswordLoading}>
                            {forcePasswordLoading ? 'Atualizando...' : 'Salvar nova senha'}
                        </button>
                        <button type="button" onClick={logout} className="admin-btn-ghost">
                            Sair
                        </button>
                    </form>
                </div>
            )}

            <header className="sd-header sd-portal-header">
                <div className="sd-header-left">
                    {config.logoUrl ? (
                        <img src={resolveMediaUrl(config.logoUrl)} alt={config.platformName} className="sd-logo-img" />
                    ) : (
                        <ShieldCheck size={30} aria-hidden="true" />
                    )}
                    <span className="sd-logo"><span style={{ color: config.nameColor1 }}>{config.namePart1}</span><span style={{ color: config.nameColor2 }}>{config.namePart2}</span></span>
                </div>

                <nav className="sd-product-nav" aria-label="Atalhos do aluno">
                    <button type="button" onClick={() => selectView('courses')}><BookOpen size={17} /> Cursos</button>
                    <button type="button" onClick={() => selectView('schedule')}><CalendarDays size={17} /> Agenda</button>
                    <Link to="/student/tutor"><Bot size={17} /> Tutor IA</Link>
                </nav>

                <label className="sd-search-bar">
                    <Search size={18} aria-hidden="true" />
                    <span className="sr-only">Buscar cursos</span>
                    <input
                        type="search"
                        placeholder="Buscar cursos, aulas e materiais..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                    />
                </label>

                <div className="sd-header-right">
                    <div className="sd-global-progress" title="Progresso geral">
                        <TrendingUp size={18} />
                        <span><strong>{globalProgress}%</strong><small>Progresso geral</small></span>
                    </div>

                    <div className="sd-notif-anchor">
                        <button onClick={() => setShowNotifs(s => !s)} className="sd-icon-btn" title="Notificações" aria-expanded={showNotifs}>
                            <Bell size={18} />
                            {unreadCount > 0 && <span className="sd-notif-badge">{unreadCount}</span>}
                        </button>
                        {showNotifs && (
                            <div className="sd-notif-dropdown">
                                <div className="sd-notif-header">
                                    <strong>Notificações</strong>
                                    {unreadCount > 0 && <button onClick={handleMarkAllRead} className="sd-notif-mark-read">Marcar como lidas</button>}
                                </div>
                                <div className="sd-notif-list">
                                    {notifications.length === 0 ? (
                                        <p className="sd-notif-empty">Nenhuma notificação.</p>
                                    ) : notifications.map((notification) => (
                                        <div key={notification.id} className={`sd-notif-item ${notification.read ? '' : 'unread'}`}>
                                            <strong>{notification.title}</strong>
                                            <p>{notification.message}</p>
                                            <small>{new Date(notification.createdAt).toLocaleString('pt-BR')}</small>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>

                    <div className="sd-user-area">
                        <div className="sd-avatar">{user?.name?.charAt(0).toUpperCase()}</div>
                        <span className="sd-user-name">{user?.name}</span>
                        <button onClick={logout} className="sd-logout-btn" title="Sair"><LogOut size={17} /></button>
                    </div>
                </div>
            </header>

            <div className="sd-portal-shell">
                <aside className="sd-sidebar" aria-label="Menu do aluno">
                    <nav>
                        <button type="button" className={activeView === 'dashboard' ? 'active' : ''} onClick={() => selectView('dashboard')}><LayoutDashboard size={18} /> Dashboard</button>
                        <button type="button" className={activeView === 'courses' ? 'active' : ''} onClick={() => selectView('courses')}><BookOpen size={18} /> Meus cursos</button>
                        <button type="button" className={activeView === 'schedule' ? 'active' : ''} onClick={() => selectView('schedule')}><CalendarDays size={18} /> Cronograma</button>
                        <button type="button" className={activeView === 'activities' ? 'active' : ''} onClick={() => selectView('activities')}><ClipboardCheck size={18} /> Atividades</button>
                        <button type="button" className={activeView === 'progress' ? 'active' : ''} onClick={() => selectView('progress')}><Award size={18} /> Progresso</button>
                        <button type="button" className={activeView === 'track' ? 'active' : ''} onClick={() => selectView('track')}><StickyNote size={18} /> Trilha inteligente</button>
                        <Link to="/student/tutor"><MessageCircle size={18} /> Tutor IA</Link>
                        <Link to="/account/security"><Settings size={18} /> Segurança</Link>
                    </nav>
                    <div className="sd-sidebar-progress">
                        <Rocket size={28} />
                        <strong>Continue aprendendo!</strong>
                        <p>Você já concluiu {completedLessons} de {totalLessons} aulas.</p>
                        <div><span style={{ width: `${globalProgress}%` }} /></div>
                        <button type="button" onClick={() => selectView('progress')}>Ver meu progresso</button>
                    </div>
                </aside>

                <main className="sd-main sd-portal-main" id="inicio">
                    {config.bannerUrl && <div className="sd-banner"><img src={resolveMediaUrl(config.bannerUrl)} alt="" className="sd-banner-img" /></div>}

                    {activeView !== 'dashboard' && (
                        <section className="sd-student-module" aria-live="polite">
                            <header>
                                <div>
                                    <span>Módulo do aluno</span>
                                    <h1>{({ courses: 'Meus cursos', schedule: 'Cronograma', activities: 'Atividades', progress: 'Meu progresso', track: 'Trilha inteligente' } as Record<string, string>)[activeView]}</h1>
                                    <p>{activeView === 'courses' && 'Acesse todos os cursos em que você está matriculado.'}
                                       {activeView === 'schedule' && 'Consulte suas próximas aulas e encontros ao vivo.'}
                                       {activeView === 'activities' && 'Veja as atividades e aulas recomendadas para continuar avançando.'}
                                       {activeView === 'progress' && 'Acompanhe o avanço real em cada curso e aula.'}
                                       {activeView === 'track' && 'Recomendações personalizadas a partir do seu progresso.'}</p>
                                </div>
                                {activeView === 'courses' && <BookOpen />}
                                {activeView === 'schedule' && <CalendarDays />}
                                {activeView === 'activities' && <ClipboardCheck />}
                                {activeView === 'progress' && <Award />}
                                {activeView === 'track' && <Bot />}
                            </header>

                            {(activeView === 'courses' || activeView === 'progress') && (
                                <div className="sd-module-course-list">
                                    {dashboardCourses.length === 0 ? (
                                        <div className="sd-portal-empty"><GraduationCap size={42} /><strong>Nenhum curso matriculado</strong><p>A instituição ainda não vinculou cursos ao seu acesso.</p></div>
                                    ) : dashboardCourses.map(course => (
                                        <button type="button" key={`${activeView}_${course.id}`} onClick={() => handleCourseClick(course)} disabled={!getPreferredVideoId(course)} onMouseEnter={() => prefetchLessonResources(getPreferredVideoId(course))}>
                                            <span><BookOpen /></span><div><strong>{course.name}</strong><small>{course.lastWatchedVideo?.moduleName || course.modules[0]?.name || `${course.totalVideos} aulas`}</small><i><b style={{ width: `${course.progressPercent}%` }} /></i></div><em>{course.progressPercent}%</em><ChevronRight />
                                        </button>
                                    ))}
                                </div>
                            )}

                            {activeView === 'schedule' && (
                                <div className="sd-module-schedule">
                                    {liveClasses.length === 0 ? (
                                        <div className="sd-portal-empty"><CalendarDays size={42} /><strong>Nenhum encontro agendado</strong><p>Quando a escola publicar uma aula ao vivo, ela aparecerá aqui.</p></div>
                                    ) : liveClasses.map(liveClass => {
                                        const startAt = new Date(liveClass.startAt);
                                        const joinUrl = liveClass.meetingJoinUrl || liveClass.zoomJoinUrl;
                                        return <article key={liveClass.id}><time><strong>{startAt.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })}</strong><small>{startAt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</small></time><span><Radio /></span><div><strong>{liveClass.title}</strong><small>{liveClass.course?.name || liveClass.module?.name || 'Encontro acadêmico'}</small></div>{joinUrl ? <a href={joinUrl} target="_blank" rel="noopener noreferrer">Entrar <ExternalLink size={15} /></a> : <em>Link em preparação</em>}</article>;
                                    })}
                                </div>
                            )}

                            {(activeView === 'activities' || activeView === 'track') && (
                                <div className="sd-module-activity-list">
                                    {recommendations.length === 0 ? (
                                        <div className="sd-portal-empty"><CircleCheckBig size={42} /><strong>{activeView === 'activities' ? 'Nenhuma atividade pendente' : 'Trilha em preparação'}</strong><p>{activeView === 'activities' ? 'Você não tem recomendações pendentes neste momento.' : 'As recomendações serão geradas conforme você avançar nas aulas.'}</p></div>
                                    ) : recommendations.map(recommendation => (
                                        <button type="button" key={`${activeView}_${recommendation.courseId}_${recommendation.videoId}`} onClick={() => handleLessonClick(recommendation.videoId)} onMouseEnter={() => prefetchLessonResources(recommendation.videoId)}>
                                            <span>{activeView === 'track' ? <Bot /> : <ClipboardCheck />}</span><div><small>{recommendation.courseName} · {recommendation.moduleName}</small><strong>{recommendation.videoTitle}</strong><p>{recommendation.reason}</p></div><em>Assistir <ChevronRight size={15} /></em>
                                        </button>
                                    ))}
                                </div>
                            )}
                        </section>
                    )}

                    <div hidden={activeView !== 'dashboard'}>
                    <section className="sd-welcome">
                        <div>
                            <span className="sd-eyebrow">Área do aluno</span>
                            <h1>Olá, {user?.name?.split(' ')[0] || 'estudante'}! <span aria-hidden="true">👋</span></h1>
                            <p>Continue seus estudos e avance nos seus objetivos.</p>
                        </div>
                        <time><CalendarDays size={18} /> {formattedDate}</time>
                    </section>

                    <section className="sd-kpi-grid" id="progresso" aria-label="Resumo de aprendizagem">
                        <article><span className="blue"><BookOpen /></span><div><small>Cursos matriculados</small><strong>{courses.length}</strong><p>{inProgressCourses.length} em andamento</p></div></article>
                        <article><span className="green"><CircleCheckBig /></span><div><small>Aulas concluídas</small><strong>{completedLessons}</strong><p>de {totalLessons} disponíveis</p></div></article>
                        <article><span className="amber"><Trophy /></span><div><small>Progresso geral</small><strong>{globalProgress}%</strong><p>Continue avançando</p></div></article>
                        <article><span className="violet"><Target /></span><div><small>Próximos encontros</small><strong>{liveClasses.length}</strong><p>aulas ao vivo</p></div></article>
                    </section>

                    <div className="sd-dashboard-grid">
                        <section className="sd-portal-panel sd-courses-panel" id="cursos">
                            <header><div><span>Minha aprendizagem</span><h2>Meus cursos</h2></div><small>{dashboardCourses.length} curso(s)</small></header>
                            <div className="sd-course-list">
                                {dashboardCourses.length === 0 ? (
                                    <div className="sd-portal-empty"><GraduationCap size={38} /><strong>{searchQuery ? 'Nenhum curso corresponde à busca.' : 'Nenhum curso matriculado.'}</strong><p>{searchQuery ? 'Tente outro termo.' : 'Aguarde a matrícula pela instituição.'}</p></div>
                                ) : dashboardCourses.slice(0, 6).map(course => {
                                    const thumbUrl = resolveMediaUrl(course.lastWatchedVideo?.thumbnailUrl || course.thumbnailUrl);
                                    const preferredVideo = getPreferredVideoId(course);
                                    return (
                                        <article key={course.id} className="sd-course-row" onMouseEnter={() => prefetchLessonResources(preferredVideo)}>
                                            <button className="sd-course-thumb" type="button" onClick={() => handleCourseClick(course)} disabled={!preferredVideo} style={thumbUrl ? { backgroundImage: `url(${thumbUrl})` } : undefined}>
                                                {!thumbUrl && <BookOpen size={24} />}
                                            </button>
                                            <div className="sd-course-copy">
                                                <strong>{course.name}</strong>
                                                <small>{course.lastWatchedVideo?.moduleName || course.modules[0]?.name || `${course.totalVideos} aulas`}</small>
                                                <div className="sd-course-progress"><span style={{ width: `${course.progressPercent}%` }} /></div>
                                            </div>
                                            <span className="sd-course-percent">{course.progressPercent}%</span>
                                            <button className="sd-course-continue" type="button" onClick={() => handleCourseClick(course)} disabled={!preferredVideo}>Continuar <ChevronRight size={15} /></button>
                                        </article>
                                    );
                                })}
                            </div>
                        </section>

                        <section className="sd-portal-panel sd-activity-panel" id="agenda">
                            <header><div><span>Agenda acadêmica</span><h2>Próximas atividades</h2></div><CalendarDays size={20} /></header>
                            <div className="sd-activity-list">
                                {liveClasses.slice(0, 4).map(liveClass => {
                                    const isLive = liveClass.status === 'LIVE';
                                    const joinUrl = liveClass.meetingJoinUrl || liveClass.zoomJoinUrl;
                                    const startAt = new Date(liveClass.startAt);
                                    return (
                                        <article key={liveClass.id}>
                                            <span className={isLive ? 'red' : 'blue'}><Radio /></span>
                                            <div><small>{isLive ? 'Ao vivo agora' : 'Aula ao vivo'}</small><strong>{liveClass.title}</strong><p>{liveClass.course?.name || liveClass.module?.name || 'Encontro acadêmico'}</p></div>
                                            <time>{startAt.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}<small>{startAt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</small></time>
                                            {joinUrl && <a href={joinUrl} target="_blank" rel="noopener noreferrer" title="Entrar na aula"><ExternalLink size={16} /></a>}
                                        </article>
                                    );
                                })}
                                {recommendations.slice(0, Math.max(0, 4 - liveClasses.length)).map(recommendation => (
                                    <button key={`${recommendation.courseId}_${recommendation.videoId}`} type="button" onClick={() => handleLessonClick(recommendation.videoId)} onMouseEnter={() => prefetchLessonResources(recommendation.videoId)}>
                                        <span className="violet"><Flag /></span>
                                        <div><small>Trilha recomendada</small><strong>{recommendation.videoTitle}</strong><p>{recommendation.courseName}</p></div>
                                        <ChevronRight size={17} />
                                    </button>
                                ))}
                                {liveClasses.length === 0 && recommendations.length === 0 && (
                                    <div className="sd-portal-empty"><CalendarDays size={34} /><strong>Agenda livre por enquanto</strong><p>Novas aulas e recomendações aparecerão aqui.</p></div>
                                )}
                            </div>
                        </section>
                    </div>

                    {recommendations.length > 0 && (
                        <section className="sd-portal-panel sd-ai-track" id="trilha">
                            <header><div><span>Personalização por dados</span><h2>Trilha inteligente</h2></div><Bot size={22} /></header>
                            <div>
                                {recommendations.slice(0, 3).map(recommendation => (
                                    <button key={`${recommendation.courseId}_${recommendation.videoId}_track`} type="button" onClick={() => handleLessonClick(recommendation.videoId)} onMouseEnter={() => prefetchLessonResources(recommendation.videoId)}>
                                        <span><PlayCircle /></span><div><strong>{recommendation.videoTitle}</strong><small>{recommendation.moduleName} · {recommendation.reason}</small></div><ChevronRight />
                                    </button>
                                ))}
                            </div>
                        </section>
                    )}
                    </div>
                </main>
            </div>
        </div>
    );
}
