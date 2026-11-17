import 'dotenv/config';
import readline from 'node:readline/promises';
import mongoose from 'mongoose';
import { safeUri } from '../config/db.js';

// Deletes the data in the database named in MONGO_URI (backend/.env). It
// cannot be undone, so it shows what is there and asks you to type the
// database's name to confirm.
//   npm run db:wipe                          -> EVERYTHING, users included
//   npm run db:wipe -- --keep-super-admin    -> everything except the Super
//                                               Admin's account (sign in as
//                                               before, start again clean)
// Without a terminal: WIPE_CONFIRM=<database name> npm run db:wipe
// Take a backup first (mongodump) if anything in it may ever be needed.

async function wipe() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required (backend/.env).');
  const keepSuperAdmin = process.argv.slice(2).includes('--keep-super-admin');
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;
  const name = db.databaseName;

  console.log(`\nDatabase: ${name}  (${safeUri(process.env.MONGO_URI)})`);
  const collections = (await db.listCollections().toArray()).map((c) => c.name).filter((c) => !c.startsWith('system.')).sort();
  if (!collections.length) {
    console.log('It is already empty. Nothing to do.');
    return;
  }

  // Keeping the Super Admin: there must be one, and it must be clear who.
  let kept = [];
  if (keepSuperAdmin) {
    kept = collections.includes('users') ? await db.collection('users').find({ isSuperAdmin: true }).project({ username: 1, name: 1 }).toArray() : [];
    if (!kept.length) throw new Error('There is no Super Admin to keep. Nothing was deleted (use npm run db:wipe to delete everything).');
  }

  let total = 0;
  for (const c of collections) {
    const n = await db.collection(c).estimatedDocumentCount();
    total += n;
    console.log(`  ${c.padEnd(32)} ${n}`);
  }
  if (keepSuperAdmin) {
    console.log(`\nThis deletes everything above, for good, EXCEPT the Super Admin's account:`);
    for (const u of kept) console.log(`  kept: ${u.name} (${u.username})`);
  } else {
    console.log(`\nThis deletes all ${total} records above, for good -- users included.`);
  }

  let typed = process.env.WIPE_CONFIRM;
  if (typed === undefined) {
    if (!process.stdin.isTTY) throw new Error('Run this in a terminal (or set WIPE_CONFIRM to the database name).');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    typed = await rl.question(`Type the database name (${name}) to delete, or anything else to stop: `);
    rl.close();
  }
  if (String(typed).trim() !== name) {
    console.log('Stopped. Nothing was deleted.');
    return;
  }

  if (!keepSuperAdmin) {
    await db.dropDatabase();
    console.log(`\nDone: "${name}" is now empty.`);
    console.log('Next: create the first admin (npm run seed:admin), then start the backend again.');
    return;
  }

  // Everything but the Super Admin: every other collection goes; in users,
  // only the Super Admin stays (with no branch -- branches are gone too).
  for (const c of collections) {
    if (c === 'users') continue;
    await db.collection(c).drop();
  }
  const ids = kept.map((u) => u._id);
  await db.collection('users').deleteMany({ _id: { $nin: ids } });
  await db.collection('users').updateMany({ _id: { $in: ids } }, { $set: { branch: null, active: true } });
  console.log(`\nDone: everything in "${name}" was deleted except the Super Admin (${kept.map((u) => u.username).join(', ')}).`);
  console.log('Next: start the backend again and sign in as before. Add branches and users again from the system.');
}

wipe()
  .catch((error) => {
    console.error('Wipe failed:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
