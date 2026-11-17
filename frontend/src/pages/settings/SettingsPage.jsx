import { useEffect, useState } from 'react';
import { Settings, Trash2, FileSpreadsheet, Store } from 'lucide-react';
import client from '../../api/client.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import PageHeader from '../../components/ui/PageHeader.jsx';

function Switch({ on, onClick, disabled }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={onClick}
      disabled={disabled}
      className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${on ? 'bg-brand-600' : 'bg-neutral-300'} ${disabled ? 'opacity-60' : ''}`}
    >
      <span className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-all ${on ? 'left-[22px]' : 'left-0.5'}`} />
    </button>
  );
}

// The Super Admin's own settings. "Clear All and Import Excel": the buttons
// stay hidden everywhere -- even from the Super Admin -- until switched on.
// With branches it is switched on per branch: every other branch stays closed.
export default function SettingsPage() {
  const { user, refreshUser } = useAuth();
  const toast = useToast();
  const [saving, setSaving] = useState('');
  const [branches, setBranches] = useState(null);

  useEffect(() => {
    client
      .get('/branches')
      .then((r) => setBranches((r.data.data || []).filter((b) => b.active !== false)))
      .catch(() => setBranches([]));
  }, []);

  const enabledIds = (user?.bulkToolsBranches || []).map(String);

  const save = async (body, key, msg) => {
    setSaving(key);
    try {
      await client.put('/auth/settings', body);
      await refreshUser();
      toast.success(msg);
    } catch (err) {
      toast.error(err.friendlyMessage || 'Could not save the setting.');
    } finally {
      setSaving('');
    }
  };

  const hasBranches = branches && branches.length > 0;
  const on = !!user?.showBulkTools;

  return (
    <div>
      <PageHeader title="Settings" subtitle="Super Admin settings" />
      <div className="max-w-2xl rounded-2xl border border-neutral-200 bg-white p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-red-50 text-red-600">
              <Settings className="h-5 w-5" />
            </span>
            <div>
              <p className="font-bold text-neutral-950">Clear All and Import Excel file</p>
              <p className="mt-1 text-sm text-neutral-600">
                Shows the <Trash2 className="inline h-3.5 w-3.5 text-red-600" /> <b>Clear All</b> and <FileSpreadsheet className="inline h-3.5 w-3.5 text-brand-600" /> <b>Import Excel file</b> buttons
                (Inventory, Stock, Customers, Purchase Invoices, Accounts, Reports and the sheets). Only you see them
                {hasBranches ? ', and only in the branches switched on below. Every other branch stays closed.' : ', and only while this is on.'}
              </p>
            </div>
          </div>
          {branches && !hasBranches && (
            <Switch on={on} disabled={!!saving} onClick={() => save({ showBulkTools: !on }, 'all', !on ? 'Clear All and Import Excel are now shown.' : 'Clear All and Import Excel are now hidden.')} />
          )}
        </div>

        {branches === null ? (
          <p className="mt-3 text-sm text-neutral-400">Loading...</p>
        ) : hasBranches ? (
          <div className="mt-4 divide-y divide-neutral-100 rounded-xl border border-neutral-200">
            {branches.map((b) => {
              const id = String(b.id || b._id);
              const bOn = enabledIds.includes(id);
              return (
                <div key={id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="flex items-center gap-2">
                    <Store className="h-4 w-4 text-neutral-400" />
                    <span className="text-sm font-semibold text-neutral-800">{b.name}</span>
                    <span className={`text-xs font-semibold ${bOn ? 'text-brand-700' : 'text-neutral-400'}`}>{bOn ? 'Open' : 'Closed'}</span>
                  </div>
                  <Switch
                    on={bOn}
                    disabled={!!saving}
                    onClick={() => save({ branchId: id, enabled: !bOn }, id, !bOn ? `Clear All and Import Excel are now open in ${b.name}.` : `Clear All and Import Excel are now closed in ${b.name}.`)}
                  />
                </div>
              );
            })}
          </div>
        ) : (
          <p className={`mt-3 text-sm font-semibold ${on ? 'text-brand-700' : 'text-neutral-500'}`}>{on ? 'On -- the buttons are shown.' : 'Off -- the buttons are hidden.'}</p>
        )}
      </div>
    </div>
  );
}
