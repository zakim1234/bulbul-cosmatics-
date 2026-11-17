import User, { LEGACY_PERMISSIONS, expandLegacy } from '../models/User.js';

// The broad permissions "Edit records", "Delete records" and "Customer money"
// were split, one area each. On start-up every user who had one gets all of
// its parts instead (and an admin it was taken from loses all of its parts),
// so nobody gains or loses anything. Safe to run every start: only users still
// holding an old name are touched.
export async function migratePermissions() {
  const old = Object.keys(LEGACY_PERMISSIONS);
  const users = await User.collection
    .find({ $or: [{ permissions: { $in: old } }, { adminDenied: { $in: old } }, { adminGranted: { $in: old } }] })
    .project({ permissions: 1, adminDenied: 1, adminGranted: 1 })
    .toArray();
  for (const u of users) {
    await User.collection.updateOne(
      { _id: u._id },
      { $set: { permissions: expandLegacy(u.permissions || []), adminDenied: expandLegacy(u.adminDenied || []), adminGranted: expandLegacy(u.adminGranted || []) } }
    );
  }
  if (users.length) console.log(`[permissions] ${users.length} user(s) moved to the split permissions`);
  return users.length;
}
