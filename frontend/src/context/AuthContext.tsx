import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, clearToken, getToken, setToken } from "../api/client";
import { connectAddress, signMessage } from "../auth/wallet";

export interface User {
  id: string;
  address: string;
  isAdmin: boolean;
  jurorStatus: string;
}

interface AuthState {
  user: User | null;
  loading: boolean;
  connecting: boolean;
  login: () => Promise<void>;
  logout: () => void;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    if (!getToken()) {
      setLoading(false);
      return;
    }
    api
      .get<User>("/me")
      .then(setUser)
      .catch(() => clearToken())
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async () => {
    setConnecting(true);
    try {
      const address = await connectAddress();
      const challenge = await api.post<{ message: string; nonce: string }>("/auth/challenge", {
        address
      });
      const signature = await signMessage(address, challenge.message);
      const result = await api.post<{ token: string; user: User }>("/auth/verify", {
        address,
        signature
      });
      setToken(result.token);
      setUser(result.user);
    } finally {
      setConnecting(false);
    }
  }, []);

  const logout = useCallback(() => {
    clearToken();
    setUser(null);
  }, []);

  return <Ctx.Provider value={{ user, loading, connecting, login, logout }}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}
