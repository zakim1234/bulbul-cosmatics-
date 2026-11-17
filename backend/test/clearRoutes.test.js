// Every "Clear All" button in the app posts to /api/<kind>/clear. This test
// fails if one of those routes is ever dropped again (it once went missing
// for customers and the button answered "Route not found").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const KINDS = {
  customers: 'clearCustomers',
  inventory: 'clearInventory',
  accounts: 'clearAccounts',
  purchases: 'clearPurchases',
  suppliers: 'clearSuppliers',
};

for (const [file, handler] of Object.entries(KINDS)) {
  test(`POST /api/${file}/clear is registered`, () => {
    const src = readFileSync(new URL(`../src/routes/${file}.js`, import.meta.url), 'utf8');
    assert.match(src, new RegExp(`router\\.post\\(\\s*'/clear'\\s*,\\s*${handler}\\s*\\)`), `routes/${file}.js has no POST /clear -> ${handler}`);
    assert.match(src, new RegExp(`import \\{[^}]*\\b${handler}\\b[^}]*\\} from '../controllers/clearController\\.js'`));
  });
}
