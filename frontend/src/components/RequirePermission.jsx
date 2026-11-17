import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { hasPermission, PERMISSION_MODULES } from '../constants/permissions.js';

// Frontend hiding is a UX convenience, not the security boundary -- the
// backend's requirePermission middleware re-checks every request
// regardless of what this renders. This exists so a direct URL visit
// (typed, bookmarked, or reached after a permission was revoked) shows a
// clear message instead of a broken/empty page or a raw 403 from the API.
export default function RequirePermission({ module, adminOnly, roles, superAdmin, children }) {
  const { user } = useAuth();

  const allowed = superAdmin ? !!user?.isSuperAdmin : roles ? roles.includes(user?.role) : adminOnly ? user?.role === 'admin' : [].concat(module).some((m) => hasPermission(user, m));
  // No permission: say so (and why), instead of jumping back to the
  // dashboard without a word.
  if (!allowed) {
    const first = [].concat(module)[0];
    const label = PERMISSION_MODULES.find((m) => m.key === first)?.label || first;
    const why = superAdmin
      ? 'Only the Super Admin can open this page.'
      : roles
        ? `This page is for: ${roles.join(', ')}.`
        : adminOnly
          ? 'Only an admin can open this page.'
          : `Your user does not have the "${label}" permission. The Super Admin can switch it on in Users.`;
    return (
      <div className="mx-auto mt-16 max-w-md rounded-2xl border border-amber-200 bg-amber-50 p-6 text-center">
        <p className="text-lg font-bold text-neutral-900">You cannot open this page</p>
        <p className="mt-2 text-sm text-neutral-700">{why}</p>
        <p className="mt-1 text-xs text-neutral-500">Signed in as {user?.name || user?.email}{user?.isSuperAdmin ? ' (Super Admin)' : ` (${user?.role})`}</p>
        <Link to="/dashboard" className="mt-4 inline-block rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white">Back to dashboard</Link>
      </div>
    );
  }

  return children;
}
