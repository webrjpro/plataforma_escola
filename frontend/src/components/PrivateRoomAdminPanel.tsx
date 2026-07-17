import { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import { Plus, Edit3, Trash2, X, Save, Lock, Link as LinkIcon, Loader2 } from 'lucide-react';
import api from '../lib/api';
import './PrivateRoomAdminPanel.css';

interface PrivateRoom {
    id: string;
    title: string;
    description: string | null;
    slug: string;
    password?: string;
    videoUrl: string;
    active: boolean;
    createdAt: string;
}

export default function PrivateRoomAdminPanel() {
    const [rooms, setRooms] = useState<PrivateRoom[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    const [form, setForm] = useState<Partial<PrivateRoom>>({});
    const [editingId, setEditingId] = useState<string | null>(null);
    const [showForm, setShowForm] = useState(false);

    const loadRooms = useCallback(async () => {
        try {
            setLoading(true);
            const res = await api.get('/api/admin/private-rooms');
            setRooms(res.data);
        } catch (err) {
            console.error(err);
            alert('Erro ao carregar salas privadas');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void loadRooms();
    }, [loadRooms]);

    const handleEdit = (room: PrivateRoom) => {
        setForm(room);
        setEditingId(room.id);
        setShowForm(true);
    };

    const handleDelete = async (id: string) => {
        if (!window.confirm('Tem certeza que deseja remover esta sala?')) return;
        try {
            await api.delete(`/api/admin/private-rooms/${id}`);
            setRooms(r => r.filter(x => x.id !== id));
        } catch {
            alert('Erro ao excluir');
        }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        try {
            setSaving(true);
            if (editingId) {
                const res = await api.put(`/api/admin/private-rooms/${editingId}`, form);
                setRooms(r => r.map(x => x.id === editingId ? res.data : x));
            } else {
                const res = await api.post('/api/admin/private-rooms', form);
                setRooms([res.data, ...rooms]);
            }

            setShowForm(false);
            setEditingId(null);
            setForm({});
        } catch (error: unknown) {
            alert(axios.isAxiosError<{ error?: string }>(error)
                ? error.response?.data?.error || 'Erro ao salvar sala'
                : 'Erro ao salvar sala');
        } finally {
            setSaving(false);
        }
    };

    if (loading) return <div style={{ display: 'flex', justifyContent: 'center', padding: '2rem' }}><Loader2 className="spinner" /></div>;

    return (
        <div className="private-room-admin">
            <div className="private-room-header">
                <h2>Salas Privadas (Masterclasses)</h2>
                {!showForm && (
                    <button className="primary-btn" onClick={() => { setForm({ active: true }); setEditingId(null); setShowForm(true); }}>
                        <Plus size={16} /> Nova Sala
                    </button>
                )}
            </div>

            {showForm && (
                <form onSubmit={handleSubmit} className="private-room-form box-card">
                    <div className="form-title">
                        <h3>{editingId ? 'Editar Sala' : 'Criar Sala Privada'}</h3>
                        <button type="button" onClick={() => setShowForm(false)} className="close-btn"><X size={16} /></button>
                    </div>

                    <div className="form-grid">
                        <label>
                            Título
                            <input value={form.title || ''} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} required />
                        </label>
                        <label>
                            Slug (URL Ex: /sala/minha-sala)
                            <input value={form.slug || ''} onChange={e => setForm(f => ({ ...f, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') }))} required />
                        </label>
                        <label>
                            {editingId ? 'Nova senha (opcional)' : 'Senha de acesso'}
                            <input type="password" minLength={10} maxLength={128} autoComplete="new-password" value={form.password || ''} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} required={!editingId} />
                        </label>
                        <label>
                            URL do Vídeo (HLS, MP4, YouTube)
                            <input type="url" value={form.videoUrl || ''} onChange={e => setForm(f => ({ ...f, videoUrl: e.target.value }))} required />
                        </label>
                        <label className="full-width">
                            Descrição Opcional
                            <textarea value={form.description || ''} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} rows={2} />
                        </label>
                        <label className="checkbox-label">
                            <input type="checkbox" checked={form.active ?? true} onChange={e => setForm(f => ({ ...f, active: e.target.checked }))} />
                            Sala Ativa
                        </label>
                    </div>

                    <div className="form-actions">
                        <button type="button" onClick={() => setShowForm(false)}>Cancelar</button>
                        <button type="submit" disabled={saving} className="primary-btn">
                            {saving ? <Loader2 className="spinner" size={16} /> : <Save size={16} />} Salvar
                        </button>
                    </div>
                </form>
            )}

            <div className="private-room-list">
                {rooms.map(room => (
                    <div key={room.id} className={`room-card ${!room.active ? 'inactive' : ''}`}>
                        <div className="room-info">
                            <h4>{room.title}</h4>
                            <div className="room-meta">
                                <span><LinkIcon size={14} /> /sala/{room.slug}</span>
                                <span><Lock size={14} /> Segredo protegido</span>
                            </div>
                        </div>
                        <div className="room-actions">
                            <button onClick={() => handleEdit(room)} title="Editar"><Edit3 size={16} /></button>
                            <button onClick={() => handleDelete(room.id)} title="Excluir" className="danger"><Trash2 size={16} /></button>
                        </div>
                    </div>
                ))}
                {rooms.length === 0 && !showForm && (
                    <div className="empty-state">Nenhuma sala privada criada.</div>
                )}
            </div>
        </div>
    );
}
