/**
 * Lead submission. TODO(spec/CRM): the CRM has no public "create lead" endpoint yet.
 * Set PUBLIC_LEAD_ENDPOINT at build time to enable real submission; until then submitLead()
 * resolves with { preview: true } and the UI says so (it never pretends the request was sent).
 */
export type LeadPayload = {
  loanType: string;
  amount: string;
  months: string;
  planId?: number;
  fullName: string;
  mobile: string;
  city: string;
  source: string;
};

export async function submitLead(p: LeadPayload): Promise<{ preview: boolean }> {
  const endpoint = import.meta.env.PUBLIC_LEAD_ENDPOINT as string | undefined;
  if (!endpoint) {
    await new Promise((r) => setTimeout(r, 400));
    return { preview: true };
  }
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(p),
  });
  if (!res.ok) throw new Error(String(res.status));
  return { preview: false };
}
