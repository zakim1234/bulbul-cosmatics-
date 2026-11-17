import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import client from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import Button from './ui/Button.jsx';
import { showBulkTools } from '../constants/permissions.js';

// "Clear All" -- one click deletes every record of one kind (items,
// customers, purchase invoices) in the open branch, for good, with no
// question first. Shown to the Super Admin only; the server checks that too.
//   url: the clear endpoint; describe(data) -> the success message;
//   onDone: reload the page; onStart: runs at once on click (e.g. empty an
//   unsaved table on the page), whatever the server answers.
export default function ClearAllButton({ url, describe, onDone, onStart }) {
  const { user } = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  // Super Admin only, once switched on in Settings.
  if (!showBulkTools(user)) return null;

  const clear = async () => {
    onStart?.();
    setBusy(true);
    try {
      const res = await client.post(url, { confirm: 'DELETE' });
      const data = res.data.data || {};
      if (data.failed) toast.error(`${data.failed} could not be deleted: ${data.failures?.[0]?.message || ''}`);
      toast.success(describe(data));
      onDone?.();
    } catch (err) {
      toast.error(err.friendlyMessage || 'Could not clear.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button variant="secondary" className="!text-red-600 hover:!bg-red-50" onClick={clear} loading={busy}>
      {!busy && <Trash2 className="h-4 w-4" />} Clear All
    </Button>
  );
}
