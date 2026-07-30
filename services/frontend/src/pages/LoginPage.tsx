import { useState, FormEvent } from 'react';
import { ArrowRight, ShieldCheck } from 'lucide-react';
import { login } from '../services/auth';
import { User } from '../types';
import { CirciniLogo } from '../components/Brand';
import { Button, Field } from '../components/ui';

interface LoginPageProps {
  onLogin: (user: User) => void;
}

export default function LoginPage({ onLogin }: LoginPageProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email || !password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const user = await login(email.trim(), password);
      onLogin(user);
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Login failed — check your email and password');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-obsidian px-4">
      {/* ambient instrument backdrop */}
      <div className="console-grid pointer-events-none absolute inset-0 opacity-70" />
      <div className="pointer-events-none absolute -left-40 top-1/2 h-[520px] w-[520px] -translate-y-1/2 rounded-full bg-brass/[0.06] blur-[120px]" />
      <div className="pointer-events-none absolute -right-40 bottom-0 h-[420px] w-[420px] rounded-full bg-signal/[0.05] blur-[120px]" />

      <div className="relative grid w-full max-w-5xl gap-10 lg:grid-cols-[1.05fr_0.95fr] lg:items-center">
        {/* Left: identity / thesis */}
        <div className="hidden animate-fade-up flex-col justify-center lg:flex">
          <div className="mb-8 flex items-center gap-3">
            <CirciniLogo height={40} />
            <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-faint">
              Migration Agent
            </div>
          </div>
          <h1 className="font-display text-4xl font-700 leading-[1.08] tracking-tight text-ink text-balance">
            The instrument panel for your&nbsp;
            <span className="text-brass-bright">data migrations</span>.
          </h1>
          <p className="mt-5 max-w-md text-[15px] leading-relaxed text-muted">
            Upload mapping documents, generate governed migration scripts, and track every run —
            each execution logged, budgeted, and audited.
          </p>
          <div className="mt-8 flex flex-wrap gap-x-8 gap-y-3">
            {[
              ['Upload → Analyze → Generate', 'migration workflow'],
              ['Per-user token caps', 'no runaway spend'],
              ['Full audit trail', 'who ran what, when'],
            ].map(([a, b]) => (
              <div key={a}>
                <div className="font-mono text-[13px] font-500 text-ink">{a}</div>
                <div className="text-xs text-faint">{b}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Right: auth card */}
        <div className="panel-elevated animate-fade-up p-7 sm:p-8">
          <div className="mb-6 flex items-center lg:hidden">
            <CirciniLogo height={30} />
          </div>

          <div className="eyebrow mb-2">Secure sign-in</div>
          <h2 className="mb-1 font-display text-xl font-700 text-ink">Access the console</h2>
          <p className="mb-6 text-sm text-muted">
            Sign in with the credentials provisioned by your administrator.
          </p>
          <form onSubmit={handleSubmit} className="space-y-4">
            <Field label="Work email">
              <input
                type="email"
                required
                autoComplete="username"
                className="field"
                placeholder="you@circini.com"
                value={email}
                onChange={e => setEmail(e.target.value)}
              />
            </Field>
            <Field label="Password">
              <input
                type="password"
                required
                autoComplete="current-password"
                className="field"
                placeholder="••••••••••••"
                value={password}
                onChange={e => setPassword(e.target.value)}
              />
            </Field>

            {error && (
              <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
                {error}
              </div>
            )}

            <Button type="submit" variant="brass" loading={busy} className="w-full">
              Sign in <ArrowRight className="h-4 w-4" />
            </Button>
          </form>
          <div className="mt-5 flex items-center gap-2 rounded-lg border border-hairline bg-panel px-3 py-2.5 text-xs text-muted">
            <ShieldCheck className="h-4 w-4 shrink-0 text-brass" />
            Access is provisioned by an administrator. All activity is audited.
          </div>
        </div>
      </div>
    </div>
  );
}
