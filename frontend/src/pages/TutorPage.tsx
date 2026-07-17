import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import axios from 'axios';
import { AnimatePresence, motion } from 'framer-motion';
import {
    ArrowLeft, BookOpen, Bot, Check, ChevronDown, ChevronRight, CircleStop,
    GraduationCap, Loader2, Menu, MessageSquarePlus, PanelLeftClose, PanelLeftOpen,
    Save, Send, Settings2, Sparkles, Trash2, UserRound, WandSparkles, X,
} from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useConfig } from '../context/ConfigContext';
import api from '../lib/api';
import './TutorPage.css';

type MessageRole = 'user' | 'assistant' | 'system';

interface TutorMessage {
    id: string;
    role: MessageRole;
    content: string;
    createdAt: string;
}

interface TutorConversation {
    id: string;
    title: string;
    courseId: string | null;
    lessonId: string | null;
    updatedAt: string;
    messages?: TutorMessage[];
}

interface TutorProfile {
    learningStage: string;
    preferredLearningStyle: string;
    explanationDepth: string;
    tone: string;
    learningGoals: string;
}

interface CourseContext {
    id: string;
    name: string;
    modules: Array<{
        id: string;
        name: string;
        videos: Array<{ id: string; title: string }>;
    }>;
}

type JsonRecord = Record<string, unknown>;

const DEFAULT_PROFILE: TutorProfile = {
    learningStage: 'GENERAL',
    preferredLearningStyle: 'BALANCED',
    explanationDepth: 'GUIDED',
    tone: 'ENCOURAGING',
    learningGoals: '',
};

function record(value: unknown): JsonRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonRecord : {};
}

function text(value: unknown, fallback = ''): string {
    return typeof value === 'string' ? value : fallback;
}

function enumText(value: unknown, allowed: readonly string[], fallback: string): string {
    const normalized = text(value).toUpperCase();
    return allowed.includes(normalized) ? normalized : fallback;
}

function normalizeMessage(value: unknown, index = 0): TutorMessage {
    const item = record(value);
    const normalizedRole = text(item.role).toLowerCase();
    const role = ['user', 'assistant', 'system'].includes(normalizedRole) ? normalizedRole as MessageRole : 'assistant';
    return {
        id: text(item.id, `message-${index}`),
        role,
        content: text(item.content, text(item.text, text(item.message))),
        createdAt: text(item.createdAt, new Date().toISOString()),
    };
}

function normalizeConversation(value: unknown, index = 0): TutorConversation {
    const item = record(value);
    return {
        id: text(item.id, `conversation-${index}`),
        title: text(item.title, 'Nova conversa'),
        courseId: text(item.courseId) || null,
        lessonId: text(item.lessonId, text(item.videoId)) || null,
        updatedAt: text(item.updatedAt, text(item.createdAt, new Date().toISOString())),
        messages: Array.isArray(item.messages) ? item.messages.map(normalizeMessage) : undefined,
    };
}

function normalizeProfile(value: unknown): TutorProfile {
    const item = record(value);
    return {
        learningStage: enumText(item.learningStage, ['GENERAL', 'LITERACY', 'ELEMENTARY', 'MIDDLE_SCHOOL', 'HIGH_SCHOOL', 'HIGHER_EDUCATION', 'PROFESSIONAL', 'EXAM_PREP'], DEFAULT_PROFILE.learningStage),
        preferredLearningStyle: enumText(item.preferredLearningStyle ?? item.learningStyle, ['BALANCED', 'VISUAL', 'PRACTICAL', 'SOCRATIC'], DEFAULT_PROFILE.preferredLearningStyle),
        explanationDepth: enumText(item.explanationDepth ?? item.depth, ['CONCISE', 'GUIDED', 'DEEP'], DEFAULT_PROFILE.explanationDepth),
        tone: enumText(item.tone, ['ENCOURAGING', 'DIRECT', 'ACADEMIC'], DEFAULT_PROFILE.tone),
        learningGoals: text(item.learningGoals, text(item.goal)),
    };
}

function optimisticUserMessage(content: string): TutorMessage {
    return {
        id: `local-user-${crypto.randomUUID()}`,
        role: 'user',
        content,
        createdAt: new Date().toISOString(),
    };
}

function safeHref(value: string): string {
    try {
        const url = new URL(value, window.location.origin);
        return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
    } catch {
        return '';
    }
}

function inlineMarkdown(value: string): ReactNode[] {
    const tokenPattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)|\*[^*]+\*)/g;
    return value.split(tokenPattern).filter(Boolean).map((part, index) => {
        if (part.startsWith('**') && part.endsWith('**')) return <strong key={index}>{part.slice(2, -2)}</strong>;
        if (part.startsWith('`') && part.endsWith('`')) return <code key={index}>{part.slice(1, -1)}</code>;
        if (part.startsWith('*') && part.endsWith('*')) return <em key={index}>{part.slice(1, -1)}</em>;
        const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        if (link) {
            const href = safeHref(link[2]);
            return href
                ? <a key={index} href={href} target="_blank" rel="noopener noreferrer">{link[1]}</a>
                : <Fragment key={index}>{link[1]}</Fragment>;
        }
        return <Fragment key={index}>{part}</Fragment>;
    });
}

function SafeMarkdown({ content }: { content: string }) {
    const lines = content.replace(/\r/g, '').split('\n');
    const blocks: ReactNode[] = [];
    let code: string[] | null = null;
    let listItems: Array<{ ordered: boolean; content: string }> = [];

    const flushList = () => {
        if (!listItems.length) return;
        const ordered = listItems[0].ordered;
        const Tag = ordered ? 'ol' : 'ul';
        blocks.push(<Tag key={`list-${blocks.length}`}>{listItems.map((item, index) => <li key={index}>{inlineMarkdown(item.content)}</li>)}</Tag>);
        listItems = [];
    };

    for (const [index, line] of lines.entries()) {
        if (line.trim().startsWith('```')) {
            flushList();
            if (code) {
                blocks.push(<pre key={`code-${index}`}><code>{code.join('\n')}</code></pre>);
                code = null;
            } else {
                code = [];
            }
            continue;
        }
        if (code) {
            code.push(line);
            continue;
        }
        const unordered = line.match(/^\s*[-*]\s+(.+)$/);
        const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
        if (unordered || ordered) {
            listItems.push({ ordered: Boolean(ordered), content: (unordered || ordered)?.[1] || '' });
            continue;
        }
        flushList();
        if (!line.trim()) continue;
        if (line.startsWith('### ')) blocks.push(<h4 key={index}>{inlineMarkdown(line.slice(4))}</h4>);
        else if (line.startsWith('## ')) blocks.push(<h3 key={index}>{inlineMarkdown(line.slice(3))}</h3>);
        else if (line.startsWith('# ')) blocks.push(<h2 key={index}>{inlineMarkdown(line.slice(2))}</h2>);
        else if (line.startsWith('> ')) blocks.push(<blockquote key={index}>{inlineMarkdown(line.slice(2))}</blockquote>);
        else blocks.push(<p key={index}>{inlineMarkdown(line)}</p>);
    }
    flushList();
    if (code) blocks.push(<pre key="code-last"><code>{code.join('\n')}</code></pre>);
    return <div className="tutor-markdown">{blocks}</div>;
}

function conversationDate(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short' }).format(date);
}

export default function TutorPage() {
    const { user } = useAuth();
    const { config } = useConfig();
    const [searchParams] = useSearchParams();
    const [conversations, setConversations] = useState<TutorConversation[]>([]);
    const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
    const [messages, setMessages] = useState<TutorMessage[]>([]);
    const [courses, setCourses] = useState<CourseContext[]>([]);
    const [courseId, setCourseId] = useState(searchParams.get('courseId') || '');
    const [videoId, setVideoId] = useState(searchParams.get('videoId') || '');
    const [profile, setProfile] = useState<TutorProfile>(DEFAULT_PROFILE);
    const [draft, setDraft] = useState('');
    const [loading, setLoading] = useState(true);
    const [conversationLoading, setConversationLoading] = useState(false);
    const [sending, setSending] = useState(false);
    const [profileSaving, setProfileSaving] = useState(false);
    const [profileSaved, setProfileSaved] = useState(false);
    const [error, setError] = useState('');
    const [sidebarOpen, setSidebarOpen] = useState(false);
    const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
    const [profileOpen, setProfileOpen] = useState(false);
    const requestRef = useRef<AbortController | null>(null);
    const messagesEndRef = useRef<HTMLDivElement | null>(null);

    const selectedCourse = useMemo(() => courses.find((course) => course.id === courseId) || null, [courseId, courses]);
    const videos = useMemo(() => selectedCourse?.modules.flatMap((module) => module.videos.map((video) => ({ ...video, moduleName: module.name }))) || [], [selectedCourse]);
    const selectedVideo = videos.find((video) => video.id === videoId) || null;

    useEffect(() => {
        const controller = new AbortController();
        const load = async () => {
            setLoading(true);
            setError('');
            const [bootstrapResult, coursesResult] = await Promise.allSettled([
                api.get('/api/ai/bootstrap', { signal: controller.signal }),
                api.get('/api/student/my-courses', { signal: controller.signal }),
            ]);
            if (controller.signal.aborted) return;
            if (bootstrapResult.status === 'rejected') {
                setError('Não foi possível iniciar o Tutor IA. Tente novamente em instantes.');
                setLoading(false);
                return;
            }
            const bootstrap = record(bootstrapResult.value.data);
            const loadedConversations = Array.isArray(bootstrap.conversations)
                ? bootstrap.conversations.map(normalizeConversation)
                : [];
            setConversations(loadedConversations);
            setProfile(normalizeProfile(bootstrap.profile));
            if (coursesResult.status === 'fulfilled' && Array.isArray(coursesResult.value.data)) {
                setCourses(coursesResult.value.data as CourseContext[]);
            }
            const requestedConversation = searchParams.get('conversationId');
            const firstId = requestedConversation || loadedConversations[0]?.id || null;
            setActiveConversationId(firstId);
            setLoading(false);
        };
        void load();
        return () => controller.abort();
    }, [searchParams]);

    useEffect(() => {
        if (!activeConversationId) {
            setMessages([]);
            return;
        }
        const controller = new AbortController();
        const loadConversation = async () => {
            setConversationLoading(true);
            try {
                const response = await api.get(`/api/ai/conversations/${activeConversationId}/history`, { signal: controller.signal });
                const payload = record(response.data);
                const conversation = normalizeConversation(payload.conversation ?? response.data);
                if (!controller.signal.aborted) {
                    const history = Array.isArray(payload.messages)
                        ? payload.messages.map(normalizeMessage)
                        : conversation.messages || [];
                    setMessages(history);
                    setCourseId((current) => current || conversation.courseId || '');
                    setVideoId((current) => current || conversation.lessonId || '');
                }
            } catch (loadError: unknown) {
                if (!controller.signal.aborted && (!axios.isAxiosError(loadError) || loadError.response?.status !== 404)) {
                    setError('Não foi possível abrir esta conversa.');
                }
            } finally {
                if (!controller.signal.aborted) setConversationLoading(false);
            }
        };
        void loadConversation();
        return () => controller.abort();
    }, [activeConversationId]);

    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }, [messages, sending]);

    const startConversation = () => {
        requestRef.current?.abort();
        setActiveConversationId(null);
        setMessages([]);
        setDraft('');
        setError('');
        setSidebarOpen(false);
    };

    const openConversation = (conversation: TutorConversation) => {
        setActiveConversationId(conversation.id);
        if (conversation.courseId) setCourseId(conversation.courseId);
        if (conversation.lessonId) setVideoId(conversation.lessonId);
        setSidebarOpen(false);
        setError('');
    };

    const createConversation = async (firstMessage: string): Promise<TutorConversation> => {
        const response = await api.post('/api/ai/conversations', {
            title: firstMessage.slice(0, 72),
            courseId: courseId || null,
            lessonId: videoId || null,
        });
        const payload = record(response.data);
        const conversation = normalizeConversation(payload.conversation ?? response.data);
        setConversations((current) => [conversation, ...current.filter((item) => item.id !== conversation.id)]);
        setActiveConversationId(conversation.id);
        return conversation;
    };

    const sendMessage = async (suggestion?: string) => {
        const content = (suggestion ?? draft).trim();
        if (!content || sending) return;
        setError('');
        setDraft('');
        setSending(true);
        const controller = new AbortController();
        requestRef.current = controller;
        const optimistic = optimisticUserMessage(content);
        setMessages((current) => [...current, optimistic]);

        try {
            const conversation = activeConversationId
                ? conversations.find((item) => item.id === activeConversationId) || { id: activeConversationId } as TutorConversation
                : await createConversation(content);
            const response = await api.post('/api/ai/chat', {
                conversationId: conversation.id,
                message: content,
                courseId: courseId || null,
                lessonId: videoId || null,
            }, { signal: controller.signal });
            const result = record(response.data);
            const assistantRaw = result.assistantMessage ?? result.message ?? result.content;
            const assistant = typeof assistantRaw === 'string'
                ? normalizeMessage({ role: 'assistant', content: assistantRaw })
                : normalizeMessage(assistantRaw);
            setMessages((current) => [...current, assistant]);
            const returnedConversation = result.conversation ? normalizeConversation(result.conversation) : null;
            setConversations((current) => current.map((item) => item.id === conversation.id
                ? { ...item, ...(returnedConversation || {}), messages: undefined, updatedAt: new Date().toISOString() }
                : item));
        } catch (sendError: unknown) {
            if (!controller.signal.aborted) {
                const message = axios.isAxiosError(sendError)
                    ? text(record(sendError.response?.data).message, 'O Tutor não conseguiu responder agora.')
                    : 'O Tutor não conseguiu responder agora.';
                setError(message);
            }
        } finally {
            if (requestRef.current === controller) requestRef.current = null;
            setSending(false);
        }
    };

    const stopGeneration = () => {
        requestRef.current?.abort();
        requestRef.current = null;
        setSending(false);
    };

    const deleteConversation = async (conversation: TutorConversation) => {
        if (!window.confirm(`Excluir a conversa “${conversation.title}”?`)) return;
        try {
            await api.delete(`/api/ai/conversations/${conversation.id}`);
            setConversations((current) => current.filter((item) => item.id !== conversation.id));
            if (activeConversationId === conversation.id) startConversation();
        } catch {
            setError('Não foi possível excluir a conversa.');
        }
    };

    const saveProfile = async () => {
        setProfileSaving(true);
        setProfileSaved(false);
        try {
            const response = await api.put('/api/ai/profile', {
                learningStage: profile.learningStage,
                preferredLearningStyle: profile.preferredLearningStyle,
                explanationDepth: profile.explanationDepth,
                tone: profile.tone,
                learningGoals: profile.learningGoals || null,
            });
            setProfile(normalizeProfile(record(response.data).profile ?? response.data));
            setProfileSaved(true);
            window.setTimeout(() => setProfileSaved(false), 2500);
        } catch {
            setError('Não foi possível salvar seu perfil pedagógico.');
        } finally {
            setProfileSaving(false);
        }
    };

    if (loading) {
        return <div className="tutor-loading" role="status"><Loader2 className="spinner" size={36} /> Preparando seu Tutor IA…</div>;
    }

    return (
        <div className={`tutor-page ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
            <button className="tutor-mobile-menu" type="button" onClick={() => setSidebarOpen(true)} aria-label="Abrir histórico de conversas">
                <Menu size={20} />
            </button>

            <AnimatePresence>
                {sidebarOpen && (
                    <motion.button
                        className="tutor-mobile-backdrop"
                        type="button"
                        aria-label="Fechar histórico"
                        onClick={() => setSidebarOpen(false)}
                        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                    />
                )}
            </AnimatePresence>

            <aside className={`tutor-sidebar ${sidebarOpen ? 'open' : ''}`} aria-label="Histórico do Tutor">
                <div className="tutor-sidebar-brand">
                    <span><WandSparkles size={21} /></span>
                    {!sidebarCollapsed && <div><strong>{config.platformName}</strong><small>Tutor IA</small></div>}
                    <button type="button" className="tutor-sidebar-collapse" onClick={() => setSidebarCollapsed((value) => !value)} aria-label={sidebarCollapsed ? 'Expandir histórico' : 'Recolher histórico'}>
                        {sidebarCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
                    </button>
                    <button type="button" className="tutor-sidebar-mobile-close" onClick={() => setSidebarOpen(false)} aria-label="Fechar histórico"><X size={18} /></button>
                </div>
                <button type="button" className="tutor-new-chat" onClick={startConversation}>
                    <MessageSquarePlus size={18} /> {!sidebarCollapsed && 'Nova conversa'}
                </button>
                <div className="tutor-history" aria-label="Conversas anteriores">
                    {!conversations.length && !sidebarCollapsed && <p className="tutor-history-empty">Suas conversas aparecerão aqui.</p>}
                    {conversations.map((conversation) => (
                        <div key={conversation.id} className={`tutor-history-item ${activeConversationId === conversation.id ? 'active' : ''}`}>
                            <button type="button" onClick={() => openConversation(conversation)} title={conversation.title}>
                                <Bot size={17} />
                                {!sidebarCollapsed && <span><strong>{conversation.title}</strong><small>{conversationDate(conversation.updatedAt)}</small></span>}
                            </button>
                            {!sidebarCollapsed && (
                                <button type="button" className="tutor-history-delete" onClick={() => void deleteConversation(conversation)} aria-label={`Excluir ${conversation.title}`}>
                                    <Trash2 size={14} />
                                </button>
                            )}
                        </div>
                    ))}
                </div>
                <Link to="/student/dashboard" className="tutor-back-link"><ArrowLeft size={17} /> {!sidebarCollapsed && 'Voltar aos cursos'}</Link>
            </aside>

            <main className="tutor-main">
                <header className="tutor-header">
                    <div className="tutor-header-copy">
                        <span className="tutor-online"><span /> TUTOR DISPONÍVEL</span>
                        <h1>Olá, {user?.name?.split(' ')[0] || 'estudante'}.</h1>
                        <p>Vamos transformar dúvidas em próximos passos claros.</p>
                    </div>
                    <button type="button" className={`tutor-profile-toggle ${profileOpen ? 'active' : ''}`} onClick={() => setProfileOpen((value) => !value)} aria-expanded={profileOpen}>
                        <Settings2 size={17} /> Perfil pedagógico <ChevronDown size={15} />
                    </button>
                </header>

                <AnimatePresence initial={false}>
                    {profileOpen && (
                        <motion.section
                            className="tutor-profile-panel"
                            aria-labelledby="tutor-profile-title"
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: 'auto' }}
                            exit={{ opacity: 0, height: 0 }}
                        >
                            <div className="tutor-profile-heading">
                                <div><UserRound size={20} /><span><strong id="tutor-profile-title">Como você prefere aprender</strong><small>O Tutor adapta linguagem, ritmo e profundidade.</small></span></div>
                                <button type="button" onClick={() => void saveProfile()} disabled={profileSaving}>
                                    {profileSaved ? <Check size={16} /> : profileSaving ? <Loader2 className="spinner" size={16} /> : <Save size={16} />}
                                    {profileSaved ? 'Salvo' : 'Salvar perfil'}
                                </button>
                            </div>
                            <div className="tutor-profile-grid">
                                <label>Etapa de aprendizagem
                                    <select value={profile.learningStage} onChange={(event) => setProfile((current) => ({ ...current, learningStage: event.target.value }))}>
                                        <option value="GENERAL">Geral</option>
                                        <option value="LITERACY">Alfabetização</option>
                                        <option value="ELEMENTARY">Ensino fundamental I</option>
                                        <option value="MIDDLE_SCHOOL">Ensino fundamental II</option>
                                        <option value="HIGH_SCHOOL">Ensino médio</option>
                                        <option value="HIGHER_EDUCATION">Ensino superior</option>
                                        <option value="PROFESSIONAL">Formação profissional</option>
                                        <option value="EXAM_PREP">Preparação para provas</option>
                                    </select>
                                </label>
                                <label>Estilo de aprendizagem
                                    <select value={profile.preferredLearningStyle} onChange={(event) => setProfile((current) => ({ ...current, preferredLearningStyle: event.target.value }))}>
                                        <option value="BALANCED">Equilibrado</option>
                                        <option value="VISUAL">Visual e exemplos</option>
                                        <option value="PRACTICAL">Prático e direto</option>
                                        <option value="SOCRATIC">Perguntas guiadas</option>
                                    </select>
                                </label>
                                <label>Profundidade
                                    <select value={profile.explanationDepth} onChange={(event) => setProfile((current) => ({ ...current, explanationDepth: event.target.value }))}>
                                        <option value="CONCISE">Resposta curta</option>
                                        <option value="GUIDED">Passo a passo</option>
                                        <option value="DEEP">Aprofundada</option>
                                    </select>
                                </label>
                                <label>Tom
                                    <select value={profile.tone} onChange={(event) => setProfile((current) => ({ ...current, tone: event.target.value }))}>
                                        <option value="ENCOURAGING">Acolhedor</option>
                                        <option value="DIRECT">Direto</option>
                                        <option value="ACADEMIC">Acadêmico</option>
                                    </select>
                                </label>
                                <label>Objetivo atual
                                    <input value={profile.learningGoals} onChange={(event) => setProfile((current) => ({ ...current, learningGoals: event.target.value }))} maxLength={240} placeholder="Ex.: revisar para a avaliação" />
                                </label>
                            </div>
                        </motion.section>
                    )}
                </AnimatePresence>

                <section className="tutor-context" aria-labelledby="tutor-context-title">
                    <div className="tutor-context-title"><BookOpen size={18} /><span><strong id="tutor-context-title">Contexto da conversa</strong><small>Escolha onde o Tutor deve concentrar a resposta.</small></span></div>
                    <label>
                        <span>Curso</span>
                        <select value={courseId} onChange={(event) => { setCourseId(event.target.value); setVideoId(''); }}>
                            <option value="">Contexto geral</option>
                            {courses.map((course) => <option key={course.id} value={course.id}>{course.name}</option>)}
                        </select>
                    </label>
                    <ChevronRight size={16} aria-hidden="true" />
                    <label>
                        <span>Aula</span>
                        <select value={videoId} onChange={(event) => setVideoId(event.target.value)} disabled={!courseId}>
                            <option value="">Todas as aulas</option>
                            {videos.map((video) => <option key={video.id} value={video.id}>{video.moduleName} · {video.title}</option>)}
                        </select>
                    </label>
                </section>

                <section className="tutor-conversation" aria-label="Conversa com o Tutor">
                    {conversationLoading ? (
                        <div className="tutor-conversation-loading" role="status"><Loader2 className="spinner" size={24} /> Carregando conversa…</div>
                    ) : messages.length === 0 ? (
                        <motion.div className="tutor-empty" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
                            <span className="tutor-empty-icon"><GraduationCap size={32} /></span>
                            <h2>Por onde começamos?</h2>
                            <p>{selectedVideo ? `Estou com o contexto de “${selectedVideo.title}”.` : selectedCourse ? `Estou com o contexto de “${selectedCourse.name}”.` : 'Escolha um contexto ou faça uma pergunta geral.'}</p>
                            <div className="tutor-suggestions">
                                {[
                                    'Explique o conceito principal de forma simples.',
                                    'Crie um exercício prático para eu testar o que aprendi.',
                                    'Monte um plano curto de revisão para hoje.',
                                ].map((suggestion) => <button key={suggestion} type="button" onClick={() => void sendMessage(suggestion)}><Sparkles size={15} />{suggestion}</button>)}
                            </div>
                        </motion.div>
                    ) : (
                        <div className="tutor-messages" role="log" aria-live="polite" aria-relevant="additions">
                            {messages.filter((message) => message.role !== 'system').map((message) => (
                                <article key={message.id} className={`tutor-message ${message.role}`}>
                                    <span className="tutor-message-avatar" aria-hidden="true">{message.role === 'assistant' ? <Bot size={18} /> : <UserRound size={18} />}</span>
                                    <div>
                                        <strong>{message.role === 'assistant' ? 'Tutor IA' : 'Você'}</strong>
                                        {message.role === 'assistant' ? <SafeMarkdown content={message.content} /> : <p>{message.content}</p>}
                                    </div>
                                </article>
                            ))}
                            {sending && (
                                <article className="tutor-message assistant tutor-thinking" role="status">
                                    <span className="tutor-message-avatar"><Bot size={18} /></span>
                                    <div><strong>Tutor IA</strong><p><span /><span /><span /> Organizando uma resposta com base no seu contexto…</p></div>
                                </article>
                            )}
                            <div ref={messagesEndRef} />
                        </div>
                    )}
                </section>

                <footer className="tutor-composer-wrap">
                    {error && <div className="tutor-error" role="alert">{error}<button type="button" onClick={() => setError('')} aria-label="Fechar erro"><X size={14} /></button></div>}
                    <div className="tutor-composer">
                        <textarea
                            value={draft}
                            onChange={(event) => setDraft(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key === 'Enter' && !event.shiftKey) {
                                    event.preventDefault();
                                    void sendMessage();
                                }
                            }}
                            placeholder={selectedVideo ? `Pergunte sobre ${selectedVideo.title}…` : 'Escreva sua dúvida…'}
                            rows={1}
                            maxLength={4000}
                            aria-label="Mensagem para o Tutor IA"
                            disabled={sending}
                        />
                        {sending ? (
                            <button type="button" className="tutor-stop" onClick={stopGeneration} aria-label="Parar resposta"><CircleStop size={20} /></button>
                        ) : (
                            <button type="button" className="tutor-send" onClick={() => void sendMessage()} disabled={!draft.trim()} aria-label="Enviar mensagem"><Send size={20} /></button>
                        )}
                    </div>
                    <small>O Tutor usa o conteúdo da plataforma como referência, mas pode cometer erros. Confirme informações importantes com seu professor.</small>
                </footer>
            </main>
        </div>
    );
}
