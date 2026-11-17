import Sale from '../models/Sale.js';
import { confirmSale } from '../services/dayCloseService.js';
import { runWithBranch } from '../services/branchContext.js';
import { runInTransaction } from './transaction.js';

// Sales invoices -- made at the POS or from a quotation -- are final at once
// now (no Pending). Any still Pending from before that change are confirmed
// here, on start-up: stock, the customer's debt and the account are posted,
// and the next Close Day still counts them in that day's totals. Safe to run
// every start -- only Pending invoices are touched. One failing (e.g. a
// batch that expired) stays Pending for Close Day to show, and does not stop
// the others or the server.
export async function confirmQuotationDrafts() {
  const drafts = await Sale.find({ status: 'DRAFT' }).select('_id branch receiptNumber').setOptions({ skipBranch: true }).lean();
  let done = 0;
  for (const d of drafts) {
    try {
      await runWithBranch(d.branch, () =>
        runInTransaction(async (session) => {
          const sale = await Sale.findById(d._id).session(session);
          if (!sale || sale.status !== 'DRAFT') return;
          await confirmSale(sale, session, null);
          sale.awaitingDayClose = true;
          await sale.save({ session });
        })
      );
      done += 1;
    } catch (err) {
      console.error(`[pending invoices] ${d.receiptNumber} could not be confirmed: ${err.message}`);
    }
  }
  if (drafts.length) console.log(`[pending invoices] ${done} of ${drafts.length} pending invoice(s) confirmed`);
  return { found: drafts.length, confirmed: done };
}
