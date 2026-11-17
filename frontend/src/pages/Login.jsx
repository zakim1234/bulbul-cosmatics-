import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Mail, Lock, Eye, EyeOff } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { BUSINESS } from '../constants/business.js';
import logo from '../images/logo-mark.png';
import Spinner from '../components/ui/Spinner.jsx';

// How long the welcome screen stays after a successful sign-in.
const WELCOME_MS = 1800;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  // "Remember me": the email is kept on this device for next time.
  const [email, setEmail] = useState(() => { try { return localStorage.getItem('login_email') || ''; } catch { return ''; } });
  const [remember, setRemember] = useState(() => { try { return !!localStorage.getItem('login_email'); } catch { return false; } });
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [welcome, setWelcome] = useState(false); // the full-screen loading after Sign In
  const [showPassword, setShowPassword] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (!email.trim() || !password) {
      setError('Please enter both your email and password.');
      return;
    }
    setLoading(true);
    setWelcome(true);
    const started = Date.now();
    try {
      await login(email.trim(), password);
      try { if (remember) localStorage.setItem('login_email', email.trim()); else localStorage.removeItem('login_email'); } catch { /* storage blocked */ }
      await sleep(Math.max(0, WELCOME_MS - (Date.now() - started)));
      const redirectTo = location.state?.from || '/dashboard';
      navigate(redirectTo, { replace: true });
    } catch (err) {
      setWelcome(false);
      setError(err.friendlyMessage || 'Incorrect email or password.');
    } finally {
      setLoading(false);
    }
  };

  if (welcome) {
    return (
      <div className="busy-fade fixed inset-0 z-[95] flex flex-col items-center justify-center bg-white px-6 text-center" role="status" aria-live="polite">
        <span className="welcome-breathe flex h-24 w-24 items-center justify-center">
          <img src={logo} alt={BUSINESS.name} className="h-full w-full object-contain" />
        </span>
        <p className="mt-6 text-[26px] font-extrabold tracking-tight text-neutral-950" style={{ fontFamily: 'var(--font-display)' }}>
          {BUSINESS.name}
        </p>
        <p className="mt-1 text-[10.5px] font-semibold uppercase tracking-[0.24em] text-neutral-400">Inventory &amp; POS</p>
        <Spinner className="mt-10 h-14 w-14" />
        <p className="mt-5 text-sm font-medium text-neutral-500">Opening {BUSINESS.name}…</p>
        <div className="mt-4 h-1 w-44 overflow-hidden rounded-full bg-brand-100">
          <div className="welcome-progress h-full rounded-full bg-gradient-to-r from-brand-400 to-brand-600" style={{ animationDuration: `${WELCOME_MS}ms` }} />
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden px-4 py-10">
      {/* Blurred light in the system greens */}
      <div className="pointer-events-none absolute inset-0 bg-[#0f2a19]" />
      <div className="pointer-events-none absolute inset-0 blur-3xl">
        <span className="absolute -left-[10%] top-[5%] h-[55%] w-[55%] rounded-full bg-brand-600/70" />
        <span className="absolute right-[-5%] top-[-10%] h-[50%] w-[45%] rounded-full bg-brand-800/80" />
        <span className="absolute bottom-[-15%] left-[20%] h-[50%] w-[60%] rounded-full bg-brand-400/50" />
        <span className="absolute bottom-[5%] right-[5%] h-[35%] w-[30%] rounded-full bg-emerald-200/30" />
      </div>

      {/* Glass card */}
      <form
        onSubmit={handleSubmit}
        className="relative z-10 w-full max-w-sm rounded-[2rem] border border-white/20 bg-white/10 px-8 pb-9 pt-10 shadow-[0_30px_80px_-20px_rgba(0,0,0,0.6)] backdrop-blur-2xl"
      >
        {/* Round avatar with the logo */}
        <div className="mx-auto flex h-24 w-24 items-center justify-center rounded-full bg-white/20 ring-1 ring-white/30">
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-white/90 p-2.5">
            <img src={logo} alt={BUSINESS.name} className="h-full w-full object-contain" />
          </span>
        </div>
        <p className="mt-3 text-center text-sm font-semibold tracking-wide text-white/90" style={{ fontFamily: 'var(--font-display)' }}>{BUSINESS.name}</p>

        {error && <div className="mt-4 rounded-lg bg-red-500/25 px-3 py-2.5 text-center text-sm font-medium text-white ring-1 ring-red-200/40">{error}</div>}

        <label className="mt-8 flex items-center gap-3 rounded-xl border border-white bg-white px-4 py-3 shadow-sm transition focus-within:ring-2 focus-within:ring-brand-300/70">
          <Mail className="h-4 w-4 shrink-0 text-brand-700" />
          {/* Text, not type="email": people without an email yet still sign in with their old username. */}
          <input
            autoFocus={!email}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email ID"
            inputMode="email"
            autoCapitalize="none"
            autoComplete="username"
            className="login-input w-full border-0 bg-transparent p-0 text-[15px] text-neutral-900 placeholder-neutral-500 outline-none"
          />
        </label>

        <label className="mt-4 flex items-center gap-3 rounded-xl border border-white bg-white px-4 py-3 shadow-sm transition focus-within:ring-2 focus-within:ring-brand-300/70">
          <Lock className="h-4 w-4 shrink-0 text-brand-700" />
          <input
            autoFocus={!!email}
            type={showPassword ? 'text' : 'password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            autoComplete="current-password"
            className="login-input w-full border-0 bg-transparent p-0 text-[15px] text-neutral-900 placeholder-neutral-500 outline-none"
          />
          <button type="button" onClick={() => setShowPassword((v) => !v)} className="shrink-0 text-neutral-400 hover:text-brand-700" aria-label={showPassword ? 'Hide password' : 'Show password'}>
            {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </label>

        <div className="mt-5 flex items-center justify-between text-xs text-white/80">
          <label className="flex cursor-pointer items-center gap-2">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="h-3.5 w-3.5 accent-brand-500" />
            Remember me
          </label>
          <button type="button" onClick={() => setError('Forgot your password? Ask the Super Admin to set a new one for you.')} className="hover:text-white">
            Forgot Password?
          </button>
        </div>

        <button
          type="submit"
          disabled={loading}
          className="mt-8 w-full rounded-xl bg-gradient-to-r from-brand-700 via-brand-600 to-brand-400 py-3 text-sm font-bold uppercase tracking-[0.2em] text-white shadow-lg shadow-black/30 transition hover:brightness-110 disabled:opacity-70"
        >
          {loading ? 'Signing in…' : 'Login'}
        </button>
      </form>

      <p className="relative z-10 mt-6 text-xs text-white/60">© {new Date().getFullYear()} {BUSINESS.name} · {BUSINESS.addressLine}</p>
    </div>
  );
}
