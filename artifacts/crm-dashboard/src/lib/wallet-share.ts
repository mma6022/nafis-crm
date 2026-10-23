/** Confirmation is prompted only after the server checks current requests. */
export async function requestWalletShare(customerId: number, input: { amountToman?: string; planId?: number; ignoreCreditRank?: boolean }) {
  const send = (confirmActiveRequest = false) => fetch(`/api/customers/${customerId}/wallet/share-links`, {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...input, confirmActiveRequest }),
  });
  let response = await send();
  let body = await response.json();
  if (response.status === 409 && body.error === 'active_share_link_exists') {
    if (!window.confirm('درخواست شارژ فعال یا نیازمند بررسی وجود دارد. لینک جدید، درخواست قبلی را لغو نمی‌کند و ممکن است هر دو پرداخت شوند. آیا برای پرداخت جدید لینک تازه می‌سازید؟')) return null;
    response = await send(true);
    body = await response.json();
  }
  if (!response.ok || !body.url) throw new Error(body.error || 'ساخت لینک شارژ انجام نشد.');
  return body as { url: string; amountToman: string };
}