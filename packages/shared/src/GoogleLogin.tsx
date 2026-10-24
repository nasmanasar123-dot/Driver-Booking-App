import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Api } from './api.ts';
import type { Role, User } from './types.ts';

type Props = { api: Api; app: Role; title: string; subtitle: string };
type AuthConfig = { googleClientId: string | null; devLogin: boolean };

const GSI_SRC = 'https://accounts.google.com/gsi/client';

export function GoogleLogin({ api, app, title, subtitle }: Props) {
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get<AuthConfig>('/auth/config').then(setConfig, () => setError("Can't reach the server. Is the API running?"));
  }, [api]);

  const signIn = async (path: string, body: object) => {
    setError('');
    try {
      const res = await api.post<{ token: string; user: User }>(path, { ...body, app });
      api.setToken(res.token);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <main className="page narrow">
      <div className="brand">
        <h1>{title}</h1>
        <p className="muted">{subtitle}</p>
      </div>
      <div className="card stack" style={{ justifyItems: 'center' }}>
        {config?.googleClientId && (
          <GoogleButton clientId={config.googleClientId} onCredential={(idToken) => signIn('/auth/google', { idToken })} />
        )}
        {config && !config.googleClientId && (
          <p className="muted small">Google sign-in isn't set up yet: add GOOGLE_CLIENT_ID to apps/api/.env and restart the API.</p>
        )}
        {config?.devLogin && <DevLogin onSubmit={(email) => signIn('/auth/dev', { email })} />}
        {error && <p className="error">{error}</p>}
      </div>
    </main>
  );
}

function GoogleButton({ clientId, onCredential }: { clientId: string; onCredential: (idToken: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const callback = useRef(onCredential);
  callback.current = onCredential;

  useEffect(() => {
    const render = () => {
      const google = (window as any).google;
      google.accounts.id.initialize({ client_id: clientId, callback: (r: { credential: string }) => callback.current(r.credential) });
      google.accounts.id.renderButton(ref.current, { theme: 'outline', size: 'large', text: 'continue_with', width: 280 });
    };
    if ((window as any).google?.accounts) return render();
    let script = document.querySelector<HTMLScriptElement>(`script[src="${GSI_SRC}"]`);
    if (!script) {
      script = document.createElement('script');
      script.src = GSI_SRC;
      script.async = true;
      document.head.appendChild(script);
    }
    script.addEventListener('load', render);
    return () => script.removeEventListener('load', render);
  }, [clientId]);

  return <div ref={ref} style={{ minHeight: 44 }} />;
}

function DevLogin({ onSubmit }: { onSubmit: (email: string) => void }) {
  const [email, setEmail] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit(email);
  };
  return (
    <form className="stack" onSubmit={submit} style={{ width: '100%', borderTop: '1px dashed var(--border)', paddingTop: 12 }}>
      <span className="muted small">Development sign-in: any email, no password. Turned off in production.</span>
      <div className="row">
        <input className="grow" type="email" placeholder="test-driver@example.com" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <button className="btn">Sign in</button>
      </div>
    </form>
  );
}
