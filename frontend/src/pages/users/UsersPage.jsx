import { useCallback, useEffect, useState } from 'react';
import { Plus, ShieldCheck, ShieldOff, Trash2 } from 'lucide-react';
import client from '../../api/client.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { formatDate } from '../../utils/format.js';
import { PERMISSION_MODULES, ROLES, canGrant, ADMIN_OPT_IN, groupPermissions, PERMISSION_SO, GROUP_TITLES_SO } from '../../constants/permissions.js';

// The permissions in groups (Sales, Customers, Stock...), each with a
// heading and a "tick all" for the group.
// English or Somali, remembered on this computer.
function readLang() {
  try { return localStorage.getItem('permLang') === 'so' ? 'so' : 'en'; } catch { return 'en'; }
}
function PermissionChecklist({ modules, isOn, onToggle }) {
  const [lang, setLang] = useState(readLang);
  const so = lang === 'so';
  const pickLang = (l) => { setLang(l); try { localStorage.setItem('permLang', l); } catch { /* ignore */ } };
  const label = (m) => (so && PERMISSION_SO[m.key]?.[0]) || m.label;
  const hint = (m) => (so && PERMISSION_SO[m.key]?.[1]) || m.hint;
  const everyOn = modules.every((m) => isOn(m.key));
  return (
    <div className="space-y-3 rounded-lg border border-neutral-200 p-3">
      {/* Language, and every permission at once (e.g. a branch admin given everything). */}
      <div className="flex items-center justify-between gap-2">
        <div className="inline-flex overflow-hidden rounded-md border border-neutral-200 text-xs font-semibold">
          {[['en', 'English'], ['so', 'Soomaali']].map(([l, name]) => (
            <button key={l} type="button" onClick={() => pickLang(l)} className={`px-2.5 py-1 ${lang === l ? 'bg-brand-600 text-white' : 'bg-white text-neutral-600 hover:bg-neutral-50'}`}>
              {name}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => modules.filter((m) => isOn(m.key) === everyOn).forEach((m) => onToggle(m.key))}
          className="rounded-md bg-brand-50 px-2.5 py-1 text-xs font-bold text-brand-700 hover:bg-brand-100"
        >
          {so ? (everyOn ? 'Ka saar dhammaan' : 'Calaamadee dhammaan') : (everyOn ? 'Untick every permission' : 'Tick every permission')}
        </button>
      </div>
      {groupPermissions(modules).map((g) => {
        const allOn = g.modules.every((m) => isOn(m.key));
        return (
          <div key={g.title}>
            <div className="mb-1.5 flex items-center justify-between gap-2 border-b border-neutral-100 pb-1">
              <p className="text-xs font-bold uppercase tracking-wide text-neutral-500">{(so && GROUP_TITLES_SO[g.title]) || g.title}</p>
              <button
                type="button"
                onClick={() => g.modules.filter((m) => isOn(m.key) === allOn).forEach((m) => onToggle(m.key))}
                className="text-[11px] font-semibold text-brand-700 hover:underline"
              >
                {so ? (allOn ? 'Ka saar kooxda' : 'Calaamadee kooxda') : (allOn ? 'Untick all' : 'Tick all')}
              </button>
            </div>
            <div className="grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2">
              {g.modules.map((m) => (
                <label key={m.key} className="flex items-start gap-2 text-sm text-neutral-700">
                  <input type="checkbox" className="mt-0.5 shrink-0" checked={isOn(m.key)} onChange={() => onToggle(m.key)} />
                  <span>
                    {label(m)}
                    {hint(m) && <span className="block text-xs leading-snug text-neutral-400">{hint(m)}</span>}
                  </span>
                </label>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
import PageHeader from '../../components/ui/PageHeader.jsx';
import Button from '../../components/ui/Button.jsx';
import Badge from '../../components/ui/Badge.jsx';
import { Table, THead, Th, TBody, Td, TableEmpty, TableLoading } from '../../components/ui/Table.jsx';
import ConfirmDialog from '../../components/ui/ConfirmDialog.jsx';
import Modal from '../../components/ui/Modal.jsx';
import { FormField, Input, Select } from '../../components/ui/Field.jsx';

// Branches the Super Admin can put a user in (empty without branches or
// for branch admins, whose new users always join their own branch).
// `roles`: the roles this admin may give (a branch admin: staff roles only).
// `me`: who is editing -- only the Super Admin sets what a branch admin may do.
function UserFormModal({ open, onClose, user, onSaved, branches = [], roles = ROLES, me }) {
  const toast = useToast();
  const isEdit = !!user;
  const [form, setForm] = useState({ email: '', phone: '', password: '', name: '', role: 'cashier', permissions: [], branchId: '', denied: [], granted: [] });
  const editingSelf = isEdit && String(user.id) === String(me?.id);
  // The Super Admin decides what each branch admin may do.
  const canSetLimits = !!me?.isSuperAdmin && form.role === 'admin' && !user?.isSuperAdmin;
  // A branch admin sees (and gives) only what they may do themselves; what
  // was taken away from them is not shown at all.
  const grantable = PERMISSION_MODULES.filter((m) => canGrant(me, m.key));
  const roleOptions = [...new Set([...roles, ...(isEdit ? [user.role] : [])])];
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm(
      user
        ? { email: user.email || '', phone: user.phone || '', password: '', name: user.name, role: user.role, permissions: user.permissions || [], branchId: user.branch ? String(user.branch) : '', denied: user.adminDenied || [], granted: user.adminGranted || [] }
        : { email: '', phone: '', password: '', name: '', role: 'cashier', permissions: [], branchId: branches[0] ? String(branches[0].id) : '', denied: [], granted: [] }
    );
  }, [open, user]);

  const togglePermission = (key) =>
    setForm((f) => ({ ...f, permissions: f.permissions.includes(key) ? f.permissions.filter((p) => p !== key) : [...f.permissions, key] }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) return toast.error('Enter the full name.');
    // Everyone signs in with their email (users from before emails get one here).
    const email = form.email.trim().toLowerCase();
    if ((!isEdit || email || !user.email) && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return toast.error('Enter a valid email address, like name@example.com.');
    // Same rule as the server: at least 8 characters (new users, and any new password).
    if ((!isEdit || form.password) && form.password.length < 8) return toast.error('Password must be at least 8 characters.');
    setSaving(true);
    try {
      if (isEdit) {
        const payload = {
          name: form.name,
          phone: form.phone,
          ...(email && email !== user.email ? { email } : {}),
          role: form.role,
          // An admin's abilities are not a permission list (see adminDenied).
          ...(form.role === 'admin' ? {} : { permissions: form.permissions }),
          ...(canSetLimits ? { adminDenied: form.denied, adminGranted: form.granted } : {}),
          ...(branches.length && !user.isSuperAdmin ? { branchId: form.branchId } : {}),
        };
        if (form.password) payload.password = form.password;
        await client.put(`/users/${user.id}`, payload);
        toast.success('User updated.');
      } else {
        await client.post('/users', {
          email,
          password: form.password,
          name: form.name,
          phone: form.phone,
          role: form.role,
          ...(form.role === 'admin' ? {} : { permissions: form.permissions }),
          ...(canSetLimits ? { adminDenied: form.denied, adminGranted: form.granted } : {}),
          ...(branches.length ? { branchId: form.branchId } : {}),
        });
        toast.success('User created.');
      }
      onSaved();
      onClose();
    } catch (err) {
      toast.error(err.friendlyMessage || 'Could not save user.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={isEdit ? `Edit User — ${user.name}` : 'Add New User'} size="lg">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Full Name" required>
            <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} autoFocus />
          </FormField>
          <FormField label="Phone">
            <Input value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} placeholder="e.g. 61xxxxxxx" />
          </FormField>
          <FormField label="Email (used to sign in)" required>
            <Input
              type="email"
              value={form.email}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
              placeholder={isEdit && !user.email ? `No email yet (signs in as "${user.username}")` : 'name@example.com'}
              autoComplete="off"
            />
          </FormField>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <FormField label={isEdit ? 'New Password (leave blank to keep current)' : 'Password'} required={!isEdit}>
            <Input type="password" value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} />
          </FormField>
          <FormField label="Role" required>
            <Select value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))} disabled={editingSelf}>
              {roleOptions.map((r) => (
                <option key={r} value={r}>{r.charAt(0).toUpperCase() + r.slice(1)}</option>
              ))}
            </Select>
          </FormField>
        </div>

        {branches.length > 0 && !user?.isSuperAdmin && (
          <FormField label="Branch" required>
            <Select value={form.branchId} onChange={(e) => setForm((f) => ({ ...f, branchId: e.target.value }))}>
              {branches.map((b) => (
                <option key={b.id} value={String(b.id)}>
                  {b.name}
                  {b.active ? '' : ' (closed)'}
                </option>
              ))}
            </Select>
          </FormField>
        )}

        {canSetLimits ? (
          <FormField label="What this branch admin may do">
            <p className="mb-2 text-xs text-neutral-500">Ticked: allowed. Untick anything this admin should not do in their branch. Only the Super Admin can change this.</p>
            <PermissionChecklist
              modules={PERMISSION_MODULES}
              // Opt-in abilities are off until ticked; the rest on until unticked.
              isOn={(key) => (ADMIN_OPT_IN.includes(key) ? form.granted.includes(key) : !form.denied.includes(key))}
              onToggle={(key) => {
                const list = ADMIN_OPT_IN.includes(key) ? 'granted' : 'denied';
                setForm((f) => ({ ...f, [list]: f[list].includes(key) ? f[list].filter((d) => d !== key) : [...f[list], key] }));
              }}
            />
          </FormField>
        ) : form.role === 'admin' ? (
          <p className="rounded-lg bg-brand-50 px-3 py-2 text-xs text-brand-700">
            {user?.isSuperAdmin
              ? 'The Super Admin can do everything, in every branch.'
              : `An admin manages ${branches.length || !me?.isSuperAdmin ? 'their own branch' : 'the shop'}; what they may do there is set by the Super Admin.`}
          </p>
        ) : (
          <FormField label="Permissions">
            <PermissionChecklist modules={grantable} isOn={(key) => form.permissions.includes(key)} onToggle={togglePermission} />
          </FormField>
        )}

        <div className="flex justify-end gap-2 border-t border-neutral-100 pt-4">
          <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button type="submit" loading={saving}>{isEdit ? 'Save Changes' : 'Create User'}</Button>
        </div>
      </form>
    </Modal>
  );
}

export default function UsersPage() {
  const toast = useToast();
  const { user: me } = useAuth();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [editUser, setEditUser] = useState(null);
  const [toggleTarget, setToggleTarget] = useState(null);
  const [toggling, setToggling] = useState(false);
  const [branches, setBranches] = useState([]);
  // What I may do here (a branch admin: staff roles only, never admins).
  const [rights, setRights] = useState({ roles: ROLES });

  useEffect(() => {
    if (!me?.isSuperAdmin) return;
    client.get('/branches').then((r) => setBranches(r.data.data)).catch(() => setBranches([]));
  }, [me]);
  const showBranch = users.some((u) => u.branchName || u.isSuperAdmin);

  const load = useCallback(() => {
    setLoading(true);
    client
      .get('/users')
      .then((res) => {
        setUsers(res.data.data);
        if (res.data.rights) setRights(res.data.rights);
      })
      .catch((err) => toast.error(err.friendlyMessage || 'Failed to load users.'))
      .finally(() => setLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => load(), [load]);

  // Switch one invoice permission on/off for a non-admin (admins always have them).
  const togglePerm = async (u, key, what) => {
    const on = u.permissions.includes(key);
    try {
      await client.put(`/users/${u.id}`, { permissions: on ? u.permissions.filter((p) => p !== key) : [...u.permissions, key] });
      toast.success(on ? `${u.name} can no longer ${what}.` : `${u.name} can now ${what}.`);
      load();
    } catch (err) {
      toast.error(err.friendlyMessage || 'Could not change this permission.');
    }
  };

  // Super Admin: switch one ability on/off for a branch admin.
  const toggleAdminAbility = async (u, key, label) => {
    const denied = u.adminDenied || [];
    const allowedNow = !denied.includes(key);
    try {
      await client.put(`/users/${u.id}`, { adminDenied: allowedNow ? [...denied, key] : denied.filter((d) => d !== key) });
      toast.success(allowedNow ? `${u.name} can no longer: ${label}.` : `${u.name} can now: ${label}.`);
      load();
    } catch (err) {
      toast.error(err.friendlyMessage || 'Could not change this.');
    }
  };

  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const handleDelete = async () => {
    setDeleting(true);
    try {
      await client.delete(`/users/${deleteTarget.id}`);
      toast.success(`${deleteTarget.name} deleted.`);
      setDeleteTarget(null);
      load();
    } catch (err) {
      toast.error(err.friendlyMessage || 'Could not delete this user.');
    } finally {
      setDeleting(false);
    }
  };

  const handleToggleActive = async () => {
    setToggling(true);
    try {
      await client.patch(`/users/${toggleTarget.id}/active`, { active: !toggleTarget.active });
      toast.success(toggleTarget.active ? 'User deactivated.' : 'User activated.');
      setToggleTarget(null);
      load();
    } catch (err) {
      toast.error(err.friendlyMessage || 'Could not update this user.');
    } finally {
      setToggling(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Users"
        subtitle="Admin-only: manage staff accounts and per-user module permissions"
        actions={
          <Button onClick={() => { setEditUser(null); setFormOpen(true); }}>
            <Plus className="h-4 w-4" /> Add New User
          </Button>
        }
      />

      <Table>
        <THead>
          <tr>
            <Th>Name</Th>
            <Th>Email</Th>
            <Th>Role</Th>
            {showBranch && <Th>Branch</Th>}
            <Th>Permissions</Th>
            <Th>Allowed to change</Th>
            <Th>Status</Th>
            <Th>Created</Th>
            <Th className="text-right">Actions</Th>
          </tr>
        </THead>
        <TBody>
          {loading ? (
            <TableLoading colSpan={showBranch ? 9 : 8} />
          ) : users.length === 0 ? (
            <TableEmpty colSpan={showBranch ? 9 : 8} message="No users found." />
          ) : (
            users.map((u) => (
              <tr key={u.id} className="hover:bg-neutral-50">
                <Td className="font-medium text-neutral-900">{u.name}</Td>
                <Td className="text-neutral-500">
                  {u.email || (
                    <span>
                      <span className="block text-neutral-400">{u.username}</span>
                      <span className="whitespace-nowrap text-[11px] font-semibold text-brand-700">No email yet</span>
                    </span>
                  )}
                </Td>
                <Td><Badge color={u.role === 'admin' ? 'blue' : 'slate'}>{u.role}</Badge></Td>
                {showBranch && <Td>{u.isSuperAdmin ? <Badge color="red">Super Admin · all branches</Badge> : <span className="text-sm text-neutral-700">{u.branchName || '—'}</span>}</Td>}
                <Td>
                  {u.role === 'admin' ? (
                    <span className={`text-xs ${u.adminDenied?.length ? 'font-semibold text-brand-700' : 'text-neutral-400'}`}>
                      {u.adminDenied?.length ? `All but ${u.adminDenied.length}` : 'All modules'}
                    </span>
                  ) : u.permissions.length === 0 ? (
                    <span className="text-xs text-neutral-300">None</span>
                  ) : (
                    <span className="text-xs text-neutral-500">{u.permissions.length} module{u.permissions.length > 1 ? 's' : ''}</span>
                  )}
                </Td>
                <Td>
                  {u.isSuperAdmin ? (
                    <span className="text-xs text-neutral-400">Everything, always</span>
                  ) : (
                    <div className="flex max-w-[22rem] flex-wrap gap-1">
                      {[
                        ['takeDebtPayments', 'Debt payments', 'take debt payments'],
                        ['customerReturns', 'Returns', 'take customer returns'],
                        ['editInvoices', 'Edit invoices', 'edit invoices'],
                        ['cancelInvoices', 'Cancel invoices', 'cancel invoices'],
                      ].filter(([key]) => canGrant(me, key)).map(([key, label, what]) => {
                        const isAdminRow = u.role === 'admin';
                        const on = isAdminRow ? !(u.adminDenied || []).includes(key) : u.permissions.includes(key);
                        // A branch admin's abilities: only the Super Admin changes them.
                        const canToggle = isAdminRow ? !!me?.isSuperAdmin : u.canManage !== false;
                        return (
                          <button
                            key={key}
                            type="button"
                            disabled={!canToggle}
                            onClick={() => (isAdminRow ? toggleAdminAbility(u, key, label) : togglePerm(u, key, what))}
                            title={!canToggle ? 'Set by the Super Admin' : on ? 'On — click to turn off' : 'Off — click to allow'}
                            className={`rounded-full px-2.5 py-1 text-[11px] font-semibold disabled:cursor-default ${on ? 'bg-primary text-white hover:bg-primary-hover disabled:hover:bg-primary-hover' : 'border border-neutral-200 text-neutral-400 line-through hover:bg-neutral-50'}`}
                          >
                            {on ? '✓ ' : ''}
                            {label}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </Td>
                <Td><Badge color={u.active ? 'green' : 'red'}>{u.active ? 'Active' : 'Deactivated'}</Badge></Td>
                <Td className="text-xs text-neutral-400">{formatDate(u.createdAt)}</Td>
                <Td>
                  <div className="flex justify-end gap-1">
                    {u.canManage === false ? (
                      <span className="px-2 py-1 text-xs text-neutral-400">Super Admin only</span>
                    ) : (
                    <>
                    <button onClick={() => { setEditUser(u); setFormOpen(true); }} className="rounded-md px-2 py-1 text-xs font-semibold text-brand-600 hover:bg-brand-50">
                      Edit
                    </button>
                    {u.id !== me?.id && (
                      <button
                        onClick={() => setToggleTarget(u)}
                        className={`flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold ${u.active ? 'text-brand-600 hover:bg-brand-50' : 'text-emerald-600 hover:bg-emerald-50'}`}
                      >
                        {u.active ? <><ShieldOff className="h-3.5 w-3.5" /> Deactivate</> : <><ShieldCheck className="h-3.5 w-3.5" /> Activate</>}
                      </button>
                    )}
                    {u.id !== me?.id && !u.isSuperAdmin && (
                      <button onClick={() => setDeleteTarget(u)} className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold text-red-600 hover:bg-red-50">
                        <Trash2 className="h-3.5 w-3.5" /> Delete
                      </button>
                    )}
                    </>
                    )}
                  </div>
                </Td>
              </tr>
            ))
          )}
        </TBody>
      </Table>

      <UserFormModal branches={branches} roles={rights.roles} me={me} open={formOpen} onClose={() => setFormOpen(false)} user={editUser} onSaved={load} />
      <ConfirmDialog
        open={!!toggleTarget}
        title={toggleTarget?.active ? 'Deactivate User' : 'Activate User'}
        message={
          toggleTarget?.active
            ? `Deactivate "${toggleTarget?.name}"? They will lose access immediately. Their historical activity is preserved.`
            : `Activate "${toggleTarget?.name}"? They will be able to log in again with their existing permissions.`
        }
        confirmLabel={toggleTarget?.active ? 'Deactivate' : 'Activate'}
        variant={toggleTarget?.active ? 'danger' : 'primary'}
        loading={toggling}
        onConfirm={handleToggleActive}
        onClose={() => setToggleTarget(null)}
      />
      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete User"
        message={`Delete "${deleteTarget?.name}" for good? They can no longer log in. Their sales and other history keep their name.`}
        confirmLabel="Delete"
        variant="danger"
        loading={deleting}
        onConfirm={handleDelete}
        onClose={() => setDeleteTarget(null)}
      />
    </div>
  );
}
