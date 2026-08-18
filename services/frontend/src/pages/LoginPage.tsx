import { useState, FormEvent, InputHTMLAttributes } from 'react';
import { ArrowRight, ShieldCheck, Eye, EyeOff } from 'lucide-react';
import QRCode from 'qrcode';
import { login, storeToken, storeRefreshToken, fetchMe, clearAuth } from '../services/auth';
import { AuthConfig } from '../services/oidc';
import { initPool, signIn, Step } from '../services/cognito';
import { User } from '../types';
import { CirciniLogo } from '../components/Brand';
import { Button, Field } from '../components/ui';

interface LoginPageProps {
  config: AuthConfig;
  onLogin: (user: User) => void;
}

type StepName = 'credentials' | 'newPassword' | 'mfaSetup' | 'totp';

/** Password input with a show/hide toggle. Manages its own reveal state. */
function PasswordInput({
  value,
  onChange,
  ...props
}: { value: string; onChange: (v: string) => void } & Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'value' | 'onChange' | 'type'
>) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input
        {...props}
        type={show ? 'text' : 'password'}
        className="field pr-11"
        value={value}
        onChange={e => onChange(e.target.value)}
      />
      <button
        type="button"
        onClick={() => setShow(s => !s)}
        tabIndex={-1}
        aria-label={show ? 'Hide password' : 'Show password'}
        className="absolute inset-y-0 right-0 flex items-center px-3 text-faint transition-colors hover:text-ink"
      >
        {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );
}

export default function LoginPage({ config, onLogin }: LoginPageProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Embedded Cognito flow state (oidc mode only)
  const [step, setStep] = useState<StepName>('credentials');
  const [pendingStep, setPendingStep] = useState<Step | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [code, setCode] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  const isOidc = config.mode === 'oidc' && !!config.oidc;

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

  /** Await the next Step of the Cognito flow and move the form to it. */
  const advance = async (promise: Promise<Step>) => {
    setBusy(true);
    setError(null);
    try {
      const next = await promise;
      if (next.kind === 'done') {
        // Credential material (chosen password, TOTP QR/secret) must not
        // outlive the step that needed it.
        setNewPassword('');
        setConfirmPassword('');
        setQrDataUrl(null);
        storeToken(next.idToken);
        storeRefreshToken(next.refreshToken);
        try {
          const me = await fetchMe();
          onLogin(me);
          return;
        } catch (err: any) {
          clearAuth();
          setStep('credentials');
          setPendingStep(null);
          setPassword('');
          setCode('');
          setError(
            err?.response?.data?.error ||
              'Signed in, but your account could not be loaded — please try again'
          );
          return;
        }
      }
      setPendingStep(next);
      setCode('');
      if (next.kind === 'newPasswordRequired') {
        setStep('newPassword');
      } else if (next.kind === 'totpRequired') {
        setStep('totp');
      } else {
        setQrDataUrl(await QRCode.toDataURL(next.otpauthUrl, { margin: 1, width: 192 }));
        setStep('mfaSetup');
      }
    } catch (err: any) {
      setError(err?.message || 'Sign-in failed — please try again');
    } finally {
      setBusy(false);
    }
  };

  const handleCognitoSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!config.oidc || busy) return;
    if (!email || !password) return;
    initPool(config.oidc);
    await advance(signIn(email.trim(), password));
  };

  const handleNewPasswordSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || pendingStep?.kind !== 'newPasswordRequired') return;
    if (newPassword.length < 12) {
      setError('New password must be at least 12 characters');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    await advance(pendingStep.complete(newPassword));
  };

  const handleMfaSetupSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || pendingStep?.kind !== 'mfaSetup') return;
    await advance(pendingStep.verify(code.trim()));
  };

  const handleTotpSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || pendingStep?.kind !== 'totpRequired') return;
    await advance(pendingStep.submit(code.trim()));
  };

  const subtitle = !isOidc
    ? 'Sign in with the credentials provisioned by your administrator.'
    : step === 'credentials'
      ? 'Sign in with your organization account.'
      : step === 'newPassword'
        ? 'Set a new password to continue.'
        : step === 'mfaSetup'
          ? 'Set up two-factor authentication to protect your account.'
          : 'Enter the code from your authenticator app.';

  const errorBox = error && (
    <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
      {error}
    </div>
  );

  const codeInput = (
    <Field label="6-digit code">
      <input
        type="text"
        required
        inputMode="numeric"
        pattern="[0-9]{6}"
        maxLength={6}
        autoComplete="one-time-code"
        className="field font-mono tracking-[0.3em]"
        placeholder="000000"
        value={code}
        onChange={e => setCode(e.target.value.replace(/[^0-9]/g, ''))}
        autoFocus
      />
    </Field>
  );

  const renderOidcForm = () => {
    switch (step) {
      case 'newPassword':
        return (
          <form onSubmit={handleNewPasswordSubmit} className="space-y-4">
            <Field label="New password" help="Minimum 12 characters">
              <PasswordInput
                required
                minLength={12}
                autoComplete="new-password"
                placeholder="••••••••••••"
                value={newPassword}
                onChange={setNewPassword}
                autoFocus
              />
            </Field>
            <Field label="Confirm new password">
              <PasswordInput
                required
                minLength={12}
                autoComplete="new-password"
                placeholder="••••••••••••"
                value={confirmPassword}
                onChange={setConfirmPassword}
              />
            </Field>

            {errorBox}

            <Button type="submit" variant="brass" loading={busy} className="w-full">
              Set password <ArrowRight className="h-4 w-4" />
            </Button>
          </form>
        );

      case 'mfaSetup':
        return (
          <form onSubmit={handleMfaSetupSubmit} className="space-y-4">
            <div className="flex flex-col items-center gap-3 rounded-lg border border-hairline bg-panel p-4">
              {qrDataUrl && (
                <img
                  src={qrDataUrl}
                  alt="Authenticator QR code"
                  className="h-44 w-44 rounded-lg bg-white p-2"
                />
              )}
              <p className="text-center text-xs text-muted">
                Scan with your authenticator app, or enter the key manually:
              </p>
              {pendingStep?.kind === 'mfaSetup' && (
                <div className="max-w-full select-all break-all rounded-md bg-elevated px-2.5 py-1.5 text-center font-mono text-[11px] text-ink">
                  {pendingStep.secret}
                </div>
              )}
            </div>

            {codeInput}

            {errorBox}

            <Button type="submit" variant="brass" loading={busy} className="w-full">
              Verify &amp; continue <ArrowRight className="h-4 w-4" />
            </Button>
          </form>
        );

      case 'totp':
        return (
          <form onSubmit={handleTotpSubmit} className="space-y-4">
            {codeInput}

            {errorBox}

            <Button type="submit" variant="brass" loading={busy} className="w-full">
              Verify code <ArrowRight className="h-4 w-4" />
            </Button>
          </form>
        );

      case 'credentials':
      default:
        return (
          <form onSubmit={handleCognitoSubmit} className="space-y-4">
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
              <PasswordInput
                required
                autoComplete="current-password"
                placeholder="••••••••••••"
                value={password}
                onChange={setPassword}
              />
            </Field>

            {errorBox}

            <Button type="submit" variant="brass" loading={busy} className="w-full">
              Sign in <ArrowRight className="h-4 w-4" />
            </Button>
          </form>
        );
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
            The control panel for&nbsp;
            <span className="text-brass-bright">data migrations</span>.
          </h1>
          <p className="mt-5 max-w-md text-[15px] leading-relaxed text-muted">
            Generate migration scripts, run them, and keep a full audit trail.
          </p>
          <div className="mt-8 flex flex-wrap gap-x-8 gap-y-3">
            {[
              ['Guided workflow', 'upload to generate'],
              ['Token budgets', 'set per user'],
              ['Full audit trail', 'every run logged'],
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
          <h2 className="mb-1 font-display text-xl font-700 text-ink">
            {isOidc && step === 'newPassword'
              ? 'Choose a new password'
              : isOidc && step === 'mfaSetup'
                ? 'Set up your authenticator'
                : isOidc && step === 'totp'
                  ? 'Two-factor authentication'
                  : 'Access the console'}
          </h2>
          <p className="mb-6 text-sm text-muted">{subtitle}</p>
          {isOidc ? (
            renderOidcForm()
          ) : (
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

              {errorBox}

              <Button type="submit" variant="brass" loading={busy} className="w-full">
                Sign in <ArrowRight className="h-4 w-4" />
              </Button>
            </form>
          )}
          <div className="mt-5 flex items-center gap-2 rounded-lg border border-hairline bg-panel px-3 py-2.5 text-xs text-muted">
            <ShieldCheck className="h-4 w-4 shrink-0 text-brass" />
            Access is provisioned by an administrator. All activity is audited.
          </div>
        </div>
      </div>
    </div>
  );
}
