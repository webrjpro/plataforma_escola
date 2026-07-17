import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '../context/AuthContext';
import { useConfig } from '../context/ConfigContext';
import { Save, Eye, EyeOff, CheckCircle, AlertCircle, X } from 'lucide-react';
import axios from 'axios';
import api from '../lib/api';
import 'react-quill-new/dist/quill.snow.css';
import { type ContentBlock, parseContentField } from '../components/BlockEditor';
import ConfirmModal from '../components/ConfirmModal';
import BroadcastAdminPanel from '../components/BroadcastAdminPanel';
import PrivateRoomAdminPanel from '../components/PrivateRoomAdminPanel';
import { AdminAudit } from '../features/admin/components/AdminAudit';
import { AdminAttendance } from '../features/admin/components/AdminAttendance';
import { AdminCourses } from '../features/admin/components/AdminCourses';
import { AdminHeader } from '../features/admin/components/AdminHeader';
import { AdminLiveClasses } from '../features/admin/components/AdminLiveClasses';
import { AdminModeration } from '../features/admin/components/AdminModeration';
import { AdminNotifications } from '../features/admin/components/AdminNotifications';
import { AdminOverview } from '../features/admin/components/AdminOverview';
import { AdminPunishment } from '../features/admin/components/AdminPunishment';
import { AdminReports } from '../features/admin/components/AdminReports';
import { AdminSidebar } from '../features/admin/components/AdminSidebar';
import { AdminUsers } from '../features/admin/components/AdminUsers';
import { AdminUserSecurityModal } from '../features/admin/components/AdminUserSecurityModal';
import { AdminVideoEditor } from '../features/admin/components/AdminVideoEditor';
import type {
    AdminTab,
    AppealData,
    AttendanceData,
    AuditLogData,
    BanData,
    CourseData,
    CourseReport,
    EmailDeliveryData,
    EmailStatusData,
    FlaggedComment,
    HealthData,
    LiveClassData,
    ModuleData,
    StatsData,
    UserData,
    ViolationData
} from '../features/admin/types';
import { buildOverviewCourseRows, buildUserUpdatePayload, formatAdminDate } from '../features/admin/utils';
import { resolveMediaUrl } from '../lib/urls';
import './AdminDashboard.css';

export default function AdminDashboard() {
    const { user, logout, login: doLogin } = useAuth();
    const { config } = useConfig();
    const isTeacher = user?.role === 'TEACHER';
    const [activeTab, setActiveTab] = useState<AdminTab>(isTeacher ? 'courses' : 'overview');
    const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
    const [stats, setStats] = useState<StatsData | null>(null);
    const [users, setUsers] = useState<UserData[]>([]);
    const [courses, setCourses] = useState<CourseData[]>([]);

    // Paginação
    const [userPage, setUserPage] = useState(1);
    const [userTotalPages, setUserTotalPages] = useState(1);
    const [userTotal, setUserTotal] = useState(0);
    const [userSearch, setUserSearch] = useState('');
    const [userSearchInput, setUserSearchInput] = useState('');
    const [globalSearch, setGlobalSearch] = useState('');

    // Forms state
    const [newUser, setNewUser] = useState({ name: '', email: '', password: '', role: 'STUDENT' });
    const [editingUserId, setEditingUserId] = useState<string | null>(null);
    const [editUserData, setEditUserData] = useState({ name: '', email: '', role: 'STUDENT' });
    const [userSecurityAction, setUserSecurityAction] = useState<{ mode: 'password' | 'block'; user: UserData } | null>(null);
    const [userSecurityForm, setUserSecurityForm] = useState({ password: '', confirmPassword: '', reason: '' });
    const [userSecurityLoading, setUserSecurityLoading] = useState(false);
    const [userSecurityError, setUserSecurityError] = useState('');
    const [newCourse, setNewCourse] = useState({ name: '', description: '', thumbnailUrl: '' });

    // Module, Video, Enrollment state
    const [newModule, setNewModule] = useState({ courseId: '', name: '' });
    const [uploadData, setUploadData] = useState<{ moduleId: string, title: string, file: File | null }>({ moduleId: '', title: '', file: null });
    const [uploading, setUploading] = useState(false);
    const [enrollmentData, setEnrollmentData] = useState({ courseId: '', userId: '', enrollmentRole: 'STUDENT' });

    // Video editing state
    const [editingVideoId, setEditingVideoId] = useState<string | null>(null);
    const [editVideoData, setEditVideoData] = useState({ title: '', description: '', content: '' });
    const [editBlocks, setEditBlocks] = useState<ContentBlock[]>([]);
    const [uploadingImage, setUploadingImage] = useState(false);

    const [editorModalMode, setEditorModalMode] = useState<'edit' | 'preview'>('edit');

    // Excel upload state
    const [excelUploading, setExcelUploading] = useState(false);
    const [excelResults, setExcelResults] = useState<{ name: string; email: string; password: string; enrolled: string[]; error?: string }[] | null>(null);
    const [excelEmailDelivery, setExcelEmailDelivery] = useState<EmailDeliveryData | null>(null);

    // Confirm modal state
    const [confirmAction, setConfirmAction] = useState<{ message: string; action: () => void } | null>(null);
    // Upload progress
    const [uploadProgress, setUploadProgress] = useState(0);

    // Audit log state
    const [healthData, setHealthData] = useState<HealthData | null>(null);
    const [auditLogs, setAuditLogs] = useState<AuditLogData[]>([]);
    const [auditPage, setAuditPage] = useState(1);
    const [auditTotalPages, setAuditTotalPages] = useState(1);

    // Reports state
    const [reports, setReports] = useState<CourseReport[]>([]);

    // Notification broadcast state
    const [notifForm, setNotifForm] = useState({ title: '', message: '' });
    const [emailStatus, setEmailStatus] = useState<EmailStatusData | null>(null);
    const [notificationFeedback, setNotificationFeedback] = useState('');

    // Live Classes state
    const [liveClasses, setLiveClasses] = useState<LiveClassData[]>([]);
    const [liveForm, setLiveForm] = useState({ courseId: '', moduleId: '', title: '', description: '', startAt: '', endAt: '', zoomJoinUrl: '', zoomStartUrl: '', zoomMeetingId: '' });
    const [editingLiveId, setEditingLiveId] = useState<string | null>(null);
    const [editingLiveStatus, setEditingLiveStatus] = useState('');

    // Moderation state
    const [flaggedComments, setFlaggedComments] = useState<FlaggedComment[]>([]);
    const [flaggedTotal, setFlaggedTotal] = useState(0);
    const [flaggedPage, setFlaggedPage] = useState(1);
    const [flaggedTotalPages, setFlaggedTotalPages] = useState(1);

    // Punishment state
    const [violations, setViolations] = useState<ViolationData[]>([]);
    const [bans, setBans] = useState<BanData[]>([]);
    const [appeals, setAppeals] = useState<AppealData[]>([]);
    const [appealFilter, setAppealFilter] = useState('PENDING');
    const [punishmentEnabled, setPunishmentEnabled] = useState(false);
    const [manualBanForm, setManualBanForm] = useState({ userId: '', reason: '', banType: 'TEMP_1D' });

    // Attendance state
    const [attendanceData, setAttendanceData] = useState<AttendanceData[]>([]);
    const [attendanceFilter, setAttendanceFilter] = useState({ courseId: '', moduleId: '', date: new Date().toISOString().split('T')[0] });
    const [attendanceModules, setAttendanceModules] = useState<ModuleData[]>([]);
    const [attendanceEditModal, setAttendanceEditModal] = useState<{ id: string; userId: string; moduleId: string; date: string; currentStatus: string } | null>(null);
    const [attendanceEditForm, setAttendanceEditForm] = useState({ status: '', justification: '' });
    const [attendanceConfig, setAttendanceConfig] = useState({ attendanceEnabled: false, attendanceMinMinutes: 20, attendanceMode: 'FREE' });

    // Settings state
    const [settingsForm, setSettingsForm] = useState({
        currentPassword: '',
        newUsername: '',
        newPassword: '',
        confirmPassword: ''
    });
    const [showCurrentPass, setShowCurrentPass] = useState(false);
    const [showNewPass, setShowNewPass] = useState(false);
    const [settingsMsg, setSettingsMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
    const [settingsLoading, setSettingsLoading] = useState(false);

    // Global Branding State
    const [brandingForm, setBrandingForm] = useState({
        platformName: '',
        namePart1: '',
        namePart2: '',
        nameColor1: '#e50914',
        nameColor2: '#172033',
        primaryColor: '#6366f1',
        accentColor: '#ec4899',
        logoUrl: '',
        bannerUrl: ''
    });
    const [brandingMsg, setBrandingMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
    const [brandingLoading, setBrandingLoading] = useState(false);

    const fetchData = useCallback(async () => {
        try {
            if (activeTab === 'overview') {
                const [statsRes, usersRes, coursesRes, auditRes, healthRes, reportsRes, liveRes] = await Promise.all([
                    api.get('/api/admin/stats'),
                    api.get('/api/admin/users', { params: { page: 1, limit: 100 } }),
                    api.get('/api/admin/courses'),
                    api.get('/api/admin/audit-log', { params: { page: 1, limit: 8 } }),
                    api.get('/api/admin/health'),
                    api.get('/api/admin/reports'),
                    api.get('/api/admin/live-classes')
                ]);
                setStats(statsRes.data);
                setUsers(usersRes.data.data);
                setUserTotal(usersRes.data.total);
                setCourses(coursesRes.data.data);
                setAuditLogs(auditRes.data.data);
                setHealthData(healthRes.data);
                setReports(reportsRes.data);
                setLiveClasses(liveRes.data);
            } else if (activeTab === 'users') {
                const res = await api.get('/api/admin/users', { params: { page: userPage, limit: 50, search: userSearch } });
                setUsers(res.data.data);
                setUserTotalPages(res.data.totalPages);
                setUserTotal(res.data.total);
            } else if (activeTab === 'courses') {
                if (isTeacher) {
                    const coursesRes = await api.get('/api/admin/courses');
                    setCourses(coursesRes.data.data);
                } else {
                    const [coursesRes, usersRes] = await Promise.all([
                        api.get('/api/admin/courses'),
                        api.get('/api/admin/users', { params: { limit: 100 } })
                    ]);
                    setCourses(coursesRes.data.data);
                    setUsers(usersRes.data.data);
                }
            } else if (activeTab === 'settings') {
                const res = await api.get('/api/admin/config');
                setBrandingForm({
                    platformName: res.data.platformName || 'EduVault',
                    namePart1: res.data.namePart1 || 'Edu',
                    namePart2: res.data.namePart2 || 'Vault',
                    nameColor1: res.data.nameColor1 || '#e50914',
                    nameColor2: res.data.nameColor2 || '#172033',
                    primaryColor: res.data.primaryColor || '#6366f1',
                    accentColor: res.data.accentColor || '#ec4899',
                    logoUrl: res.data.logoUrl || '',
                    bannerUrl: res.data.bannerUrl || ''
                });
            } else if (activeTab === 'audit') {
                const [auditRes, healthRes] = await Promise.all([
                    api.get('/api/admin/audit-log', { params: { page: auditPage, limit: 50 } }),
                    api.get('/api/admin/health')
                ]);
                setAuditLogs(auditRes.data.data);
                setAuditTotalPages(auditRes.data.totalPages);
                setHealthData(healthRes.data);
            } else if (activeTab === 'reports') {
                const res = await api.get('/api/admin/reports');
                setReports(res.data);
            } else if (activeTab === 'notifications') {
                const res = await api.get('/api/admin/email/status');
                setEmailStatus(res.data);
            } else if (activeTab === 'live') {
                const [liveRes, coursesRes] = await Promise.all([
                    api.get('/api/admin/live-classes'),
                    api.get('/api/admin/courses')
                ]);
                setLiveClasses(liveRes.data);
                setCourses(coursesRes.data.data);
            } else if (activeTab === 'moderation') {
                const res = await api.get('/api/admin/comments/flagged', { params: { page: flaggedPage, limit: 20 } });
                setFlaggedComments(res.data.comments);
                setFlaggedTotal(res.data.total);
                setFlaggedTotalPages(res.data.totalPages);
            } else if (activeTab === 'punishment') {
                const [violRes, bansRes, appealsRes, configRes, usersRes] = await Promise.all([
                    api.get('/api/admin/violations'),
                    api.get('/api/admin/bans'),
                    api.get('/api/admin/appeals', { params: { status: appealFilter } }),
                    api.get('/api/admin/config'),
                    api.get('/api/admin/users', { params: { limit: 200 } })
                ]);
                setViolations(violRes.data);
                setBans(bansRes.data);
                setAppeals(appealsRes.data);
                setPunishmentEnabled(configRes.data.forumPunishmentEnabled ?? false);
                setUsers(usersRes.data.data);
            } else if (activeTab === 'attendance') {
                const [coursesRes, configRes] = await Promise.all([
                    api.get('/api/admin/courses'),
                    api.get('/api/admin/config')
                ]);
                setCourses(coursesRes.data.data);
                setAttendanceConfig({
                    attendanceEnabled: configRes.data.attendanceEnabled ?? false,
                    attendanceMinMinutes: configRes.data.attendanceMinMinutes ?? 20,
                    attendanceMode: configRes.data.attendanceMode ?? 'FREE'
                });

                // Se já existe filtro, buscar presenças
                if (attendanceFilter.moduleId && attendanceFilter.date) {
                    const attRes = await api.get('/api/admin/attendance', {
                        params: { moduleId: attendanceFilter.moduleId, date: attendanceFilter.date }
                    });
                    setAttendanceData(attRes.data);
                }
            }
        } catch (error) { console.error('Error fetching admin data', error); }
    }, [activeTab, userPage, userSearch, auditPage, flaggedPage, appealFilter, isTeacher, attendanceFilter.moduleId, attendanceFilter.date]);

    useEffect(() => {
        fetchData();
    }, [activeTab, fetchData]);

    // Reseta página ao mudar a busca de usuários
    useEffect(() => {
        setUserPage(1);
    }, [userSearch]);

    // Preenche o username atual quando abre a tab
    useEffect(() => {
        if (activeTab === 'settings' && user?.username) {
            setSettingsForm(prev => ({ ...prev, newUsername: user.username || '' }));
        }
    }, [activeTab, user]);

    const handleCreateUser = async (e: React.FormEvent) => {
        e.preventDefault();
        try {
            const response = await api.post('/api/admin/users', newUser);
            setNewUser({ name: '', email: '', password: '', role: 'STUDENT' });
            fetchData();
            const delivery = response.data.emailDelivery;
            alert(delivery?.sent
                ? 'Usuário criado e credenciais enviadas por e-mail.'
                : delivery?.configured
                    ? 'Usuário criado, mas o e-mail não foi entregue. Confira o endereço e o provedor SMTP.'
                    : 'Usuário criado. O e-mail não foi enviado porque o SMTP ainda não está configurado.');
        } catch (err: unknown) {
            if (axios.isAxiosError(err)) {
                alert(err.response?.data?.message || 'Erro');
            } else {
                alert('Erro desconhecido');
            }
        }
    };

    const handleDeleteUser = async (id: string) => {
        try {
            await api.delete(`/api/admin/users/${id}`);
            fetchData();
        } catch { alert('Erro ao deletar'); }
    };

    const handleUpdateUser = async (targetUser: UserData) => {
        try {
            const payload = buildUserUpdatePayload(targetUser, editUserData);
            if (Object.keys(payload).length > 0) {
                await api.put(`/api/admin/users/${targetUser.id}`, payload);
                await fetchData();
            }
            setEditingUserId(null);
        } catch (error: unknown) {
            alert(axios.isAxiosError<{ message?: string }>(error)
                ? error.response?.data?.message || 'Erro ao atualizar usuário.'
                : 'Erro ao atualizar usuário.');
        }
    };

    const handleCreateCourse = async (e: React.FormEvent) => {
        e.preventDefault();
        try {
            await api.post('/api/admin/courses', newCourse);
            setNewCourse({ name: '', description: '', thumbnailUrl: '' });
            fetchData();
            alert('Curso criado com sucesso!');
        } catch { alert('Erro ao criar curso'); }
    };

    const handleDeleteCourse = async (id: string) => {
        try {
            await api.delete(`/api/admin/courses/${id}`);
            fetchData();
        } catch { alert('Erro ao deletar curso'); }
    };

    const handleCreateModule = async (e: React.FormEvent) => {
        e.preventDefault();
        try {
            await api.post('/api/admin/modules', newModule);
            setNewModule({ courseId: '', name: '' });
            fetchData();
            alert('Módulo criado com sucesso!');
        } catch { alert('Erro ao criar módulo'); }
    };

    const handleDeleteModule = async (id: string) => {
        try {
            await api.delete(`/api/admin/modules/${id}`);
            fetchData();
        } catch { alert('Erro ao deletar módulo'); }
    };

    const handleUploadVideo = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!uploadData.file || !uploadData.moduleId || !uploadData.title) {
            alert('Preencha título, módulo e selecione o arquivo de vídeo.');
            return;
        }

        const formData = new FormData();
        formData.append('video', uploadData.file);
        formData.append('title', uploadData.title);
        formData.append('moduleId', uploadData.moduleId);

        try {
            setUploading(true);
            setUploadProgress(0);
            await api.post('/api/videos/upload', formData, {
                onUploadProgress: (progressEvent) => {
                    if (progressEvent.total) {
                        setUploadProgress(Math.round((progressEvent.loaded * 100) / progressEvent.total));
                    }
                }
            });
            setUploadData({ moduleId: '', title: '', file: null });
            fetchData();
            alert('Vídeo enviado e na fila de processamento!');
        } catch (err: unknown) {
            if (axios.isAxiosError(err)) {
                alert(err.response?.data?.message || 'Erro no upload do vídeo');
            } else {
                alert('Erro desconhecido durante o upload');
            }
        } finally {
            setUploading(false);
            setUploadProgress(0);
        }
    };

    const handleDeleteVideo = async (id: string) => {
        try {
            await api.delete(`/api/admin/videos/${id}`);
            fetchData();
        } catch { alert('Erro ao deletar vídeo'); }
    };

    const handleEnrollStudent = async (e: React.FormEvent, courseId: string) => {
        e.preventDefault();
        if (!enrollmentData.userId) return;
        try {
            await api.post('/api/admin/enrollments', {
                courseId,
                userId: enrollmentData.userId,
                enrollmentRole: enrollmentData.enrollmentRole || 'STUDENT'
            });
            setEnrollmentData({ courseId: '', userId: '', enrollmentRole: 'STUDENT' });
            fetchData();
            alert('Matrícula realizada com sucesso!');
        } catch (err: unknown) {
            if (axios.isAxiosError(err)) {
                alert(err.response?.data?.message || 'Erro ao matricular');
            } else {
                alert('Erro ao matricular');
            }
        }
    };

    const handleEnrollAllStudents = async (courseId: string) => {
        try {
            const res = await api.post('/api/admin/enrollments/all', { courseId });
            fetchData();
            alert(`${res.data.enrolled} aluno(s) matriculado(s) com sucesso!`);
        } catch (err: unknown) {
            if (axios.isAxiosError(err)) {
                alert(err.response?.data?.message || 'Erro ao matricular');
            } else {
                alert('Erro ao matricular alunos');
            }
        }
    };

    const handleRemoveEnrollment = async (enrollmentId: string) => {
        try {
            await api.delete(`/api/admin/enrollments/${enrollmentId}`);
            fetchData();
        } catch { alert('Erro ao remover matrícula'); }
    };

    // Upload image for thumbnails or content
    const handleImageUpload = async (file: File): Promise<string | null> => {
        const formData = new FormData();
        formData.append('image', file);
        try {
            setUploadingImage(true);
            const res = await api.post('/api/admin/upload-image', formData);
            return res.data.url;
        } catch {
            alert('Erro ao fazer upload de imagem');
            return null;
        } finally {
            setUploadingImage(false);
        }
    };

    const handleCourseThumbnailUpload = async (file: File) => {
        const url = await handleImageUpload(file);
        if (url) setNewCourse(current => ({ ...current, thumbnailUrl: url }));
    };

    // Upload PDF for module material or course calendar
    const handlePdfUpload = async (file: File): Promise<string | null> => {
        const formData = new FormData();
        formData.append('pdf', file);
        try {
            const res = await api.post('/api/admin/upload-pdf', formData);
            return res.data.url;
        } catch {
            alert('Erro ao fazer upload do PDF');
            return null;
        }
    };

    const handleUploadModulePdf = async (moduleId: string, file: File) => {
        const url = await handlePdfUpload(file);
        if (url) {
            await api.put(`/api/admin/modules/${moduleId}`, { pdfUrl: url });
            fetchData();
        }
    };

    const handleRemoveModulePdf = async (moduleId: string) => {
        await api.put(`/api/admin/modules/${moduleId}`, { pdfUrl: null });
        fetchData();
    };

    const handleUploadCalendar = async (courseId: string, file: File) => {
        const url = await handlePdfUpload(file);
        if (url) {
            await api.put(`/api/admin/courses/${courseId}`, { calendarUrl: url });
            fetchData();
        }
    };

    const handleRemoveCalendar = async (courseId: string) => {
        await api.put(`/api/admin/courses/${courseId}`, { calendarUrl: null });
        fetchData();
    };

    // Edit video content
    const handleEditVideo = async (videoId: string) => {
        try {
            const contentToSave = editBlocks.length > 0 ? JSON.stringify(editBlocks) : editVideoData.content;
            await api.put(`/api/admin/videos/${videoId}`, { ...editVideoData, content: contentToSave });
            setEditingVideoId(null);
            setEditVideoData({ title: '', description: '', content: '' });
            setEditBlocks([]);
            fetchData();
            alert('Vídeo atualizado com sucesso!');
        } catch { alert('Erro ao atualizar vídeo'); }
    };

    // Open video for editing — parse content into blocks if possible
    const openVideoEditor = (v: { id: string; title: string; description: string | null; content: string | null }) => {
        setEditingVideoId(v.id);
        setEditVideoData({ title: v.title, description: v.description || '', content: v.content || '' });
        const parsed = parseContentField(v.content || null);
        setEditBlocks(parsed.isBlocks ? parsed.blocks : []);
        setEditorModalMode('edit');
    };

    // Excel student upload
    const handleExcelUpload = async (file: File) => {
        setExcelUploading(true);
        setExcelResults(null);
        setExcelEmailDelivery(null);
        try {
            const formData = new FormData();
            formData.append('file', file);
            const res = await api.post('/api/admin/upload-students-excel', formData);
            setExcelResults(res.data.results);
            setExcelEmailDelivery(res.data.emailDelivery || null);
            fetchData();
        } catch (err: unknown) {
            if (axios.isAxiosError(err)) {
                alert(err.response?.data?.message || 'Erro ao processar Excel');
            } else {
                alert('Erro ao processar Excel');
            }
        } finally {
            setExcelUploading(false);
        }
    };

    // Reprocess video with ERROR status
    const handleReprocessVideo = async (videoId: string) => {
        try {
            await api.post(`/api/admin/videos/${videoId}/reprocess`, {});
            fetchData();
            alert('Vídeo reenfileirado para processamento!');
        } catch (err: unknown) {
            if (axios.isAxiosError(err)) {
                alert(err.response?.data?.message || 'Erro ao reprocessar');
            } else {
                alert('Erro ao reprocessar vídeo');
            }
        }
    };

    // Unused variables removed

    const handleExportStudents = async () => {
        try {
            const res = await api.get('/api/admin/export-students', {
                responseType: 'blob'
            });
            const url = window.URL.createObjectURL(new Blob([res.data]));
            const a = document.createElement('a');
            a.href = url;
            a.download = `alunos-${new Date().toISOString().split('T')[0]}.xlsx`;
            a.click();
            window.URL.revokeObjectURL(url);
        } catch { alert('Erro ao exportar.'); }
    };

    const handleSendNotification = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!notifForm.title || !notifForm.message) return;
        try {
            const res = await api.post('/api/admin/notifications', notifForm);
            setNotificationFeedback(res.data.message);
            setNotifForm({ title: '', message: '' });
        } catch { setNotificationFeedback('Não foi possível registrar a notificação.'); }
    };

    // ── Live Class handlers ──
    const handleCreateLive = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!liveForm.courseId || !liveForm.title || !liveForm.startAt || !liveForm.zoomJoinUrl) return;
        try {
            await api.post('/api/admin/live-classes', liveForm);
            setLiveForm({ courseId: '', moduleId: '', title: '', description: '', startAt: '', endAt: '', zoomJoinUrl: '', zoomStartUrl: '', zoomMeetingId: '' });
            fetchData();
        } catch { alert('Erro ao criar aula ao vivo.'); }
    };

    const handleUpdateLive = async (id: string) => {
        try {
            await api.put(`/api/admin/live-classes/${id}`, { status: editingLiveStatus });
            setEditingLiveId(null);
            setEditingLiveStatus('');
            fetchData();
        } catch { alert('Erro ao atualizar status.'); }
    };

    const handleDeleteLive = (id: string, title: string) => {
        setConfirmAction({
            message: `Remover aula ao vivo "${title}"?`,
            action: async () => {
                try {
                    await api.delete(`/api/admin/live-classes/${id}`);
                    fetchData();
                } catch { alert('Erro ao remover aula ao vivo.'); }
            }
        });
    };

    const handleReorderCourse = async (courseId: string, direction: 'up' | 'down') => {
        const sorted = [...courses].sort((a, b) => (a.order || 0) - (b.order || 0));
        const idx = sorted.findIndex(c => c.id === courseId);
        if ((direction === 'up' && idx <= 0) || (direction === 'down' && idx >= sorted.length - 1)) return;
        const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
        const orders = sorted.map((c, i) => {
            if (i === idx) return { id: c.id, order: swapIdx };
            if (i === swapIdx) return { id: c.id, order: idx };
            return { id: c.id, order: i };
        });
        try {
            await api.put('/api/admin/courses/reorder', { orders });
            fetchData();
        } catch { alert('Erro ao reordenar.'); }
    };

    const handleUpdateBranding = async (e: React.FormEvent) => {
        e.preventDefault();
        try {
            setBrandingLoading(true);
            setBrandingMsg(null);

            await api.put('/api/admin/config', brandingForm);

            setBrandingMsg({ type: 'success', text: 'Branding global atualizado! Recarregue a página para ver os efeitos.' });

            setTimeout(() => {
                window.location.reload();
            }, 1000);

        } catch (err: unknown) {
            if (axios.isAxiosError(err)) setBrandingMsg({ type: 'error', text: err.response?.data?.message || 'Erro' });
            else setBrandingMsg({ type: 'error', text: 'Erro desconhecido.' });
        } finally { setBrandingLoading(false); }
    };

    const handleUploadBrandLogo = async (e: React.ChangeEvent<HTMLInputElement>) => {
        if (!e.target.files || e.target.files.length === 0) return;
        setBrandingLoading(true);
        const formData = new FormData();
        formData.append('image', e.target.files[0]);
        try {
            const res = await api.post('/api/admin/upload-image', formData);
            setBrandingForm({ ...brandingForm, logoUrl: res.data.url });
        } catch {
            alert('Erro ao fazer upload da logo.');
        } finally {
            setBrandingLoading(false);
        }
    };

    const handleUploadBanner = async (e: React.ChangeEvent<HTMLInputElement>) => {
        if (!e.target.files || e.target.files.length === 0) return;
        setBrandingLoading(true);
        const formData = new FormData();
        formData.append('image', e.target.files[0]);
        try {
            const res = await api.post('/api/admin/upload-image', formData);
            setBrandingForm({ ...brandingForm, bannerUrl: res.data.url });
        } catch {
            alert('Erro ao fazer upload do banner.');
        } finally {
            setBrandingLoading(false);
        }
    };

    const handleUpdateProfile = async (e: React.FormEvent) => {
        e.preventDefault();
        setSettingsMsg(null);
        setSettingsLoading(true);

        if (settingsForm.newPassword && settingsForm.newPassword !== settingsForm.confirmPassword) {
            setSettingsMsg({ type: 'error', text: 'As senhas não coincidem.' });
            setSettingsLoading(false);
            return;
        }

        if (!settingsForm.currentPassword) {
            setSettingsMsg({ type: 'error', text: 'Informe a senha atual para confirmar alterações.' });
            setSettingsLoading(false);
            return;
        }

        try {
            const payload: Record<string, string> = {
                currentPassword: settingsForm.currentPassword,
            };
            if (settingsForm.newUsername && settingsForm.newUsername !== user?.username) {
                payload.newUsername = settingsForm.newUsername;
            }
            if (settingsForm.newPassword) {
                payload.newPassword = settingsForm.newPassword;
            }

            const res = await api.put('/api/auth/profile', payload);

            // Atualizar o usuário autenticado no contexto
            doLogin(res.data.user);

            setSettingsForm(prev => ({
                ...prev,
                currentPassword: '',
                newPassword: '',
                confirmPassword: ''
            }));
            setSettingsMsg({ type: 'success', text: res.data.message || 'Credenciais atualizadas!' });
        } catch (err: unknown) {
            if (axios.isAxiosError(err)) {
                setSettingsMsg({ type: 'error', text: err.response?.data?.message || 'Erro ao atualizar.' });
            } else {
                setSettingsMsg({ type: 'error', text: 'Erro desconhecido.' });
            }
        } finally {
            setSettingsLoading(false);
        }
    };

    // Attendance handlers
    const fetchAttendance = async () => {
        if (!attendanceFilter.moduleId || !attendanceFilter.date) return;
        try {
            const res = await api.get('/api/admin/attendance', {
                params: { moduleId: attendanceFilter.moduleId, date: attendanceFilter.date }
            });
            setAttendanceData(res.data);
        } catch { console.error('Erro ao buscar presenças'); }
    };

    const handleAttendanceEdit = async () => {
        if (!attendanceEditModal || !attendanceEditForm.justification.trim()) {
            alert('A justificativa é obrigatória.');
            return;
        }
        try {
            if (attendanceEditModal.id) {
                await api.put(`/api/admin/attendance/${attendanceEditModal.id}`, {
                    status: attendanceEditForm.status,
                    justification: attendanceEditForm.justification
                });
            } else {
                await api.post('/api/admin/attendance', {
                    userId: attendanceEditModal.userId,
                    moduleId: attendanceEditModal.moduleId,
                    date: attendanceEditModal.date,
                    status: attendanceEditForm.status,
                    justification: attendanceEditForm.justification
                });
            }
            setAttendanceEditModal(null);
            setAttendanceEditForm({ status: '', justification: '' });
            fetchAttendance();
            alert('Presença atualizada com sucesso!');
        } catch (err: unknown) {
            if (axios.isAxiosError(err)) alert(err.response?.data?.message || 'Erro');
            else alert('Erro ao atualizar presença.');
        }
    };

    const handleSaveAttendanceConfig = async () => {
        try {
            await api.put('/api/admin/config', attendanceConfig);
            alert('Configurações de presença salvas!');
        } catch { alert('Erro ao salvar configurações de presença.'); }
    };

    const overviewTeachers = useMemo(() => users.filter(item => item.role === 'TEACHER').length, [users]);
    const overviewCourseRows = useMemo(() => buildOverviewCourseRows(courses, reports), [courses, reports]);
    const adminDate = useMemo(() => formatAdminDate(new Date()), []);

    const handleGlobalSearch = (event: React.FormEvent) => {
        event.preventDefault();
        const query = globalSearch.trim();
        if (!query) return;
        setUserSearchInput(query);
        setUserSearch(query);
        setUserPage(1);
        setActiveTab('users');
    };

    const openUserSecurityAction = (mode: 'password' | 'block', targetUser: UserData) => {
        setUserSecurityForm({ password: '', confirmPassword: '', reason: '' });
        setUserSecurityError('');
        setUserSecurityAction({ mode, user: targetUser });
    };

    const handleUserSecuritySubmit = async (event: React.FormEvent) => {
        event.preventDefault();
        if (!userSecurityAction) return;
        setUserSecurityError('');

        if (userSecurityAction.mode === 'password' && userSecurityForm.password !== userSecurityForm.confirmPassword) {
            setUserSecurityError('As senhas não coincidem.');
            return;
        }
        if (userSecurityAction.mode === 'block' && userSecurityForm.reason.trim().length < 3) {
            setUserSecurityError('Informe o motivo do bloqueio.');
            return;
        }

        setUserSecurityLoading(true);
        try {
            if (userSecurityAction.mode === 'password') {
                const response = await api.post(`/api/admin/users/${userSecurityAction.user.id}/reset-password`, {
                    password: userSecurityForm.password
                });
                const delivery = response.data.emailDelivery;
                alert(delivery?.sent
                    ? 'Senha redefinida e nova credencial enviada por e-mail.'
                    : delivery?.configured
                        ? 'Senha redefinida, mas o e-mail não foi entregue.'
                        : 'Senha redefinida. O SMTP ainda não está configurado, portanto a credencial não foi enviada.');
            } else {
                await api.patch(`/api/admin/users/${userSecurityAction.user.id}/access`, {
                    blocked: true,
                    reason: userSecurityForm.reason.trim()
                });
            }
            setUserSecurityAction(null);
            setUserSecurityForm({ password: '', confirmPassword: '', reason: '' });
            await fetchData();
        } catch (error: unknown) {
            setUserSecurityError(axios.isAxiosError<{ message?: string }>(error)
                ? error.response?.data?.message || 'Não foi possível concluir a ação.'
                : 'Não foi possível concluir a ação.');
        } finally {
            setUserSecurityLoading(false);
        }
    };

    const handleUnblockUser = async (targetUser: UserData) => {
        try {
            await api.patch(`/api/admin/users/${targetUser.id}/access`, { blocked: false });
            await fetchData();
        } catch (error: unknown) {
            alert(axios.isAxiosError<{ message?: string }>(error) ? error.response?.data?.message || 'Erro ao liberar acesso.' : 'Erro ao liberar acesso.');
        }
    };

    const handleRevokeUserSessions = async (targetUser: UserData) => {
        try {
            await api.post(`/api/admin/users/${targetUser.id}/revoke-sessions`, {});
            alert(`Sessões de ${targetUser.name} revogadas com sucesso.`);
        } catch (error: unknown) {
            alert(axios.isAxiosError<{ message?: string }>(error) ? error.response?.data?.message || 'Erro ao revogar sessões.' : 'Erro ao revogar sessões.');
        }
    };

    return (
        <>
        <div className={`admin-root ${sidebarCollapsed ? 'admin-sidebar-collapsed' : ''}`}>
            <AdminHeader
                config={config}
                globalSearch={globalSearch}
                isTeacher={isTeacher}
                sidebarCollapsed={sidebarCollapsed}
                user={user}
                onGlobalSearchChange={setGlobalSearch}
                onGlobalSearchSubmit={handleGlobalSearch}
                onLogout={logout}
                onSelectTab={setActiveTab}
                onToggleSidebar={() => setSidebarCollapsed(value => !value)}
            />

            <div className="admin-layout">
                <AdminSidebar activeTab={activeTab} flaggedTotal={flaggedTotal} isTeacher={isTeacher} onSelectTab={setActiveTab} />

                {/* Main Content Area */}
                <main className="admin-main">

                    {/* TAB: OVERVIEW */}
                    {activeTab === 'overview' && stats && (
                        <AdminOverview
                            adminDate={adminDate}
                            auditLogs={auditLogs}
                            courseRows={overviewCourseRows}
                            flaggedTotal={flaggedTotal}
                            healthData={healthData}
                            platformName={config.platformName}
                            stats={stats}
                            teacherTotal={overviewTeachers}
                            userName={user?.name}
                            userTotal={userTotal}
                            onSelectTab={setActiveTab}
                        />
                    )}

                    {/* TAB: USERS */}
                    {activeTab === 'users' && (
                        <AdminUsers
                            currentUserId={user?.id}
                            editForm={editUserData}
                            editingUserId={editingUserId}
                            excelDelivery={excelEmailDelivery}
                            excelResults={excelResults}
                            excelUploading={excelUploading}
                            newUser={newUser}
                            page={userPage}
                            search={userSearch}
                            searchInput={userSearchInput}
                            total={userTotal}
                            totalPages={userTotalPages}
                            users={users}
                            onCancelEdit={() => setEditingUserId(null)}
                            onClearSearch={() => { setUserSearchInput(''); setUserSearch(''); }}
                            onCreateUser={handleCreateUser}
                            onDeleteUser={handleDeleteUser}
                            onEditFormChange={setEditUserData}
                            onExcelUpload={handleExcelUpload}
                            onExport={handleExportStudents}
                            onNewUserChange={setNewUser}
                            onOpenSecurity={openUserSecurityAction}
                            onPageChange={setUserPage}
                            onRequestConfirmation={(message, action) => setConfirmAction({ message, action })}
                            onRevokeSessions={handleRevokeUserSessions}
                            onSaveUser={handleUpdateUser}
                            onSearch={() => setUserSearch(userSearchInput)}
                            onSearchInputChange={setUserSearchInput}
                            onStartEdit={targetUser => {
                                setEditingUserId(targetUser.id);
                                setEditUserData({ name: targetUser.name, email: targetUser.email, role: targetUser.role });
                            }}
                            onUnblockUser={handleUnblockUser}
                        />
                    )}

                    {/* TAB: COURSES */}
                    {activeTab === 'courses' && (
                        <AdminCourses
                            courses={courses}
                            editingVideoId={editingVideoId}
                            enrollment={enrollmentData}
                            isTeacher={isTeacher}
                            moduleForm={newModule}
                            courseForm={newCourse}
                            upload={uploadData}
                            uploadProgress={uploadProgress}
                            uploading={uploading}
                            uploadingImage={uploadingImage}
                            users={users}
                            onCourseFormChange={setNewCourse}
                            onCourseThumbnailUpload={handleCourseThumbnailUpload}
                            onCreateCourse={handleCreateCourse}
                            onCreateModule={handleCreateModule}
                            onDeleteCourse={handleDeleteCourse}
                            onDeleteModule={handleDeleteModule}
                            onDeleteVideo={handleDeleteVideo}
                            onEnroll={handleEnrollStudent}
                            onEnrollAll={handleEnrollAllStudents}
                            onEnrollmentChange={setEnrollmentData}
                            onModuleFormChange={setNewModule}
                            onOpenVideoEditor={openVideoEditor}
                            onRemoveCalendar={handleRemoveCalendar}
                            onRemoveEnrollment={handleRemoveEnrollment}
                            onRemoveModulePdf={handleRemoveModulePdf}
                            onReorderCourse={handleReorderCourse}
                            onReprocessVideo={handleReprocessVideo}
                            onRequestConfirmation={(message, action) => setConfirmAction({ message, action })}
                            onUploadCalendar={handleUploadCalendar}
                            onUploadChange={setUploadData}
                            onUploadModulePdf={handleUploadModulePdf}
                            onUploadVideo={handleUploadVideo}
                        />
                    )}

                    {/* TAB: AUDIT LOG */}
                    {activeTab === 'audit' && (
                        <AdminAudit
                            health={healthData}
                            logs={auditLogs}
                            page={auditPage}
                            totalPages={auditTotalPages}
                            onPageChange={setAuditPage}
                        />
                    )}

                    {/* TAB: REPORTS */}
                    {activeTab === 'reports' && (
                        <AdminReports reports={reports} />
                    )}

                    {/* TAB: NOTIFICATIONS */}
                    {activeTab === 'notifications' && (
                        <AdminNotifications
                            emailStatus={emailStatus}
                            feedback={notificationFeedback}
                            form={notifForm}
                            onChange={setNotifForm}
                            onSubmit={handleSendNotification}
                        />
                    )}

                    {activeTab === 'live' && (
                        <AdminLiveClasses
                            classes={liveClasses}
                            courses={courses}
                            editingId={editingLiveId}
                            editingStatus={editingLiveStatus}
                            form={liveForm}
                            onCreate={handleCreateLive}
                            onDelete={handleDeleteLive}
                            onEditingChange={(id, status) => {
                                setEditingLiveId(id);
                                if (status) setEditingLiveStatus(status);
                            }}
                            onFormChange={setLiveForm}
                            onStatusChange={setEditingLiveStatus}
                            onUpdate={handleUpdateLive}
                        />
                    )}


                    {activeTab === 'moderation' && (
                        <AdminModeration
                            comments={flaggedComments}
                            page={flaggedPage}
                            totalPages={flaggedTotalPages}
                            onApprove={async id => {
                                await api.put(`/api/admin/comments/${id}/approve`, {});
                                await fetchData();
                            }}
                            onPageChange={setFlaggedPage}
                            onRemove={async id => {
                                await api.delete(`/api/admin/comments/${id}`);
                                await fetchData();
                            }}
                        />
                    )}


                    {activeTab === 'punishment' && (
                        <AdminPunishment
                            appeals={appeals}
                            appealFilter={appealFilter}
                            bans={bans}
                            enabled={punishmentEnabled}
                            manualBan={manualBanForm}
                            users={users}
                            violations={violations}
                            onAppealFilterChange={setAppealFilter}
                            onApplyBan={async () => {
                                await api.post('/api/admin/bans', manualBanForm);
                                setManualBanForm({ userId: '', reason: '', banType: 'TEMP_1D' });
                                await fetchData();
                            }}
                            onLiftBan={async id => {
                                await api.put(`/api/admin/bans/${id}/lift`, {});
                                await fetchData();
                            }}
                            onManualBanChange={setManualBanForm}
                            onRefresh={() => void fetchData()}
                            onReviewAppeal={async (id, status) => {
                                await api.put(`/api/admin/appeals/${id}`, { status, adminNote: status === 'APPROVED' ? 'Recurso aceito' : 'Recurso negado' });
                                await fetchData();
                            }}
                            onToggle={async () => {
                                const response = await api.put('/api/admin/punishment-toggle', {});
                                setPunishmentEnabled(response.data.forumPunishmentEnabled);
                            }}
                        />
                    )}


                    {activeTab === 'broadcast' && user?.role === 'ADMIN' && (
                        <div className="admin-fade-in">
                            <BroadcastAdminPanel />
                        </div>
                    )}

                    {activeTab === 'privaterooms' && (
                        <div className="admin-fade-in">
                            <PrivateRoomAdminPanel />
                        </div>
                    )}

                    {/* TAB: SETTINGS */}
                    {activeTab === 'settings' && (
                        <div className="admin-fade-in">
                            <h2 className="admin-page-title">Configurações da Conta</h2>
                            <p style={{ color: 'var(--text-muted)', marginBottom: '2rem' }}>Altere seu nome de usuário e senha de acesso.</p>

                            <div className="settings-card">
                                {settingsMsg && (
                                    <div className={`settings-alert ${settingsMsg.type}`}>
                                        {settingsMsg.type === 'success' ? <CheckCircle size={18} /> : <AlertCircle size={18} />}
                                        {settingsMsg.text}
                                    </div>
                                )}

                                <form onSubmit={handleUpdateProfile} className="settings-form">
                                    {/* Username */}
                                    <div className="settings-field">
                                        <label>Nome de Usuário</label>
                                        <input
                                            type="text"
                                            value={settingsForm.newUsername}
                                            onChange={e => setSettingsForm({ ...settingsForm, newUsername: e.target.value })}
                                            placeholder="Novo nome de usuário"
                                            className="settings-input"
                                        />
                                        <small style={{ color: 'var(--text-muted)' }}>
                                            Login atual: <strong>{user?.username || user?.email}</strong>
                                        </small>
                                    </div>

                                    <div style={{ borderTop: '1px solid var(--glass-border)', margin: '1.5rem 0' }} />

                                    {/* Nova Senha */}
                                    <div className="settings-field">
                                        <label>Nova Senha</label>
                                        <div style={{ position: 'relative' }}>
                                            <input
                                                type={showNewPass ? 'text' : 'password'}
                                                value={settingsForm.newPassword}
                                                onChange={e => setSettingsForm({ ...settingsForm, newPassword: e.target.value })}
                                                placeholder="Deixe em branco para manter a atual"
                                                className="settings-input"
                                            />
                                            <button type="button" onClick={() => setShowNewPass(!showNewPass)} className="settings-eye-btn">
                                                {showNewPass ? <EyeOff size={18} /> : <Eye size={18} />}
                                            </button>
                                        </div>
                                    </div>

                                    <div className="settings-field">
                                        <label>Confirmar Nova Senha</label>
                                        <input
                                            type="password"
                                            value={settingsForm.confirmPassword}
                                            onChange={e => setSettingsForm({ ...settingsForm, confirmPassword: e.target.value })}
                                            placeholder="Repita a nova senha"
                                            className="settings-input"
                                        />
                                    </div>

                                    <div style={{ borderTop: '1px solid var(--glass-border)', margin: '1.5rem 0' }} />

                                    {/* Senha Atual (obrigatória para confirmar) */}
                                    <div className="settings-field">
                                        <label>Senha Atual <span style={{ color: 'var(--danger)' }}>*</span></label>
                                        <div style={{ position: 'relative' }}>
                                            <input
                                                type={showCurrentPass ? 'text' : 'password'}
                                                value={settingsForm.currentPassword}
                                                onChange={e => setSettingsForm({ ...settingsForm, currentPassword: e.target.value })}
                                                placeholder="Informe sua senha atual para confirmar"
                                                className="settings-input"
                                                required
                                            />
                                            <button type="button" onClick={() => setShowCurrentPass(!showCurrentPass)} className="settings-eye-btn">
                                                {showCurrentPass ? <EyeOff size={18} /> : <Eye size={18} />}
                                            </button>
                                        </div>
                                        <small style={{ color: 'var(--text-muted)' }}>Obrigatório para confirmar qualquer alteração.</small>
                                    </div>

                                    <button
                                        type="submit"
                                        className="settings-save-btn"
                                        disabled={settingsLoading}
                                    >
                                        <Save size={18} />
                                        {settingsLoading ? 'Salvando...' : 'Salvar Alterações'}
                                    </button>
                                </form>
                            </div>

                            <hr className="admin-divider" />

                            <h2 className="admin-page-title">Aparência da Plataforma (Branding Global)</h2>
                            <p style={{ color: 'var(--text-muted)', marginBottom: '2rem' }}>Personalize as cores, o nome e o logo. Estas alterações afetam todos os usuários imediatamente.</p>

                            <div className="settings-card">
                                {brandingMsg && (
                                    <div className={`settings-alert ${brandingMsg.type}`}>
                                        {brandingMsg.type === 'success' ? <CheckCircle size={18} /> : <AlertCircle size={18} />}
                                        {brandingMsg.text}
                                    </div>
                                )}

                                <form onSubmit={handleUpdateBranding} className="settings-form">
                                    <div className="settings-field">
                                        <label>Nome da Plataforma (título da aba do navegador)</label>
                                        <input
                                            type="text"
                                            value={brandingForm.platformName}
                                            onChange={e => setBrandingForm({ ...brandingForm, platformName: e.target.value })}
                                            placeholder="Ex: EduVault"
                                            className="settings-input"
                                            required
                                        />
                                    </div>

                                    <div className="settings-field">
                                        <label>Nome Estilizado (aparece no header)</label>
                                        <small style={{ color: 'var(--text-muted)', display: 'block', marginBottom: '0.5rem' }}>
                                            Divida o nome em duas partes para aplicar cores diferentes. Ex: <strong style={{ color: brandingForm.nameColor1 }}>{brandingForm.namePart1 || 'Edu'}</strong><strong style={{ color: brandingForm.nameColor2 }}>{brandingForm.namePart2 || 'Vault'}</strong>
                                        </small>
                                        <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
                                            <div style={{ flex: 1, minWidth: '120px' }}>
                                                <label style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Parte 1</label>
                                                <input
                                                    type="text"
                                                    value={brandingForm.namePart1}
                                                    onChange={e => setBrandingForm({ ...brandingForm, namePart1: e.target.value })}
                                                    placeholder="Edu"
                                                    className="settings-input"
                                                />
                                            </div>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                                <label style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Cor 1</label>
                                                <input
                                                    type="color"
                                                    value={brandingForm.nameColor1}
                                                    onChange={e => setBrandingForm({ ...brandingForm, nameColor1: e.target.value })}
                                                    style={{ width: '40px', height: '36px', padding: '0', border: 'none', borderRadius: '4px', cursor: 'pointer', background: 'transparent' }}
                                                />
                                                <span style={{ fontFamily: 'monospace', color: 'var(--text-muted)', fontSize: '0.8rem' }}>{brandingForm.nameColor1}</span>
                                            </div>
                                            <div style={{ flex: 1, minWidth: '120px' }}>
                                                <label style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Parte 2</label>
                                                <input
                                                    type="text"
                                                    value={brandingForm.namePart2}
                                                    onChange={e => setBrandingForm({ ...brandingForm, namePart2: e.target.value })}
                                                    placeholder="Vault"
                                                    className="settings-input"
                                                />
                                            </div>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                                <label style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Cor 2</label>
                                                <input
                                                    type="color"
                                                    value={brandingForm.nameColor2}
                                                    onChange={e => setBrandingForm({ ...brandingForm, nameColor2: e.target.value })}
                                                    style={{ width: '40px', height: '36px', padding: '0', border: 'none', borderRadius: '4px', cursor: 'pointer', background: 'transparent' }}
                                                />
                                                <span style={{ fontFamily: 'monospace', color: 'var(--text-muted)', fontSize: '0.8rem' }}>{brandingForm.nameColor2}</span>
                                            </div>
                                        </div>
                                    </div>

                                    <div className="settings-field">
                                        <label>Cor Primária (Tema)</label>
                                        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
                                            <input
                                                type="color"
                                                value={brandingForm.primaryColor}
                                                onChange={e => setBrandingForm({ ...brandingForm, primaryColor: e.target.value })}
                                                style={{ width: '50px', height: '40px', padding: '0', border: 'none', borderRadius: '4px', cursor: 'pointer', background: 'transparent' }}
                                                required
                                            />
                                            <span style={{ fontFamily: 'monospace', color: 'var(--text-muted)' }}>{brandingForm.primaryColor}</span>
                                        </div>
                                    </div>

                                    <div className="settings-field">
                                        <label>Cor de Destaque (Accent)</label>
                                        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
                                            <input
                                                type="color"
                                                value={brandingForm.accentColor}
                                                onChange={e => setBrandingForm({ ...brandingForm, accentColor: e.target.value })}
                                                style={{ width: '50px', height: '40px', padding: '0', border: 'none', borderRadius: '4px', cursor: 'pointer', background: 'transparent' }}
                                                required
                                            />
                                            <span style={{ fontFamily: 'monospace', color: 'var(--text-muted)' }}>{brandingForm.accentColor}</span>
                                        </div>
                                    </div>

                                    <div className="settings-field">
                                        <label>Logo da Plataforma</label>
                                        {brandingForm.logoUrl && (
                                            <div style={{ marginBottom: '1rem' }}>
                                                <img src={resolveMediaUrl(brandingForm.logoUrl)} alt="Logo Preview" style={{ maxHeight: '60px', borderRadius: '8px', border: '1px solid var(--glass-border)' }} />
                                            </div>
                                        )}
                                        <input
                                            type="file"
                                            accept="image/png, image/jpeg, image/svg+xml"
                                            onChange={handleUploadBrandLogo}
                                            disabled={brandingLoading}
                                            style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}
                                        />
                                        <small style={{ color: 'var(--text-muted)' }}>Faça o upload de uma imagem PNG ou SVG com fundo transparente.</small>
                                    </div>

                                    <div className="settings-field">
                                        <label>Banner do Dashboard (Aluno)</label>
                                        {brandingForm.bannerUrl && (
                                            <div style={{ marginBottom: '1rem' }}>
                                                <img src={resolveMediaUrl(brandingForm.bannerUrl)} alt="Banner Preview" style={{ maxHeight: '120px', width: '100%', objectFit: 'cover', borderRadius: '12px', border: '1px solid var(--glass-border)' }} />
                                                <button
                                                    type="button"
                                                    onClick={() => setBrandingForm({ ...brandingForm, bannerUrl: '' })}
                                                    style={{ marginTop: '0.5rem', background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: '0.85rem' }}
                                                >
                                                    <X size={14} /> Remover banner
                                                </button>
                                            </div>
                                        )}
                                        <input
                                            type="file"
                                            accept="image/png, image/jpeg, image/webp"
                                            onChange={handleUploadBanner}
                                            disabled={brandingLoading}
                                            style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}
                                        />
                                        <small style={{ color: 'var(--text-muted)' }}>Imagem horizontal (recomendado: 1400×300px). Aparece no topo do painel do aluno.</small>
                                    </div>

                                    <button type="submit" className="settings-save-btn" disabled={brandingLoading} style={{ marginTop: '1.5rem', alignSelf: 'flex-start' }}>
                                        {brandingLoading ? 'Salvando...' : (
                                            <>
                                                <Save size={18} /> Salvar Aparência
                                            </>
                                        )}
                                    </button>
                                </form>
                            </div>
                        </div>
                    )}

                    {activeTab === 'attendance' && (
                        <AdminAttendance
                            config={attendanceConfig}
                            courses={courses}
                            data={attendanceData}
                            editForm={attendanceEditForm}
                            editModal={attendanceEditModal}
                            filter={attendanceFilter}
                            modules={attendanceModules}
                            onBeginEdit={attendance => {
                                setAttendanceEditModal({
                                    id: attendance.id || '',
                                    userId: attendance.userId,
                                    moduleId: attendanceFilter.moduleId,
                                    date: attendanceFilter.date,
                                    currentStatus: attendance.status
                                });
                                setAttendanceEditForm({
                                    status: attendance.status === 'PRESENT' ? 'ABSENT' : 'PRESENT',
                                    justification: ''
                                });
                            }}
                            onCloseEdit={() => setAttendanceEditModal(null)}
                            onConfigChange={setAttendanceConfig}
                            onCourseChange={courseId => {
                                setAttendanceFilter(current => ({ ...current, courseId, moduleId: '' }));
                                setAttendanceModules(courses.find(course => course.id === courseId)?.modules || []);
                                setAttendanceData([]);
                            }}
                            onEditFormChange={setAttendanceEditForm}
                            onFetch={fetchAttendance}
                            onFilterChange={setAttendanceFilter}
                            onSaveConfig={handleSaveAttendanceConfig}
                            onSubmitEdit={handleAttendanceEdit}
                        />
                    )}


                </main>
            </div>
        </div>

        {editingVideoId && (
            <AdminVideoEditor
                blocks={editBlocks}
                form={editVideoData}
                mode={editorModalMode}
                onBlocksChange={setEditBlocks}
                onClose={() => {
                    setEditingVideoId(null);
                    setEditBlocks([]);
                    setEditorModalMode('edit');
                }}
                onFormChange={setEditVideoData}
                onModeChange={setEditorModalMode}
                onSave={() => void handleEditVideo(editingVideoId)}
            />
        )}


        {userSecurityAction && (
            <AdminUserSecurityModal
                action={userSecurityAction}
                error={userSecurityError}
                form={userSecurityForm}
                loading={userSecurityLoading}
                onChange={setUserSecurityForm}
                onClose={() => setUserSecurityAction(null)}
                onSubmit={handleUserSecuritySubmit}
            />
        )}


        {/* Confirm Modal */}
        <ConfirmModal
            open={!!confirmAction}
            message={confirmAction?.message || ''}
            onConfirm={() => { confirmAction?.action(); setConfirmAction(null); }}
            onCancel={() => setConfirmAction(null)}
        />
        </>
    );
}
