import { useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, Wallet } from 'lucide-react';
import client from '../../api/client.js';
import { useToast } from '../../context/ToastContext.jsx';
import { formatCurrency, formatDate } from '../../utils/format.js';
import Button from '../../components/ui/Button.jsx';
import Modal from '../../components/ui/Modal.jsx';
import { FormField, Input } from '../../components/ui/Field.jsx';
import AccountSelect from '../../components/AccountSelect.jsx';

// The branch's commission account: the staff's 30% is moved in here from the
// other accounts, and commission is paid out of it.
export default function CommissionAccountCard({ data, share, onChanged }) {
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [move, setMove] = useState(null); // 'IN' | 'OUT'
  const [showMoves, setShowMoves] = useState(false);
  const account = data?.account;

  const create = async () => {
    setCreating(true);
    try {
      await client.post('/commissions/account');
      toast.success('Commission account created.');
      onChanged();
    } catch (err) {
      toast.error(err.friendlyMessage || 'Could not create the commission account.');
    } finally {
      setCreating(false);
    }
  };

  if (!data) return null;
  if (!account) {
    return (
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-neutral-300 bg-white p-4">
        <p className="text-sm text-neutral-600">
          Keep the staff's {formatCurrency(share)} in its own account: create the <b>Commission 30%</b> account, move the money in, and pay commission from it.
        </p>
        <Button onClick={create} loading={creating}>
          <Wallet className="h-4 w-4" /> Create commission account
        </Button>
      </div>
    );
  }

  return (
    <div className="mb-5 rounded-xl border border-neutral-200/80 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">{account.name} account</p>
          <p className="text-2xl font-bold text-neutral-900 figure">{formatCurrency(account.balance)}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setMove('IN')}>
            <ArrowDownLeft className="h-4 w-4" /> Move money in
          </Button>
          <Button variant="secondary" onClick={() => setMove('OUT')} disabled={!(account.balance > 0)}>
            <ArrowUpRight className="h-4 w-4" /> Move back
          </Button>
          {data.moves.length > 0 && (
            <Button variant="secondary" onClick={() => setShowMoves((v) => !v)}>
              {showMoves ? 'Hide history' : 'History'}
            </Button>
          )}
        </div>
      </div>
      {showMoves && (
        <div className="mt-3 divide-y divide-neutral-100 border-t border-neutral-100 text-sm">
          {data.moves.map((m) => (
            <div key={m.id} className="flex items-center justify-between gap-3 py-1.5">
              <span className="text-neutral-600">
                {formatDate(m.date)} · {m.description}
              </span>
              <span className={`font-semibold tabular-nums ${m.direction === 'IN' ? 'text-brand-700' : 'text-red-600'}`}>
                {m.direction === 'IN' ? '+' : '−'}
                {formatCurrency(m.amount)}
              </span>
            </div>
          ))}
        </div>
      )}
      <MoveModal
        direction={move}
        account={account}
        suggested={move === 'IN' ? Math.max(0, Math.round((share - account.balance) * 100) / 100) : account.balance}
        onClose={() => setMove(null)}
        onDone={() => {
          setMove(null);
          onChanged();
        }}
      />
    </div>
  );
}

function MoveModal({ direction, account, suggested, onClose, onDone }) {
  const toast = useToast();
  const [otherId, setOtherId] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [openFor, setOpenFor] = useState(null);
  if (direction && openFor !== direction) {
    setOpenFor(direction);
    setOtherId('');
    setAmount(suggested > 0 ? String(suggested) : '');
    setNote('');
  }
  if (!direction && openFor) setOpenFor(null);

  const save = async (e) => {
    e.preventDefault();
    if (!otherId) return toast.error('Choose the account.');
    if (!(Number(amount) > 0)) return toast.error('Enter an amount greater than zero.');
    setSaving(true);
    try {
      await client.post('/commissions/account/move', { otherAccountId: otherId, amount: Number(amount), direction, note });
      toast.success(direction === 'IN' ? `${formatCurrency(Number(amount))} moved into ${account.name}.` : `${formatCurrency(Number(amount))} moved back.`);
      onDone();
    } catch (err) {
      toast.error(err.friendlyMessage || 'Could not move the money.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={!!direction} onClose={onClose} title={direction === 'IN' ? `Move money into ${account.name}` : `Move money back from ${account.name}`} size="sm">
      <form onSubmit={save} className="space-y-4">
        <FormField label={direction === 'IN' ? 'From account' : 'To account'} required>
          <AccountSelect value={otherId} onChange={(id) => setOtherId(id || '')} showBalance excludeId={account.id} />
        </FormField>
        <FormField label="Amount" required>
          <Input type="number" step="0.01" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
        </FormField>
        <FormField label="Note">
          <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="Optional" />
        </FormField>
        <div className="flex justify-end gap-2 border-t border-neutral-100 pt-4">
          <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" loading={saving}>
            Move {amount ? formatCurrency(Number(amount)) : ''}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
