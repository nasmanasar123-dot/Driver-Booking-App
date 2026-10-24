import { useEffect, useRef, useSyncExternalStore } from 'react';
import { io } from 'socket.io-client';

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// localStorage can throw (private mode, blocked storage); the app still works, just without staying signed in.
const storage = {
  get: (key: string) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set: (key: string, value: string | null) => {
    try {
      if (value) localStorage.setItem(key, value);
      else localStorage.removeItem(key);
    } catch {}
  },
};

// All apps call the API at /api on their own origin (Vite proxies it in dev, Caddy in production).
export function createApi(storageKey: string) {
  let token = storage.get(storageKey);
  const listeners = new Set<() => void>();

  function setToken(next: string | null) {
    token = next;
    storage.set(storageKey, next);
    listeners.forEach((l) => l());
  }

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(`/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    if (res.status === 401 && token) setToken(null);
    if (!res.ok) throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`);
    return data as T;
  }

  return {
    get: <T>(path: string) => request<T>('GET', path),
    post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
    put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
    patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
    del: <T>(path: string) => request<T>('DELETE', path),
    getToken: () => token,
    setToken,
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
  };
}

export type Api = ReturnType<typeof createApi>;

export const useToken = (api: Api) => useSyncExternalStore(api.subscribe, api.getToken);

// Live server pushes. Handlers can change every render; the socket only reconnects when the token does.
// A 'connect' handler is a good place to refetch, since events sent while disconnected are lost.
export function useSocket(api: Api, handlers: Record<string, (data: any) => void>) {
  const token = useToken(api);
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    if (!token) return;
    const socket = io({ auth: { token } });
    socket.onAny((event, data) => ref.current[event]?.(data));
    socket.on('connect', () => ref.current.connect?.(null));
    return () => void socket.disconnect();
  }, [token]);
}
