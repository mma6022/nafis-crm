/* t878 گزارش مشتریان: flag.customer_segments_v1. While the flag is OFF the server answers enabled:false / 404. */
import { useQuery } from '@tanstack/react-query';

const base = () => (import.meta.env.BASE_URL || '/').replace(/\/$/, '');

export type SegmentsMe = { enabled: boolean; flag: string; canView: boolean; canExport: boolean; scope?: 'all' | 'own' | null; salespersonId?: number | null };
export type FieldOpt = { value: string; label: string };
export type FieldCat = {
  key: string; label: string; group: string; type: string;
  ops: string[]; options?: FieldOpt[]; defaultColumn?: boolean;
  sensitive?: 'phone' | 'national'; description?: string;
};
export type Condition = { field: string; op: string; values?: string[]; min?: string; max?: string };
export type SegmentQuery = { source: 'both' | 'file' | 'site'; includeUnlinkedLeads?: boolean; conditions: Condition[]; columns?: string[] };
export type PublicRow = {
  kind: 'customer' | 'unlinked_lead'; customerId: number | null; leadKey: string;
  values: Record<string, string>; sources: Record<string, string>; sourceLabels: Record<string, string>;
};
export type Preview = { total: number; page: number; pageSize: number; columns: string[]; rows: PublicRow[]; scope?: 'all' | 'own' };
export type Meta = { groups: Array<{ id: string; label: string }>; fields: FieldCat[]; owners: FieldOpt[]; tags: Array<{ tag: string; label: string }>; scope?: 'all' | 'own' };

export function useSegmentsMe(enabled: boolean) {
  return useQuery<SegmentsMe>({
    queryKey: ['customer-segments-me'], enabled, retry: false, staleTime: 60_000,
    queryFn: async () => {
      const r = await fetch(`${base()}/api/customer-segments/me`, { credentials: 'include' });
      if (!r.ok) return { enabled: false, flag: 'flag.customer_segments_v1', canView: false, canExport: false };
      return (await r.json()) as SegmentsMe;
    },
  });
}

export async function fetchMeta(): Promise<Meta> {
  const r = await fetch(`${base()}/api/customer-segments/meta`, { credentials: 'include' });
  if (!r.ok) throw new Error(r.status === 404 ? 'این گزارش فعلاً فعال نیست.' : r.status === 403 ? 'این گزارش فقط برای مدیر، مدیر فروش و کارشناس است.' : 'خواندن فهرست فیلدها ممکن نشد.');
  return r.json() as Promise<Meta>;
}

export async function fetchPreview(q: SegmentQuery, page = 1, pageSize = 20): Promise<Preview> {
  const r = await fetch(`${base()}/api/customer-segments/preview`, {
    method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...q, page, pageSize }),
  });
  if (!r.ok) throw new Error(r.status === 404 ? 'این گزارش فعلاً فعال نیست.' : r.status === 403 ? 'این گزارش فقط برای مدیر، مدیر فروش و کارشناس است.' : 'پیش‌نمایش ساخته نشد.');
  return r.json() as Promise<Preview>;
}

export async function downloadExport(q: SegmentQuery, includePhones: boolean): Promise<void> {
  const r = await fetch(`${base()}/api/customer-segments/export`, {
    method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...q, includePhones }),
  });
  if (!r.ok) {
    const data = await r.json().catch(() => null) as { message?: string } | null;
    const msg = data && typeof data.message === 'string' ? data.message : '';
    throw new Error(r.status === 404 ? 'این گزارش فعلاً فعال نیست.' : r.status === 403 ? (msg || 'فقط مشتری‌های خودتان را می‌توانید ببینید یا خروجی بگیرید.') : 'خروجی اکسل ساخته نشد.');
  }
  const blob = await r.blob();
  const cd = r.headers.get('content-disposition') || '';
  const m = /filename="([^"]+)"/.exec(cd);
  const name = m?.[1] || 'gozaresh-moshtarian.xlsx';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}
