/**
 * AuthContext.tsx — Estado Global de Autenticação (React Context)
 *
 * Provê para toda a aplicação:
 * - user: dados do usuario logado (id, name, email, role)
 * - login(): atualiza o usuário autenticado em memória
 * - logout(): limpa o estado e encerra a sessão no servidor
 * - isLoading: true enquanto valida a sessão HttpOnly via GET /api/auth/me
 *
 * Persistência: cookie HttpOnly/SameSite validado em GET /api/auth/me
 */
import { createContext, useContext, useState, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import api from '../lib/api';

// types
export interface User {
    id: string;
    username?: string;
    name: string;
    email: string;
    role: 'ADMIN' | 'TEACHER' | 'STUDENT' | 'STAFF' | 'GUARDIAN';
    mustChangePassword?: boolean;
    passwordChangedAt?: string | null;
}

interface AuthContextType {
    user: User | null;
    login: (user: User) => void;
    logout: () => void;
    isLoading: boolean;
}

const AuthContext = createContext<AuthContextType>({
    user: null,
    login: () => { },
    logout: () => { },
    isLoading: true
});

export const AuthProvider = ({ children }: { children: ReactNode }) => {
    const [user, setUser] = useState<User | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const hasCheckedRef = useRef(false);

    useEffect(() => {
        if (hasCheckedRef.current) return;
        hasCheckedRef.current = true;

        localStorage.removeItem('eduvault_token');
        api.get('/api/auth/me')
            .then(response => {
                setUser(response.data);
            })
            .catch(() => {
                setUser(null);
            })
            .finally(() => {
                setIsLoading(false);
            });
    }, []);

    useEffect(() => {
        const expire = () => {
            setUser(null);
        };
        window.addEventListener('eduvault:session-expired', expire);
        return () => window.removeEventListener('eduvault:session-expired', expire);
    }, []);

    const login = (newUser: User) => {
        setUser(newUser);
    };

    const logout = () => {
        void api.post('/api/auth/logout').catch(() => undefined);
        setUser(null);
    };

    return (
        <AuthContext.Provider value={{ user, login, logout, isLoading }}>
            {children}
        </AuthContext.Provider>
    );
};

export const useAuth = () => useContext(AuthContext);
