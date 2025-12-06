import { createContext, useContext, useState, useEffect, ReactNode } from 'react';

interface AuthContextType {
    token: string;
    isAuthenticated: boolean;
    isLoading: boolean;
    login: (password: string) => Promise<{ success: boolean; error?: string }>;
    logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
    const [token, setToken] = useState(localStorage.getItem('adminToken') || '');
    const [isAuthenticated, setIsAuthenticated] = useState(false);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        verifySession();
    }, [token]);

    const verifySession = async () => {
        if (!token) {
            setIsAuthenticated(false);
            setIsLoading(false);
            return;
        }

        try {
            const response = await fetch('/admin/verify', {
                headers: { 'X-Admin-Token': token }
            });

            if (response.ok) {
                setIsAuthenticated(true);
            } else {
                logout();
            }
        } catch (error) {
            console.error('Session verification failed:', error);
            setIsAuthenticated(false); // Don't logout immediately on network error, but for now safe
        } finally {
            setIsLoading(false);
        }
    };

    const login = async (password: string) => {
        try {
            const response = await fetch('/admin/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password })
            });

            const data = await response.json();

            if (response.ok && data.success) {
                setToken(data.token);
                localStorage.setItem('adminToken', data.token);
                setIsAuthenticated(true);
                return { success: true };
            } else {
                return { success: false, error: data.error || 'Login failed' };
            }
        } catch (error) {
            return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
        }
    };

    const logout = async () => {
        try {
            await fetch('/admin/logout', {
                method: 'POST',
                headers: { 'X-Admin-Token': token }
            });
        } catch (e) {
            // Ignore logout errors
        }
        setToken('');
        localStorage.removeItem('adminToken');
        setIsAuthenticated(false);
    };

    return (
        <AuthContext.Provider value={{ token, isAuthenticated, isLoading, login, logout }}>
            {children}
        </AuthContext.Provider>
    );
}

export const useAuth = () => {
    const context = useContext(AuthContext);
    if (!context) {
        throw new Error('useAuth must be used within AuthProvider');
    }
    return context;
};
