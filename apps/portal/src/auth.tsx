import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { HubUser } from '@tm-hub/shared';
import { api, setCsrf, setUnauthorizedHandler, type HubConfig } from './api.ts';
import { Loading, ErrorBox } from './ui/common.tsx';

interface AuthState {
  user: HubUser | null;
  config: HubConfig;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}
const Ctx = createContext<AuthState | null>(null);
export const useAuth = () => {
  const c = useContext(Ctx);
  if (!c) throw new Error('AuthProvider missing');
  return c;
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<HubUser | null>(null);
  const [config, setConfig] = useState<HubConfig | null>(null);
  const [error, setError] = useState<unknown>(null);

  const refresh = useCallback(async () => {
    const [cfg, me] = await Promise.all([api.config(), api.me()]);
    setCsrf(me.csrf);
    setConfig(cfg);
    setUser(me.user);
  }, []);

  useEffect(() => {
    refresh().catch(setError);
  }, [refresh]);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setUser(null);
      const here = location.pathname + location.search;
      if (!location.pathname.startsWith('/login') && !location.pathname.startsWith('/p/') && !location.pathname.startsWith('/legal')) {
        location.assign(`/login?next=${encodeURIComponent(here)}`);
      }
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  const logout = useCallback(async () => {
    await api.logout();
    await refresh();
  }, [refresh]);

  if (error) return <div className="page narrow"><ErrorBox error={error} retry={() => { setError(null); refresh().catch(setError); }} /></div>;
  if (!config) return <Loading text="Connecting" />;
  return <Ctx.Provider value={{ user, config, refresh, logout }}>{children}</Ctx.Provider>;
}
