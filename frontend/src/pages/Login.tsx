/**
 * Login.tsx — Tela de Autenticação Institucional
 *
 * Aceita login por username OU e-mail + senha
 * Após autenticar com sucesso:
 *   - ADMIN/TEACHER → redireciona para /admin
 *   - STUDENT       → redireciona para /student/dashboard
 *
 * Usa Framer Motion para animação de entrada do card de login
 * Dados: POST /api/auth/login (autenticação real no banco PostgreSQL)
 */
import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useConfig } from '../context/ConfigContext';
import { useNavigate } from 'react-router-dom';
import { Lock, User, Loader2, ShieldCheck } from 'lucide-react';
import { motion } from 'framer-motion';
import axios from 'axios';
import api from '../lib/api';
import { resolveMediaUrl } from '../lib/urls';

export default function Login() {
    const [login, setLogin] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const { login: doLogin } = useAuth();
    const { config } = useConfig();
    const navigate = useNavigate();

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        setLoading(true);

        try {
            const response = await api.post('/api/auth/login', { login, password });
            doLogin(response.data.user);

            if (response.data.user.role === 'ADMIN' || response.data.user.role === 'TEACHER') {
                navigate('/admin');
            } else if (response.data.user.role === 'STAFF') {
                navigate('/school');
            } else if (response.data.user.role === 'GUARDIAN') {
                navigate('/family');
            } else {
                navigate('/student/dashboard');
            }
        } catch (err: unknown) {
            if (axios.isAxiosError(err)) {
                setError(err.response?.data?.message || 'Erro ao conectar no servidor.');
            } else {
                setError('Erro desconhecido');
            }
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="login-container">
            <div className="login-bg-overlay"></div>

            <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5 }}
                className="login-card"
            >
                <div className="login-header">
                    {config.logoUrl ? (
                        <img src={resolveMediaUrl(config.logoUrl)} alt={config.platformName} className="login-logo-img" />
                    ) : (
                        <ShieldCheck size={48} className="logo-icon" />
                    )}
                    <h1>{config.platformName}</h1>
                    <p>Acesso Restrito Institucional</p>
                </div>

                <form onSubmit={handleLogin} className="login-form">
                    {error && <div className="error-message">{error}</div>}

                    <div className="input-group">
                        <User size={20} className="input-icon" />
                        <input
                            type="text"
                            placeholder="Usuário ou E-mail"
                            value={login}
                            onChange={(e) => setLogin(e.target.value)}
                            required
                        />
                    </div>

                    <div className="input-group">
                        <Lock size={20} className="input-icon" />
                        <input
                            type="password"
                            placeholder="Senha de Acesso"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            required
                        />
                    </div>

                    <button type="submit" className="login-button" disabled={loading}>
                        {loading ? <Loader2 className="spinner" /> : 'Entrar na Plataforma'}
                    </button>
                </form>

                <div className="login-footer">
                    <p>Ambiente Seguro - Sistema de Ensino</p>
                    <small>Desenvolvido para Carlos Piquet Projetos</small>
                </div>
            </motion.div>
        </div>
    );
}
