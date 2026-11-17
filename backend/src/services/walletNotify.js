import ChatMessage from '../models/ChatMessage.js';
import User from '../models/User.js';
import WalletNotice from '../models/WalletNotice.js';

// When money is taken from a branch's accounts into the company wallet, the
// branch admins (only they -- not other staff) get a chat message from the
// Super Admin; it pops up beside the Chat button. It says how much, from
// which account, and the total.
// (Like every chat message it is cleared at that branch's Close Day; the
// Company Wallet report keeps the full record.)
const money = (cents) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// e.g. "Mudane admin, accountkaaga EVC waxaa laga jaray $300.00."
//      "Mudane admin, waxaa kugu dhiman −$100.00. ..."
export function takeText(lines, owedCents = 0) {
  const total = lines.reduce((t, i) => t + i.cents, 0);
  return [
    ...lines.map((i) => `Mudane admin, accountkaaga ${i.accountName} waxaa laga jaray ${money(i.cents)}.`),
    ...(lines.length > 1 ? [`Wadarta laga jaray: ${money(total)}.`] : []),
    ...(owedCents > 0
      ? [`Mudane admin, waxaa kugu dhiman −${money(owedCents)}. Lacagta ugu horreysa ee soo gasha accountkaaga si otomaatig ah ayaa looga jari doonaa.`]
      : []),
  ].join('\n').slice(0, 1000);
}

// e.g. "Mudane admin, accountkaaga EVC waxaa lagu shubay $50.00 oo ka
//       timid company wallet-ka. Tani deyn ma aha."
export function giveText(accountName, cents, note = '') {
  return [`Mudane admin, accountkaaga ${accountName} waxaa lagu shubay ${money(cents)} oo ka timid company wallet-ka. Tani deyn ma aha.`, ...(note ? [note] : [])].join('\n').slice(0, 1000);
}

// Money given from the company wallet into a branch account (not a loan):
// the branch admins get a chat message, and the Super Admin keeps a copy.
export async function notifyBranchGive({ branchId, branchName = '', accountName, cents, note = '', batch = '', sender = null }) {
  try {
    if (!(cents > 0)) return;
    const from = sender?.isSuperAdmin ? sender : (await User.findOne({ isSuperAdmin: true, active: { $ne: false } }).select('_id name isSuperAdmin').lean()) || sender;
    if (!from?._id) return;
    const text = giveText(accountName, cents, note);
    const admins = await User.find({ branch: branchId, role: 'admin', isSuperAdmin: { $ne: true }, active: { $ne: false } }).select('_id name').lean();
    await WalletNotice.create({ branch: branchId, branchName, to: admins.map((a) => a.name), text, takenCents: 0, givenCents: cents, owedCents: 0, batch, automatic: false });
    if (!admins.length) return;
    await ChatMessage.insertMany(admins.map((a) => ({ branch: branchId, from: from._id, fromName: from.name, to: a._id, text, readBy: [from._id] })));
  } catch (err) {
    console.warn(`[wallet-notify] ${branchName}: could not send the chat message -- ${err.message}`);
  }
}

export async function notifyBranchTake({ branchId, branchName = '', items, batch = '', owedCents = 0, automatic = false, sender = null }) {
  try {
    const lines = (items || []).filter((i) => i.cents > 0);
    if (!lines.length && !(owedCents > 0)) return;
    const total = lines.reduce((t, i) => t + i.cents, 0);
    const from = sender?.isSuperAdmin ? sender : (await User.findOne({ isSuperAdmin: true, active: { $ne: false } }).select('_id name isSuperAdmin').lean()) || sender;
    if (!from?._id) return;
    const text = takeText(lines, owedCents);
    const admins = await User.find({ branch: branchId, role: 'admin', isSuperAdmin: { $ne: true }, active: { $ne: false } }).select('_id name').lean();
    // The branch admins only -- other staff are not told.
    // The Super Admin's own copy, kept (the chat is cleared at Close Day).
    await WalletNotice.create({ branch: branchId, branchName, to: admins.map((a) => a.name), text, takenCents: total, owedCents: owedCents || 0, batch, automatic });
    if (!admins.length) return;
    await ChatMessage.insertMany(admins.map((a) => ({ branch: branchId, from: from._id, fromName: from.name, to: a._id, text, readBy: [from._id] })));
  } catch (err) {
    console.warn(`[wallet-notify] ${branchName}: could not send the chat message -- ${err.message}`);
  }
}
