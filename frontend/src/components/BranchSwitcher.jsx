import { useEffect, useState } from 'react';
import { Store, Globe2, LogOut } from 'lucide-react';
import client, { getSelectedBranch, setSelectedBranch } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';

// Sidebar strip showing where this screen is working. The Super Admin is
// either in the all-branches overview (only All Branches / Users / Branches
// in the menu) or inside one branch (that branch's full menu); everyone
// else just sees their own branch's name.
export default function BranchSwitcher() {
  const { user } = useAuth();
  const [branches, setBranches] = useState([]);
  const selected = getSelectedBranch();

  useEffect(() => {
    if (!user) return;
    client
      .get('/branches')
      .then((res) => setBranches(res.data.data))
      .catch(() => setBranches([]));
  }, [user]);

  if (!branches.length) return null; // single shop, no branches

  if (!user?.isSuperAdmin) {
    return (
      <div className="mx-3 mb-3 flex items-center gap-2 rounded-xl bg-white/[0.07] px-3 py-2 text-xs font-semibold text-white ring-1 ring-white/10">
        <Store className="h-4 w-4 text-gold-300" /> {branches[0]?.name}
      </div>
    );
  }

  const inside = branches.find((b) => String(b.id) === selected && b.active);

  const go = (id) => {
    setSelectedBranch(id);
    // Every page reloads for the newly chosen place.
    window.location.href = id ? '/dashboard' : '/super-dashboard';
  };

  if (!inside) {
    return (
      <label className="mx-3 mb-3 block rounded-xl bg-white/[0.07] px-3 py-2 ring-1 ring-white/10">
        <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-gold-300">
          <Globe2 className="h-3.5 w-3.5" /> All branches · overview
        </span>
        <select value="" onChange={(e) => e.target.value && go(e.target.value)} className="mt-1 w-full cursor-pointer bg-transparent text-sm font-semibold text-white outline-none [&>option]:text-neutral-900">
          <option value="">Open a branch…</option>
          {branches
            .filter((b) => b.active)
            .map((b) => (
              <option key={b.id} value={String(b.id)}>
                {b.name}
              </option>
            ))}
        </select>
      </label>
    );
  }

  return (
    <div className="mx-3 mb-3 rounded-xl bg-white/[0.07] px-3 py-2 ring-1 ring-gold-400/30">
      <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-gold-300">
        <Store className="h-3.5 w-3.5" /> Working in branch
      </span>
      <select value={String(inside.id)} onChange={(e) => go(e.target.value)} className="mt-1 w-full cursor-pointer bg-transparent text-sm font-semibold text-white outline-none [&>option]:text-neutral-900">
        {branches
          .filter((b) => b.active)
          .map((b) => (
            <option key={b.id} value={String(b.id)}>
              {b.name}
            </option>
          ))}
      </select>
      <button
        type="button"
        onClick={() => go('')}
        className="mt-1.5 inline-flex items-center gap-1 rounded-lg bg-white/10 px-2 py-1 text-[11px] font-semibold text-white/85 hover:bg-white/20"
      >
        <LogOut className="h-3 w-3" /> Back to all branches
      </button>
    </div>
  );
}
