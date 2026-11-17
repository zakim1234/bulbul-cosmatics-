// How a person is named on a correction they made, with their role, so
// whoever made the original sees who changed it: "Super Admin Owner",
// "Admin Cabdi", "Manager Asha", or just the name for anyone else.
export function whoLabel(user) {
  if (!user) return '';
  const name = user.name || '';
  if (user.isSuperAdmin) return `Super Admin ${name}`.trim();
  if (user.role === 'admin') return `Admin ${name}`.trim();
  if (user.role === 'manager') return `Manager ${name}`.trim();
  return name;
}
