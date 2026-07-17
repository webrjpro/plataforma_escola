/**
 * ProtectedRoute.tsx — Guard de Rotas por Autenticação e Role
 *
 * Comportamento:
 * - Sem sessão autenticada: redireciona para /login
 * - Com sessão mas role não autorizada: redireciona para o dashboard correto
 *   (STUDENT → /student/dashboard, ADMIN → /admin)
 * - Com sessão e role autorizada: renderiza o Outlet (rota filha)
 * - Exibe spinner durante validação da sessão (isLoading)
 */
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Loader2 } from 'lucide-react';

// ISSUE-13: Redireciona para dashboard adequado ao invés de login quando role não autorizada
export const ProtectedRoute = ({ allowedRoles }: { allowedRoles?: string[] }) => {
    const { user, isLoading } = useAuth();
    const location = useLocation();

    if (isLoading) {
        return (
            <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Loader2 className="spinner" size={48} color="#6366f1" />
            </div>
        );
    }

    if (!user) {
        return <Navigate to="/login" replace />;
    }

    if (user.mustChangePassword && location.pathname !== '/account/security') {
        return <Navigate to="/account/security" replace />;
    }

    if (allowedRoles && !allowedRoles.includes(user.role)) {
        // Redirecionar para o dashboard correto baseado no role
        if (user.role === 'STUDENT') {
            return <Navigate to="/student/dashboard" replace />;
        }
        if (user.role === 'ADMIN' || user.role === 'TEACHER') {
            return <Navigate to="/admin" replace />;
        }
        if (user.role === 'STAFF') return <Navigate to="/school" replace />;
        if (user.role === 'GUARDIAN') return <Navigate to="/family" replace />;
        return <Navigate to="/" replace />;
    }

    return <Outlet />;
};
