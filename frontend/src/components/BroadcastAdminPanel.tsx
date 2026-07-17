import { useEffect, useState } from 'react';
import axios from 'axios';
import {
    CalendarClock, Edit3, ExternalLink, Handshake, Loader2, Megaphone,
    Plus, RadioTower, RefreshCw, Save, Settings2, Trash2, X, Upload
} from 'lucide-react';
import api from '../lib/api';
import type {
    BroadcastPartner,
    BroadcastProgram,
    BroadcastSettings,
    BroadcastTickerItem,
} from '../lib/broadcast';
import './BroadcastAdminPanel.css';

type ResourceTab = 'programs' | 'ticker' | 'partners';
type JsonRecord = Record<string, unknown>;

const EMPTY_SETTINGS: BroadcastSettings = {
    title: 'Campus ao Vivo',
    description: 'Conhecimento, encontros e programação em um único sinal.',
    liveUrl: '/broadcast/hls/stream.m3u8',
    loopUrl: '/broadcast/hls/loop.m3u8',
    posterUrl: '',
    logoUrl: '',
    accentColor: '#00c4b5',
    liveTitle: 'Campus ao vivo agora',
    loopTitle: 'Programação contínua',
    liveSource: 'OBS',
    liveYoutubeUrl: '',
};

const EMPTY_PROGRAM: Omit<BroadcastProgram, 'id' | 'order'> = {
    title: '', description: '', category: '', startAt: null, endAt: null,
    sourceUrl: '', posterUrl: '', active: true,
};
const EMPTY_TICKER: Omit<BroadcastTickerItem, 'id' | 'order'> = { text: '', href: '', active: true };
const EMPTY_PARTNER: Omit<BroadcastPartner, 'id' | 'order'> = { name: '', logoUrl: '', destinationUrl: '', active: true };

function record(value: unknown): JsonRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonRecord : {};
}

function stringValue(value: unknown, fallback = ''): string {
    return typeof value === 'string' ? value : fallback;
}

function booleanValue(value: unknown, fallback = true): boolean {
    return typeof value === 'boolean' ? value : fallback;
}

function numberValue(value: unknown, fallback = 0): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizeSettings(value: unknown): BroadcastSettings {
    const item = record(value);
    return {
        title: stringValue(item.title, stringValue(item.companyName, EMPTY_SETTINGS.title)),
        description: stringValue(item.description, stringValue(item.tagline)),
        liveUrl: stringValue(item.liveUrl, stringValue(item.liveHlsUrl, EMPTY_SETTINGS.liveUrl)),
        loopUrl: stringValue(item.loopUrl, stringValue(item.loopHlsUrl, EMPTY_SETTINGS.loopUrl)),
        posterUrl: stringValue(item.posterUrl, stringValue(item.backgroundUrl)),
        logoUrl: stringValue(item.logoUrl),
        accentColor: stringValue(item.accentColor, EMPTY_SETTINGS.accentColor),
        liveTitle: stringValue(item.liveTitle, EMPTY_SETTINGS.liveTitle),
        loopTitle: stringValue(item.loopTitle, EMPTY_SETTINGS.loopTitle),
        liveSource: (item.liveSource === 'YOUTUBE' ? 'YOUTUBE' : 'OBS') as 'OBS' | 'YOUTUBE',
        liveYoutubeUrl: stringValue(item.liveYoutubeUrl),
    };
}

function normalizePrograms(value: unknown): BroadcastProgram[] {
    if (!Array.isArray(value)) return [];
    return value.map((entry, index) => {
        const item = record(entry);
        return {
            id: stringValue(item.id, `program-${index}`),
            title: stringValue(item.title),
            description: stringValue(item.description),
            category: stringValue(item.category),
            startAt: stringValue(item.startAt, stringValue(item.startsAt)) || null,
            endAt: stringValue(item.endAt, stringValue(item.endsAt)) || null,
            sourceUrl: stringValue(item.sourceUrl, stringValue(item.videoUrl, stringValue(item.video))),
            posterUrl: stringValue(item.posterUrl),
            active: booleanValue(item.active ?? item.published),
            order: numberValue(item.order ?? item.position, index),
        };
    }).sort((a, b) => a.order - b.order);
}

function normalizeTickers(value: unknown): BroadcastTickerItem[] {
    if (!Array.isArray(value)) return [];
    return value.map((entry, index) => {
        const item = record(entry);
        return {
            id: stringValue(item.id, `ticker-${index}`),
            text: stringValue(item.text, stringValue(item.message)),
            href: stringValue(item.href, stringValue(item.url)),
            active: booleanValue(item.active ?? item.published),
            order: numberValue(item.order ?? item.position, index),
        };
    }).sort((a, b) => a.order - b.order);
}

function normalizePartners(value: unknown): BroadcastPartner[] {
    if (!Array.isArray(value)) return [];
    return value.map((entry, index) => {
        const item = record(entry);
        return {
            id: stringValue(item.id, `partner-${index}`),
            name: stringValue(item.name),
            logoUrl: stringValue(item.logoUrl),
            destinationUrl: stringValue(item.destinationUrl, stringValue(item.url)),
            active: booleanValue(item.active ?? item.published),
            order: numberValue(item.order ?? item.position, index),
        };
    }).sort((a, b) => a.order - b.order);
}

function toDateTimeLocal(value: string | null): string {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const offset = date.getTimezoneOffset() * 60_000;
    return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function apiErrorMessage(error: unknown, fallback: string): string {
    if (!axios.isAxiosError(error)) return fallback;
    const payload = record(error.response?.data);
    return stringValue(payload.message, stringValue(record(payload.error).message, fallback));
}

export default function BroadcastAdminPanel() {
    const [settings, setSettings] = useState<BroadcastSettings>(EMPTY_SETTINGS);
    const [programs, setPrograms] = useState<BroadcastProgram[]>([]);
    const [tickers, setTickers] = useState<BroadcastTickerItem[]>([]);
    const [partners, setPartners] = useState<BroadcastPartner[]>([]);
    const [resourceTab, setResourceTab] = useState<ResourceTab>('programs');
    const [programForm, setProgramForm] = useState(EMPTY_PROGRAM);
    const [tickerForm, setTickerForm] = useState(EMPTY_TICKER);
    const [partnerForm, setPartnerForm] = useState(EMPTY_PARTNER);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const [success, setSuccess] = useState('');

    const load = async () => {
        setLoading(true);
        setError('');
        try {
            const response = await api.get('/api/admin/broadcast');
            const payload = record(response.data);
            setSettings(normalizeSettings(payload.settings));
            setPrograms(normalizePrograms(payload.programs));
            setTickers(normalizeTickers(payload.tickers ?? payload.ticker));
            setPartners(normalizePartners(payload.partners));
        } catch (loadError: unknown) {
            setError(apiErrorMessage(loadError, 'Não foi possível carregar a operação de broadcast.'));
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        void load();
    }, []);

    const notifySuccess = (message: string) => {
        setSuccess(message);
        window.setTimeout(() => setSuccess(''), 3000);
    };

    const saveSettings = async (event: React.FormEvent) => {
        event.preventDefault();
        setSaving(true);
        setError('');
        try {
            const response = await api.put('/api/admin/broadcast', settings);
            const payload = record(response.data);
            setSettings(normalizeSettings(payload.settings ?? response.data));
            notifySuccess('Configurações do Campus publicadas.');
        } catch (saveError: unknown) {
            setError(apiErrorMessage(saveError, 'Não foi possível salvar o broadcast.'));
        } finally {
            setSaving(false);
        }
    };

    const resetEditor = () => {
        setEditingId(null);
        setProgramForm(EMPTY_PROGRAM);
        setTickerForm(EMPTY_TICKER);
        setPartnerForm(EMPTY_PARTNER);
    };

    const submitProgram = async (event: React.FormEvent) => {
        event.preventDefault();
        setSaving(true);
        setError('');
        const payload = {
            ...programForm,
            startAt: programForm.startAt ? new Date(programForm.startAt).toISOString() : null,
            endAt: programForm.endAt ? new Date(programForm.endAt).toISOString() : null,
        };
        try {
            const response = editingId
                ? await api.put(`/api/admin/broadcast/programs/${editingId}`, payload)
                : await api.post('/api/admin/broadcast/programs', payload);
            const saved = normalizePrograms([record(response.data).program ?? response.data])[0];
            setPrograms((current) => editingId
                ? current.map((item) => item.id === editingId ? saved : item)
                : [...current, saved]);
            resetEditor();
            notifySuccess(editingId ? 'Programa atualizado.' : 'Programa adicionado.');
        } catch (saveError: unknown) {
            setError(apiErrorMessage(saveError, 'Não foi possível salvar o programa.'));
        } finally {
            setSaving(false);
        }
    };

    const submitTicker = async (event: React.FormEvent) => {
        event.preventDefault();
        setSaving(true);
        setError('');
        try {
            const response = editingId
                ? await api.put(`/api/admin/broadcast/ticker/${editingId}`, tickerForm)
                : await api.post('/api/admin/broadcast/ticker', tickerForm);
            const saved = normalizeTickers([record(response.data).ticker ?? response.data])[0];
            setTickers((current) => editingId ? current.map((item) => item.id === editingId ? saved : item) : [...current, saved]);
            resetEditor();
            notifySuccess(editingId ? 'Aviso atualizado.' : 'Aviso publicado.');
        } catch (saveError: unknown) {
            setError(apiErrorMessage(saveError, 'Não foi possível salvar o aviso.'));
        } finally {
            setSaving(false);
        }
    };

    const submitPartner = async (event: React.FormEvent) => {
        event.preventDefault();
        setSaving(true);
        setError('');
        try {
            const response = editingId
                ? await api.put(`/api/admin/broadcast/partners/${editingId}`, partnerForm)
                : await api.post('/api/admin/broadcast/partners', partnerForm);
            const saved = normalizePartners([record(response.data).partner ?? response.data])[0];
            setPartners((current) => editingId ? current.map((item) => item.id === editingId ? saved : item) : [...current, saved]);
            resetEditor();
            notifySuccess(editingId ? 'Parceiro atualizado.' : 'Parceiro adicionado.');
        } catch (saveError: unknown) {
            setError(apiErrorMessage(saveError, 'Não foi possível salvar o parceiro.'));
        } finally {
            setSaving(false);
        }
    };

    const removeResource = async (type: ResourceTab, id: string, label: string) => {
        if (!window.confirm(`Remover “${label}”?`)) return;
        setError('');
        try {
            await api.delete(`/api/admin/broadcast/${type}/${id}`);
            if (type === 'programs') setPrograms((current) => current.filter((item) => item.id !== id));
            if (type === 'ticker') setTickers((current) => current.filter((item) => item.id !== id));
            if (type === 'partners') setPartners((current) => current.filter((item) => item.id !== id));
            if (editingId === id) resetEditor();
            notifySuccess('Item removido.');
        } catch (removeError: unknown) {
            setError(apiErrorMessage(removeError, 'Não foi possível remover o item.'));
        }
    };

    const editProgram = (item: BroadcastProgram) => {
        setEditingId(item.id);
        setProgramForm({ ...item, startAt: toDateTimeLocal(item.startAt), endAt: toDateTimeLocal(item.endAt) });
    };
    const editTicker = (item: BroadcastTickerItem) => {
        setEditingId(item.id);
        setTickerForm({ text: item.text, href: item.href, active: item.active });
    };
    const editPartner = (item: BroadcastPartner) => {
        setEditingId(item.id);
        setPartnerForm({ name: item.name, logoUrl: item.logoUrl, destinationUrl: item.destinationUrl, active: item.active });
    };

    if (loading) {
        return <div className="broadcast-admin-loading" role="status"><Loader2 className="spinner" size={28} /> Carregando central de broadcast…</div>;
    }

    return (
        <div className="broadcast-admin">
            <div className="broadcast-admin-hero">
                <div>
                    <span className="broadcast-admin-kicker"><RadioTower size={15} /> OPERAÇÃO EDITORIAL</span>
                    <h2>Campus ao Vivo</h2>
                    <p>Controle o sinal, a programação, os avisos e o ecossistema comercial em uma única tela.</p>
                </div>
                <div className="broadcast-admin-hero-actions">
                    <button type="button" onClick={() => void load()}><RefreshCw size={16} /> Atualizar</button>
                    <a href="/campus/ao-vivo" target="_blank" rel="noopener noreferrer">Abrir Campus <ExternalLink size={15} /></a>
                </div>
            </div>

            {error && <div className="broadcast-admin-alert error" role="alert">{error}<button type="button" onClick={() => setError('')} aria-label="Fechar"><X size={15} /></button></div>}
            {success && <div className="broadcast-admin-alert success" role="status">{success}</div>}

            <form className="broadcast-admin-settings" onSubmit={saveSettings}>
                <div className="broadcast-admin-section-heading">
                    <div><Settings2 size={19} /><span><strong>Identidade e fontes do sinal</strong><small>URLs HLS devem ser HTTPS em produção.</small></span></div>
                    <button type="submit" disabled={saving}>{saving ? <Loader2 className="spinner" size={16} /> : <Save size={16} />} Salvar configurações</button>
                </div>
                <div className="broadcast-admin-settings-grid">
                    <label>Título público<input value={settings.title} onChange={(event) => setSettings((current) => ({ ...current, title: event.target.value }))} required maxLength={120} /></label>
                    <label>Cor de destaque<input type="color" value={settings.accentColor} onChange={(event) => setSettings((current) => ({ ...current, accentColor: event.target.value }))} /></label>
                    <label className="wide">Descrição<textarea value={settings.description} onChange={(event) => setSettings((current) => ({ ...current, description: event.target.value }))} rows={2} maxLength={300} required /></label>
                    <label>Título ao vivo<input value={settings.liveTitle} onChange={(event) => setSettings((current) => ({ ...current, liveTitle: event.target.value }))} required /></label>
                    <label>Fonte do ao vivo principal
                        <select value={settings.liveSource} onChange={(event) => setSettings((current) => ({ ...current, liveSource: event.target.value as 'OBS' | 'YOUTUBE' }))}>
                            <option value="OBS">Servidor Local (OBS/RTMP)</option>
                            <option value="YOUTUBE">YouTube Live (Link externo)</option>
                        </select>
                    </label>
                    {settings.liveSource === 'OBS' ? (
                        <label>URL HLS ao vivo<input type="text" value={settings.liveUrl} readOnly aria-readonly="true" title="Rota gerenciada pela infraestrutura de broadcast" /></label>
                    ) : (
                        <label>URL da Live do YouTube<input type="text" value={settings.liveYoutubeUrl} onChange={(event) => setSettings((current) => ({ ...current, liveYoutubeUrl: event.target.value }))} placeholder="https://youtube.com/live/..." required /></label>
                    )}
                    <label>Título da programação<input value={settings.loopTitle} onChange={(event) => setSettings((current) => ({ ...current, loopTitle: event.target.value }))} required /></label>
                    <label>URL HLS contínua<input type="text" value={settings.loopUrl} readOnly aria-readonly="true" title="Rota gerenciada pela infraestrutura de broadcast" /></label>
                    <label>Poster do player<input type="text" pattern="https://.*|/uploads/images/.*" title="Use uma URL HTTPS ou um caminho /uploads/images/…" value={settings.posterUrl} onChange={(event) => setSettings((current) => ({ ...current, posterUrl: event.target.value }))} placeholder="https://… ou /uploads/images/…" /></label>
                    <label>Logo do Campus<input type="text" pattern="https://.*|/uploads/images/.*" title="Use uma URL HTTPS ou um caminho /uploads/images/…" value={settings.logoUrl} onChange={(event) => setSettings((current) => ({ ...current, logoUrl: event.target.value }))} placeholder="https://… ou /uploads/images/…" /></label>
                </div>
            </form>

            <section className="broadcast-admin-resources">
                <div className="broadcast-admin-tabs" role="tablist" aria-label="Recursos do broadcast">
                    <button type="button" role="tab" aria-selected={resourceTab === 'programs'} className={resourceTab === 'programs' ? 'active' : ''} onClick={() => { setResourceTab('programs'); resetEditor(); }}><CalendarClock size={16} /> Programação <span>{programs.length}</span></button>
                    <button type="button" role="tab" aria-selected={resourceTab === 'ticker'} className={resourceTab === 'ticker' ? 'active' : ''} onClick={() => { setResourceTab('ticker'); resetEditor(); }}><Megaphone size={16} /> Giro <span>{tickers.length}</span></button>
                    <button type="button" role="tab" aria-selected={resourceTab === 'partners'} className={resourceTab === 'partners' ? 'active' : ''} onClick={() => { setResourceTab('partners'); resetEditor(); }}><Handshake size={16} /> Parceiros <span>{partners.length}</span></button>
                </div>

                {resourceTab === 'programs' && (
                    <div className="broadcast-admin-resource-layout" role="tabpanel">
                        <form onSubmit={submitProgram} className="broadcast-admin-editor">
                            <div className="broadcast-admin-editor-title"><strong>{editingId ? 'Editar programa' : 'Novo programa'}</strong>{editingId && <button type="button" onClick={resetEditor}><X size={15} /> Cancelar</button>}</div>
                            <label>Título<input value={programForm.title} onChange={(event) => setProgramForm((current) => ({ ...current, title: event.target.value }))} required /></label>
                            <label>Descrição<textarea value={programForm.description} onChange={(event) => setProgramForm((current) => ({ ...current, description: event.target.value }))} rows={2} /></label>
                            <label>Categoria<input value={programForm.category} onChange={(event) => setProgramForm((current) => ({ ...current, category: event.target.value }))} /></label>
                            <div className="broadcast-admin-editor-columns"><label>Início<input type="datetime-local" value={programForm.startAt || ''} onChange={(event) => setProgramForm((current) => ({ ...current, startAt: event.target.value || null }))} /></label><label>Fim<input type="datetime-local" value={programForm.endAt || ''} onChange={(event) => setProgramForm((current) => ({ ...current, endAt: event.target.value || null }))} /></label></div>
                            <div className="broadcast-admin-form-group">
                                <label>URL do conteúdo
                                    <div className="broadcast-admin-upload-field">
                                        <input value={programForm.sourceUrl} onChange={(event) => setProgramForm((current) => ({ ...current, sourceUrl: event.target.value }))} placeholder="HLS, MP4 ou YouTube" required />
                                        <label className="broadcast-admin-btn-upload">
                                            <Upload size={14} /> Enviar vídeo
                                            <input type="file" accept="video/mp4,video/mkv,video/webm" onChange={async (e) => {
                                                if (!e.target.files?.length) return;
                                                const file = e.target.files[0];
                                                try {
                                                    setSaving(true);
                                                    const formData = new FormData();
                                                    formData.append('video', file);
                                                    const res = await api.post('/api/broadcast/upload-video', formData);
                                                    setProgramForm(current => ({ ...current, sourceUrl: res.data.url }));
                                                } catch {
                                                    alert('Erro no upload do vídeo');
                                                } finally {
                                                    setSaving(false);
                                                }
                                            }} style={{ display: 'none' }} />
                                        </label>
                                    </div>
                                </label>
                            </div>
                            <label>URL da capa<input type="text" pattern="https://.*|/uploads/images/.*" title="Use uma URL HTTPS ou um caminho /uploads/images/…" value={programForm.posterUrl} onChange={(event) => setProgramForm((current) => ({ ...current, posterUrl: event.target.value }))} placeholder="https://… ou /uploads/images/…" /></label>
                            <label className="broadcast-admin-check"><input type="checkbox" checked={programForm.active} onChange={(event) => setProgramForm((current) => ({ ...current, active: event.target.checked }))} /> Visível no Campus</label>
                            <button type="submit" className="broadcast-admin-save-resource" disabled={saving}>{editingId ? <Save size={16} /> : <Plus size={16} />}{editingId ? 'Salvar programa' : 'Adicionar programa'}</button>
                        </form>
                        <div className="broadcast-admin-list">
                            {programs.length ? programs.map((item) => <article key={item.id} className={!item.active ? 'inactive' : ''}><span className="broadcast-admin-resource-icon"><CalendarClock size={18} /></span><div><strong>{item.title}</strong><small>{item.category || 'Sem categoria'}{item.startAt ? ` · ${new Date(item.startAt).toLocaleString('pt-BR')}` : ''}</small></div><span className="broadcast-admin-status">{item.active ? 'ATIVO' : 'OCULTO'}</span><button type="button" onClick={() => editProgram(item)} aria-label={`Editar ${item.title}`}><Edit3 size={15} /></button><button type="button" className="danger" onClick={() => void removeResource('programs', item.id, item.title)} aria-label={`Remover ${item.title}`}><Trash2 size={15} /></button></article>) : <div className="broadcast-admin-empty">Nenhum programa cadastrado.</div>}
                        </div>
                    </div>
                )}

                {resourceTab === 'ticker' && (
                    <div className="broadcast-admin-resource-layout" role="tabpanel">
                        <form onSubmit={submitTicker} className="broadcast-admin-editor">
                            <div className="broadcast-admin-editor-title"><strong>{editingId ? 'Editar aviso' : 'Novo aviso'}</strong>{editingId && <button type="button" onClick={resetEditor}><X size={15} /> Cancelar</button>}</div>
                            <label>Texto<textarea value={tickerForm.text} onChange={(event) => setTickerForm((current) => ({ ...current, text: event.target.value }))} rows={3} required maxLength={300} /></label>
                            <label>Link opcional<input type="url" value={tickerForm.href} onChange={(event) => setTickerForm((current) => ({ ...current, href: event.target.value }))} placeholder="https://…" /></label>
                            <label className="broadcast-admin-check"><input type="checkbox" checked={tickerForm.active} onChange={(event) => setTickerForm((current) => ({ ...current, active: event.target.checked }))} /> Publicado</label>
                            <button type="submit" className="broadcast-admin-save-resource" disabled={saving}>{editingId ? <Save size={16} /> : <Plus size={16} />}{editingId ? 'Salvar aviso' : 'Publicar aviso'}</button>
                        </form>
                        <div className="broadcast-admin-list">
                            {tickers.length ? tickers.map((item) => <article key={item.id} className={!item.active ? 'inactive' : ''}><span className="broadcast-admin-resource-icon"><Megaphone size={18} /></span><div><strong>{item.text}</strong><small>{item.href || 'Sem link externo'}</small></div><span className="broadcast-admin-status">{item.active ? 'ATIVO' : 'OCULTO'}</span><button type="button" onClick={() => editTicker(item)} aria-label="Editar aviso"><Edit3 size={15} /></button><button type="button" className="danger" onClick={() => void removeResource('ticker', item.id, item.text)} aria-label="Remover aviso"><Trash2 size={15} /></button></article>) : <div className="broadcast-admin-empty">Nenhum aviso publicado.</div>}
                        </div>
                    </div>
                )}

                {resourceTab === 'partners' && (
                    <div className="broadcast-admin-resource-layout" role="tabpanel">
                        <form onSubmit={submitPartner} className="broadcast-admin-editor">
                            <div className="broadcast-admin-editor-title"><strong>{editingId ? 'Editar parceiro' : 'Novo parceiro'}</strong>{editingId && <button type="button" onClick={resetEditor}><X size={15} /> Cancelar</button>}</div>
                            <label>Nome<input value={partnerForm.name} onChange={(event) => setPartnerForm((current) => ({ ...current, name: event.target.value }))} required /></label>
                            <label>URL do logo<input type="text" pattern="https://.*|/uploads/images/.*" title="Use uma URL HTTPS ou um caminho /uploads/images/…" value={partnerForm.logoUrl} onChange={(event) => setPartnerForm((current) => ({ ...current, logoUrl: event.target.value }))} required /></label>
                            <label>Site do parceiro<input type="url" value={partnerForm.destinationUrl} onChange={(event) => setPartnerForm((current) => ({ ...current, destinationUrl: event.target.value }))} required /></label>
                            <label className="broadcast-admin-check"><input type="checkbox" checked={partnerForm.active} onChange={(event) => setPartnerForm((current) => ({ ...current, active: event.target.checked }))} /> Exibir no Campus</label>
                            <button type="submit" className="broadcast-admin-save-resource" disabled={saving}>{editingId ? <Save size={16} /> : <Plus size={16} />}{editingId ? 'Salvar parceiro' : 'Adicionar parceiro'}</button>
                        </form>
                        <div className="broadcast-admin-list">
                            {partners.length ? partners.map((item) => <article key={item.id} className={!item.active ? 'inactive' : ''}>{item.logoUrl ? <img src={item.logoUrl} alt="" /> : <span className="broadcast-admin-resource-icon"><Handshake size={18} /></span>}<div><strong>{item.name}</strong><small>{item.destinationUrl || 'Sem site externo'}</small></div><span className="broadcast-admin-status">{item.active ? 'ATIVO' : 'OCULTO'}</span><button type="button" onClick={() => editPartner(item)} aria-label={`Editar ${item.name}`}><Edit3 size={15} /></button><button type="button" className="danger" onClick={() => void removeResource('partners', item.id, item.name)} aria-label={`Remover ${item.name}`}><Trash2 size={15} /></button></article>) : <div className="broadcast-admin-empty">Nenhum parceiro cadastrado.</div>}
                        </div>
                    </div>
                )}
            </section>
        </div>
    );
}
