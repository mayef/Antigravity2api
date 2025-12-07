import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';

interface AuthContextType {
    token: string;
    isAuthenticated: boolean;
    isLoading: boolean;
    login: (password: string) => Promise<{ success: boolean; error?: string }>;
    logout: () => Promise<void>;
    refreshSession: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
    const [token, setToken] = useState(localStorage.getItem('adminToken') || '');
    const [isAuthenticated, setIsAuthenticated] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const [lastRefreshTime, setLastRefreshTime] = useState(Date.now());

    const logout = useCallback(async () => {
        try {
            await fetch('/admin/logout', {
                method: 'POST',
                headers: { 'X-Admin-Token': token }
            });
        } catch {
            // Ignore logout errors
        }
        setToken('');
        localStorage.removeItem('adminToken');
        setIsAuthenticated(false);
    }, [token]);

    const verifySession = useCallback(async () => {
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
    }, [token, logout]);

    useEffect(() => {
        verifySession();
    }, [verifySession]);

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
                setLastRefreshTime(Date.now());
                return { success: true };
            } else {
                return { success: false, error: data.error || 'Login failed' };
            }
        } catch (error) {
            return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
        }
    };

    const refreshSession = useCallback(async () => {
        if (!token) return;

        try {
            const response = await fetch('/admin/session/regenerate', {
                method: 'POST',
                headers: { 'X-Admin-Token': token }
            });

            if (response.ok) {
                const data = await response.json();
                if (data.success && data.token) {
                    setToken(data.token);
                    localStorage.setItem('adminToken', data.token);
                    setLastRefreshTime(Date.now());
                }
            } else if (response.status === 401) {
                // 认证失败,登出
                await logout();
            }
            // 对于其他错误(网络错误等),不做处理,继续使用当前token
        } catch (error) {
            // 网络错误不应立即登出,只记录错误
            console.error('会话刷新失败:', error);
        }
    }, [token, logout]);

    // 自动刷新机制 - 每15分钟刷新一次
    useEffect(() => {
        if (!isAuthenticated) return;

        const refreshInterval = 15 * 60 * 1000; // 15分钟
        const intervalId = setInterval(() => {
            refreshSession();
        }, refreshInterval);

        return () => clearInterval(intervalId);
    }, [isAuthenticated, refreshSession]);

    // 页面可见性变化监听 - 页面重新可见时检查是否需要刷新
    useEffect(() => {
        if (!isAuthenticated) return;

        const handleVisibilityChange = () => {
            if (document.visibilityState === 'visible') {
                const timeSinceLastRefresh = Date.now() - lastRefreshTime;
                const refreshThreshold = 15 * 60 * 1000; // 15分钟
                
                // 如果距离上次刷新超过15分钟,立即刷新
                if (timeSinceLastRefresh > refreshThreshold) {
                    refreshSession();
                }
            }
        };

        document.addEventListener('visibilitychange', handleVisibilityChange);
        return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
    }, [isAuthenticated, lastRefreshTime, refreshSession]);

    return (
        <AuthContext.Provider value={{ token, isAuthenticated, isLoading, login, logout, refreshSession }}>
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
