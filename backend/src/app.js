import stockRoutes from './routes/stock.js';
import quotationRoutes from './routes/quotations.js';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';

import authRoutes from './routes/auth.js';
import inventoryRoutes from './routes/inventory.js';
import categoryRoutes from './routes/categories.js';
import customerRoutes from './routes/customers.js';
import supplierRoutes from './routes/suppliers.js';
import purchaseRoutes from './routes/purchases.js';
import saleRoutes from './routes/sales.js';
import paymentRoutes from './routes/payments.js';
import reportRoutes from './routes/reports.js';
import dashboardRoutes from './routes/dashboard.js';
import accountRoutes from './routes/accounts.js';
import dayCloseRoutes from './routes/dayClose.js';
import supplierInvoiceArchiveRoutes from './routes/supplierInvoiceArchives.js';
import userRoutes from './routes/users.js';
import expenseRoutes from './routes/expenses.js';
import salaryRoutes from './routes/salaries.js';
import commissionRoutes from './routes/commissions.js';
import offsetRoutes from './routes/offsets.js';
import branchRoutes from './routes/branches.js';
import quickItemRoutes from './routes/quickItems.js';
import partnerRoutes from './routes/partners.js';
import fixedAssetRoutes from './routes/fixedAssets.js';
import liabilityRoutes from './routes/liabilities.js';
import zakatRoutes from './routes/zakat.js';
import stockAdjustmentRoutes from './routes/stockAdjustments.js';
import chatRoutes from './routes/chat.js';
import companyWalletRoutes from './routes/companyWallets.js';

import { notFoundHandler, errorHandler } from './middleware/errorHandler.js';
import { rejectOperatorKeys } from './middleware/noOperators.js';
import { ApiError } from './utils/ApiError.js';

const app = express();

// Behind nginx on the same machine: req.ip is the visitor's address taken
// from X-Forwarded-For -- trusted only when nginx (loopback) sent it, so a
// visitor cannot fake it. Used by the login attempt limit.
app.set('trust proxy', 'loopback');
// Do not announce the framework ("X-Powered-By: Express").
app.disable('x-powered-by');
// Basic protection headers on every API answer: no MIME sniffing, never
// shown inside another site's frame, no referrer, never cached (the answers
// hold business data), and HTTPS only from now on when served over HTTPS.
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  });
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  next();
});

// CLIENT_ORIGIN is a comma-separated allowlist (deployed frontend origin(s)
// plus, for local development, the Vite dev server origin). Requests with no
// Origin header (server-to-server calls, curl, health checks) are allowed
// through since there is no browser same-origin policy to enforce for them.
const allowedOrigins = (process.env.CLIENT_ORIGIN || 'http://localhost:5173')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new ApiError(403, 'Not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Branch-Id'],
  })
);
// Large enough for a stock list or invoice of tens of thousands of rows.
app.use(express.json({ limit: '100mb' }));
app.use(rejectOperatorKeys);
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('dev'));
}

app.get('/api/health', (req, res) =>
  res.json({ success: true, service: 'inventory-api', status: 'ok', time: new Date().toISOString() })
);

app.use('/api/auth', authRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/stock', stockRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/suppliers', supplierRoutes);
app.use('/api/purchases', purchaseRoutes);
app.use('/api/sales', saleRoutes);
app.use('/api/quotations', quotationRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/accounts', accountRoutes);
app.use('/api/day-close', dayCloseRoutes);
app.use('/api/supplier-invoice-archives', supplierInvoiceArchiveRoutes);
app.use('/api/users', userRoutes);
app.use('/api/expenses', expenseRoutes);
app.use('/api/salaries', salaryRoutes);
app.use('/api/commissions', commissionRoutes);
app.use('/api/offsets', offsetRoutes);
app.use('/api/branches', branchRoutes);
app.use('/api/quick-items', quickItemRoutes);
app.use('/api/partners', partnerRoutes);
app.use('/api/fixed-assets', fixedAssetRoutes);
app.use('/api/liabilities', liabilityRoutes);
app.use('/api/zakat', zakatRoutes);
app.use('/api/stock-adjustments', stockAdjustmentRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/company-wallets', companyWalletRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
