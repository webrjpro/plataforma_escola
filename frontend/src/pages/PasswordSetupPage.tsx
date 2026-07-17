import { useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { Eye, EyeOff, KeyRound, Loader2, LockKeyhole, LogOut, ShieldCheck } from 'lucide-react';
import api from '../lib/api';
import { useAuth } from '../context/AuthContext';
import './PasswordSetupPage.css';

function homeFor(role: string): string {
    if (role === 'ADMIN' || role === 'TEACHER') return '/admin';
    if (role === 'STAFF') return '/school';
    if (role === 'GUARDIAN') return '/family';
    return '/student/dashboard';
}

export default function PasswordSetupPage() {
    const { user, login, logout } = useAuth();
    const navigate = useNavigate();
    const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
    const [show, setShow] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        setError('');
        if (form.newPassword !== form.confirmPassword) { setError('As novas senhas não coincidem.'); return; }
        if (form.newPassword === form.currentPassword) { setError('A nova senha precisa ser diferente da senha temporária.'); return; }
        setLoading(true);
        try {
            const response = await api.put('/api/auth/profile', { currentPassword: form.currentPassword, newPassword: form.newPassword });
            login(response.data.user);
            navigate(homeFor(response.data.user.role), { replace: true });
        } catch (requestError) {
            setError(axios.isAxiosError(requestError) ? requestError.response?.data?.message || 'Não foi possível atualizar a senha.' : 'Ocorreu um erro inesperado.');
        } finally { setLoading(false); }
    };

    return <div className="password-setup">
        <div className="password-security-note"><ShieldCheck size={18} /> Conexão protegida · sessão individual</div>
        <main className="password-card">
            <div className="password-icon"><LockKeyhole size={27} /></div>
            <span className="password-kicker">PRIMEIRO ACESSO</span>
            <h1>Proteja sua conta</h1>
            <p>Olá, {user?.name}. A senha recebida é temporária. Crie uma senha pessoal antes de continuar.</p>
            <form onSubmit={submit}>
                <label>Senha temporária<div><KeyRound size={17} /><input type={show ? 'text' : 'password'} required value={form.currentPassword} onChange={(event) => setForm((value) => ({ ...value, currentPassword: event.target.value }))} autoComplete="current-password" /></div></label>
                <label>Nova senha<div><KeyRound size={17} /><input type={show ? 'text' : 'password'} required minLength={8} maxLength={128} value={form.newPassword} onChange={(event) => setForm((value) => ({ ...value, newPassword: event.target.value }))} autoComplete="new-password" /></div></label>
                <label>Confirmar nova senha<div><KeyRound size={17} /><input type={show ? 'text' : 'password'} required minLength={8} maxLength={128} value={form.confirmPassword} onChange={(event) => setForm((value) => ({ ...value, confirmPassword: event.target.value }))} autoComplete="new-password" /></div></label>
                <button className="password-visibility" type="button" onClick={() => setShow((value) => !value)}>{show ? <EyeOff size={16} /> : <Eye size={16} />}{show ? 'Ocultar senhas' : 'Mostrar senhas'}</button>
                <div className="password-rules"><strong>Sua senha precisa ter:</strong><span>8 ou mais caracteres</span><span>letras maiúsculas e minúsculas</span><span>ao menos um número</span></div>
                {error && <div className="password-error">{error}</div>}
                <button className="password-submit" disabled={loading}>{loading ? <Loader2 className="spinner" size={17} /> : <ShieldCheck size={17} />} Salvar senha e continuar</button>
            </form>
            <button className="password-logout" type="button" onClick={logout}><LogOut size={16} /> Sair desta conta</button>
        </main>
    </div>;
}
