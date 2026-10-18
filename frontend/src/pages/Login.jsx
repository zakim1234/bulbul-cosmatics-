import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import Button from '../components/ui/Button.jsx';
import { Input, Label } from '../components/ui/Field.jsx';
import { BUSINESS } from '../constants/business.js';
import logo from '../images/logo.svg';

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (!username.trim() || !password) {
      setError('Please enter both username and password.');
      return;
    }
    setLoading(true);
    try {
      await login(username.trim(), password);
      const redirectTo = location.state?.from || '/dashboard';
      navigate(redirectTo, { replace: true });
    } catch (err) {
      setError(err.friendlyMessage || 'Incorrect username or password.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen">
      {/* Brand panel */}
      <div className="bg-bulbul relative hidden flex-1 flex-col justify-between overflow-hidden p-12 text-white lg:flex">
        <div className="pointer-events-none absolute -right-24 top-1/4 h-96 w-96 rounded-full border border-gold-300/20" />
        <div className="pointer-events-none absolute -right-10 top-1/3 h-64 w-64 rounded-full border border-gold-300/15" />
        <div className="pointer-events-none absolute -bottom-32 -left-20 h-96 w-96 rounded-full bg-brand-500/20 blur-3xl" />

        <div className="relative flex items-center gap-3">
          <img src={logo} alt="" className="h-11 w-11" />
          <p className="font-display text-lg font-semibold">
            Bulbul <span className="text-gold-shine">Cosmetics</span>
          </p>
        </div>

        <div className="relative max-w-md">
          <img src={logo} alt={BUSINESS.name} className="mb-8 h-40 w-40 drop-shadow-[0_20px_40px_rgba(224,72,137,0.45)]" />
          <h1 className="text-5xl font-semibold leading-[1.1]">
            Where beauty
            <br />
            <span className="text-gold-shine italic">meets business.</span>
          </h1>
          <p className="mt-5 text-base leading-relaxed text-white/70">
            Run every counter, shelf and sale of {BUSINESS.name} from one elegant place: stock, sales, purchases and reports.
          </p>
        </div>

        <p className="relative text-xs uppercase tracking-[0.3em] text-white/40">{BUSINESS.addressLine}</p>
      </div>

      {/* Sign-in form */}
      <div className="flex w-full flex-col items-center justify-center px-6 py-12 lg:w-[480px] lg:shrink-0 lg:bg-white">
        <div className="w-full max-w-sm">
          <div className="mb-8 text-center lg:text-left">
            <img src={logo} alt={BUSINESS.name} className="mx-auto mb-4 h-24 w-24 drop-shadow-[0_10px_24px_rgba(201,41,109,0.35)] lg:hidden" />
            <p className="text-xs font-semibold uppercase tracking-[0.3em] text-gold-500">Welcome back</p>
            <h2 className="mt-2 text-3xl font-semibold text-brand-950">Sign in to {BUSINESS.name}</h2>
            <p className="mt-2 text-sm text-slate-500">Manage your beauty store's inventory, sales and reports.</p>
          </div>

          <form onSubmit={handleSubmit} className="rounded-3xl border border-brand-100 bg-white/90 p-7 shadow-[0_20px_50px_-20px_rgba(90,20,70,0.3)] backdrop-blur lg:border-0 lg:p-0 lg:shadow-none">
            {error && (
              <div className="mb-4 rounded-xl bg-rose-50 px-3.5 py-2.5 text-sm font-medium text-rose-700 ring-1 ring-rose-100">
                {error}
              </div>
            )}

            <div className="mb-4">
              <Label>Username</Label>
              <Input
                autoFocus
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="admin"
                autoComplete="username"
              />
            </div>

            <div className="mb-6">
              <Label>Password</Label>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="current-password"
              />
            </div>

            <Button type="submit" size="lg" className="w-full py-3" loading={loading}>
              Sign In
            </Button>
          </form>

          <p className="mt-8 text-center text-xs text-slate-400">© {new Date().getFullYear()} {BUSINESS.name}</p>
        </div>
      </div>
    </div>
  );
}
