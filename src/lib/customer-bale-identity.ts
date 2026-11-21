/**
 * Production hook for the t866 identity steps flag.
 * Calls the existing SAPI personInfo path only. Tests must pass a mock identityFn
 * and must never go through this function.
 */
import { queryRow } from "./crm-db";
import { verifyCustomer } from "./sapi";

export async function cbRunIdentityInquiry(
  nationalId: string,
  birthJalali: string,
  customerId: number,
): Promise<"ok" | "wait" | "fail"> {
  try {
    const cust = queryRow("SELECT phone FROM customers WHERE id=?", [customerId]) as { phone?: string } | undefined;
    const mobile = String(cust?.phone ?? "").replace(/\D/g, "") || "09000000000";
    const result = await verifyCustomer(
      { nationalCode: nationalId, birthDateJalali: birthJalali, mobile },
      {},
      ["personInfo"],
    );
    if (result.status === "verified") return "ok";
    if (result.providerNoCredit) return "wait";
    return "wait";
  } catch {
    return "wait";
  }
}

export function cbMakeIdentityFn(customerId: number): (nationalId: string, birth: string) => Promise<"ok" | "wait" | "fail"> {
  return (nationalId, birth) => cbRunIdentityInquiry(nationalId, birth, customerId);
}
