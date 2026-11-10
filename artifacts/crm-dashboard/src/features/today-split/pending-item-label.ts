/** Short Persian word shown under the existing «منتظر» label on a Today file card. */
export function pendingItemLabel(key: string | null | undefined): string | null {
  if (key == null || key === "") return null;
  if (key === "collateral") return "وثیقه";
  if (key === "guarantor") return "ضامن";
  return "مورد دیگر";
}
