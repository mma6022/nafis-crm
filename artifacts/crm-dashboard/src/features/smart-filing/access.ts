/** Who sees ثبت هوشمند in the UI (mirrors the server-side scope in api-server lib/smart-filing.ts; the server is the real gate). */
export const SF_TRAINEE_SALESPERSON_IDS: readonly number[] = [5, 19, 20]; // کارآموزها
export type SfScope = 'admin' | 'registrar' | 'sales' | null;
export function sfScope(user: { role?: string | null; salespersonId?: number | null } | null | undefined): SfScope {
  if (!user) return null;
  if (user.role === 'admin') return 'admin';
  if (user.role === 'registrar') return 'registrar';
  if (user.role === 'salesperson' && user.salespersonId && !SF_TRAINEE_SALESPERSON_IDS.includes(user.salespersonId)) return 'sales';
  return null;
}
