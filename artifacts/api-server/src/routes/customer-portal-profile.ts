import { Router, type Request, type Response } from "express";
import { identityValueChanged, identityValuesChanged } from "../lib/identity-change";
import { createHash } from "node:crypto";
import { markPortalRegistration, claimInquiry, portalNewCustomerOwner, portalOwnerLogged } from "../lib/customer-portal-features";
import { customerPortalSession, requireCustomerPortal, updateCustomerPortalSessionCustomer } from "../lib/customer-portal-auth";
import { execute, executeChanges, queryRow, queryRows, runTransaction } from "../lib/crm-db";
import { normalizeCustomerNationalCode, normalizeCustomerMobile } from "../lib/customer-integrity";
import { normalizeDigits, validNationalCode } from "../lib/ics24";
import { verifyCustomer } from "../lib/sapi";
import { retainedIdentityChecks } from "../lib/identity-check-retention";
import { normalizeJalali, normalizePostal } from "../lib/customer-portal-validation";
import { customerPortalIdentityReady } from "../lib/customer-portal-identity";
import { OnboardCustomerPortalIdentityBody } from "@workspace/api-zod";

const router = Router();
router.use(requireCustomerPortal);

type PortalCustomer = {
  id: number;
  name: string;
  phone: string;
  national_code: string | null;
  birth_date_jalali: string | null;
  postal_code: string | null;
  father_name: string | null;
  verification_status: string | null;
  verification_checked_at: string | null;
  identity_changed_at: string | null;
  shahkar_ok: number | null;
  person_info_ok: number | null;
  postal_code_info_ok: number | null;
  sana_ok: number | null;
  shahkar_status: string | null;
  person_info_status: string | null;
  postal_code_info_status: string | null;
  sana_status: string | null;
  first_name: string | null;
  last_name: string | null;
  official_first_name: string | null;
  official_last_name: string | null;
};

const customerFields = `id,name,phone,national_code,birth_date_jalali,postal_code,
  father_name,verification_status,verification_checked_at,shahkar_ok,person_info_ok,
  postal_code_info_ok,sana_ok,identity_changed_at,shahkar_status,person_info_status,postal_code_info_status,sana_status,
  first_name,last_name,official_first_name,official_last_name`;

function findPortalCustomer(customerId: number): PortalCustomer | undefined {
  return queryRow<PortalCustomer>(
    `SELECT ${customerFields} FROM customers
     WHERE id=? AND merged_into_customer_id IS NULL`,
    [customerId],
  );
}

function safeProfile(customer: PortalCustomer) {
  return {
    id: Number(customer.id),
    name: customer.name,
    mobile: customer.phone,
    nationalCode: customer.national_code ?? null,
    birthDate: customer.birth_date_jalali ?? null,
    postalCode: customer.postal_code ?? null,
    fatherName: customer.father_name ?? null,
    firstName: customer.first_name?.trim() || customer.official_first_name || null,
    lastName: customer.last_name?.trim() || customer.official_last_name || null,
    verification: {
      status: customer.verification_status === "verified" ? "verified" : "unverified",
      checkedAt: customer.verification_checked_at ?? null,
      checks: {
        shahkarLite: Boolean(customer.shahkar_ok),
        personInfo: Boolean(customer.person_info_ok),
        postalCodeInfo: Boolean(customer.postal_code_info_ok),
        sana: Boolean(customer.sana_ok),
      },
    },
  };
}

function isComplete(customer: Pick<PortalCustomer, "name" | "national_code" | "birth_date_jalali" | "postal_code" | "father_name">): boolean {
  return Boolean(
    customer.name.trim() &&
    customer.national_code?.trim() &&
    customer.birth_date_jalali?.trim() &&
    customer.postal_code?.trim() &&
    customer.father_name?.trim(),
  );
}

router.get("/me", (req, res): void => {
  const session = customerPortalSession(res);
  if (!session) {
    res.status(401).json({ error: "Customer authentication required" });
    return;
  }
  const customer = session.customerId === null ? undefined : findPortalCustomer(session.customerId);
  const identityReady = customerPortalIdentityReady(customer);
  res.json({
    authenticated: true,
    mobile: session.mobile,
    mobileVerified: true,
    customer: customer && identityReady ? safeProfile(customer) : null,
    identityReady,
    profileComplete: customer ? isComplete(customer) : false,
    verificationStatus: customer?.verification_status === "verified" ? "verified" : "unverified",
  });
});

// OTP grants only a mobile-bound onboarding session. Provider-owned identity
// fields are written only after both identity and mobile ownership match.
router.post("/identity", async (req, res): Promise<void> => {
  const session = customerPortalSession(res)!;
  if (!OnboardCustomerPortalIdentityBody.safeParse(req.body).success) {
    res.status(400).json({ error: "invalid_identity", message: "کد ملی و تاریخ تولد شمسی معتبر را وارد کنید." }); return;
  }
  const nationalCode = typeof req.body?.nationalCode === "string"
    ? normalizeCustomerNationalCode(normalizeDigits(req.body.nationalCode)) : "";
  const birthDate = normalizeJalali(typeof req.body?.birthDate === "string" ? normalizeDigits(req.body.birthDate) : null);
  if (!validNationalCode(nationalCode) || !birthDate) {
    res.status(400).json({ error: "invalid_identity", message: "کد ملی معتبر و تاریخ تولد شمسی را وارد کنید." }); return;
  }
  const existing = session.customerId == null ? undefined : findPortalCustomer(session.customerId);
  if ((existing?.national_code && normalizeCustomerNationalCode(existing.national_code) !== nationalCode) ||
      hasIdentityConflict(existing?.id ?? null, nationalCode)) {
    res.status(409).json({ error: "identity_conflict", message: "این مشخصات با حساب مشتری سازگار نیست. برای بررسی با پشتیبانی تماس بگیرید." }); return;
  }
  if (existing && existing.birth_date_jalali && normalizeJalali(existing.birth_date_jalali) === birthDate &&
      [existing.shahkar_status, existing.person_info_status].some(status => status?.startsWith("manual_"))) {
    res.status(409).json({ error: "manual_identity_review", message: "پروندهٔ هویتی شما نیاز به تکمیل یا بررسی دستی دارد. با پشتیبانی تماس بگیرید." }); return;
  }
  const now = new Date().toISOString();
  let customerId: number;
  let attemptId: number;
  try {
    const reserved = runTransaction(() => {
      let id = existing?.id;
      if (id == null) {
        const owner = portalNewCustomerOwner();
        if (owner.salespersonId == null) throw new Error("NO_ACTIVE_SALESPERSON");
        id = execute(`INSERT INTO customers
          (name,phone,verification_status,is_urgent,created_at,salesperson_id,status,registered_by,registration_source)
          VALUES (?,?,'unverified',0,?,?,'in_progress',NULL,'portal')`,
          ["در انتظار احراز هویت", session.mobile.replace(/^\+98/, "0"), now, owner.salespersonId]);
        portalOwnerLogged(id, owner);
        markPortalRegistration(id);
        updateCustomerPortalSessionCustomer(req, id);
      }
      const attempts = queryRow<{ count: number; latest: string | null }>(
        `SELECT COUNT(*) AS count,MAX(created_at) AS latest FROM customer_portal_verification_events
         WHERE customer_id=? AND created_at>? AND status IN ('onboarding_pending','onboarding_verified','onboarding_failed')`,
        [id, new Date(Date.now() - 15 * 60_000).toISOString()],
      );
      if (Number(attempts?.count ?? 0) >= 5 || (attempts?.latest && Date.now() - Date.parse(attempts.latest) < 60_000)) {
        throw new Error("IDENTITY_RATE_LIMIT");
      }
      const attempt = execute(`INSERT INTO customer_portal_verification_events
        (customer_id,checks_json,canonical_json,status,created_at) VALUES (?,'{}',NULL,'onboarding_pending',?)`, [id, now]);
      return { id, attempt };
    });
    customerId = reserved.id;
    attemptId = reserved.attempt;
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    res.status(code === "IDENTITY_RATE_LIMIT" ? 429 : code === "NO_ACTIVE_SALESPERSON" ? 503 : 409)
      .json({ error: "identity_unavailable", message: code === "IDENTITY_RATE_LIMIT"
        ? "لطفاً یک دقیقه صبر کنید و سپس دوباره تلاش کنید."
        : "ثبت‌نام فعلاً امکان‌پذیر نیست؛ با پشتیبانی تماس بگیرید." });
    return;
  }
  const before = findPortalCustomer(customerId)!;
  const result = await verifyCustomer({ nationalCode, mobile: session.mobile, birthDateJalali: birthDate },
    {}, ["shahkarLite", "personInfo"]);
  const firstName = result.canonical.officialFirstName?.trim();
  const lastName = result.canonical.officialLastName?.trim();
  const fatherName = result.canonical.officialFatherName?.trim();
  const ready = result.checks.shahkarLite.ok && result.checks.personInfo.ok && !!firstName && !!lastName && !!fatherName;
  const checkedAt = new Date().toISOString();
  try {
    runTransaction(() => {
      const current = findPortalCustomer(customerId);
      if (!current || JSON.stringify(current) !== JSON.stringify(before) || hasIdentityConflict(customerId, nationalCode) ||
          normalizeCustomerMobile(current.phone) !== normalizeCustomerMobile(session.mobile) ||
          (current.national_code && normalizeCustomerNationalCode(current.national_code) !== nationalCode)) {
        throw new Error("IDENTITY_CHANGED");
      }
      // Also proves the original session has not been revoked during the calls.
      updateCustomerPortalSessionCustomer(req, customerId);
      executeChanges(`UPDATE customers SET shahkar_ok=?,person_info_ok=?,shahkar_status=?,person_info_status=?,
        verification_checked_at=?,verification_provider='sapi.ir',verification_version=COALESCE(verification_version,0)+1
        WHERE id=?`, [
        result.checks.shahkarLite.completed === false ? null : result.checks.shahkarLite.ok ? 1 : 0,
        result.checks.personInfo.completed === false ? null : result.checks.personInfo.ok ? 1 : 0,
        result.checks.shahkarLite.completed === false ? "unavailable" : result.checks.shahkarLite.ok ? "success" : "failed",
        result.checks.personInfo.completed === false ? "unavailable" : result.checks.personInfo.ok ? "success" : "failed",
        checkedAt, customerId,
      ]);
      if (ready) {
        const fullName = `${firstName} ${lastName}`;
        const changed = before.name !== fullName || before.father_name !== fatherName ||
          before.first_name !== firstName || before.last_name !== lastName ||
          before.national_code !== nationalCode || before.birth_date_jalali !== birthDate;
        // identity_changed_at only moves when an existing value is replaced, never when an empty field is filled.
        const identityStamp = changed && identityValuesChanged([
          [before.name, fullName], [before.father_name, fatherName], [before.first_name, firstName],
          [before.last_name, lastName], [before.national_code, nationalCode], [before.birth_date_jalali, birthDate],
        ]);
        executeChanges(`UPDATE customers SET name=?,first_name=?,last_name=?,father_name=?,
          official_first_name=?,official_last_name=?,official_father_name=?,national_code=?,birth_date_jalali=?,
          identity_changed_at=CASE WHEN ? THEN ? ELSE identity_changed_at END,
          verification_status=CASE WHEN ? THEN 'unverified' ELSE verification_status END,
          postal_code_info_ok=CASE WHEN ? THEN NULL ELSE postal_code_info_ok END,
          sana_ok=CASE WHEN ? THEN NULL ELSE sana_ok END,
          postal_code_info_status=CASE WHEN ? THEN NULL ELSE postal_code_info_status END,
          sana_status=CASE WHEN ? THEN NULL ELSE sana_status END
          WHERE id=?`, [fullName, firstName!, lastName!, fatherName!, firstName!, lastName!, fatherName!,
          nationalCode, birthDate, identityStamp ? 1 : 0, checkedAt, ...Array(5).fill(changed ? 1 : 0), customerId]);
        execute(`INSERT INTO customer_portal_profile_audit
          (customer_id,actor_mobile,old_values_json,new_values_json,created_at) VALUES (?,?,?,?,?)`,
          [customerId, session.mobile, JSON.stringify(before), JSON.stringify(findPortalCustomer(customerId)), checkedAt]);
      }
      executeChanges(`UPDATE customer_portal_verification_events SET checks_json=?,canonical_json=?,status=?,error_message=?
        WHERE id=?`, [JSON.stringify(result.checks), ready ? JSON.stringify(result.canonical) : null,
        ready ? "onboarding_verified" : "onboarding_failed", ready ? null : "identity_or_mobile_ownership_not_verified", attemptId]);
    });
  } catch {
    executeChanges("UPDATE customer_portal_verification_events SET status='onboarding_failed',error_message='identity_changed' WHERE id=?", [attemptId]);
    res.status(409).json({ error: "identity_changed", message: "اطلاعات یا نشست شما تغییر کرده است. دوباره وارد شوید." }); return;
  }
  const identityReady = customerPortalIdentityReady(findPortalCustomer(customerId));
  res.status(identityReady ? 200 : 422).json({
    identityReady, customerId,
    checks: { shahkarLite: { ok: result.checks.shahkarLite.ok }, personInfo: { ok: result.checks.personInfo.ok } },
    message: identityReady ? "احراز هویت با موفقیت انجام شد." : !result.checks.shahkarLite.ok
      ? "تطبیق مالکیت شماره همراه تأیید نشد یا سرویس پاسخ نداد. شماره باید به نام صاحب کد ملی باشد."
      : "استعلام مشخصات هویتی کامل نشد. کد ملی و تاریخ تولد را بررسی و دوباره تلاش کنید.",
  });
});

function normalizeName(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is required.`);
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length < 2 || normalized.length > 120 || /[\u0000-\u001f]/.test(normalized)) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}

function validatePortalProfile(body: unknown, existing?: PortalCustomer) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("A profile object is required.");
  const input = body as Record<string, unknown>;
  if (["mobile", "phone", "customerId", "customer_id", "salespersonId", "salesperson_id"].some((key) => key in input)) {
    throw new Error("Mobile number and customer ownership are server-controlled.");
  }
  const name = normalizeName(input.name ?? existing?.name, "Name");
  const fatherName = normalizeName(input.fatherName ?? existing?.father_name, "Father name");
  const rawNationalCode = input.nationalCode ?? existing?.national_code;
  if (typeof rawNationalCode !== "string") throw new Error("A valid national code is required.");
  const nationalCode = normalizeCustomerNationalCode(normalizeDigits(rawNationalCode));
  if (!validNationalCode(nationalCode)) throw new Error("A valid national code is required.");
  const rawBirthDate = input.birthDate ?? existing?.birth_date_jalali;
  const birthDate = normalizeJalali(typeof rawBirthDate === "string" ? rawBirthDate : null);
  if (!birthDate) throw new Error("A valid Jalali birth date is required.");
  const rawPostal = input.postalCode ?? existing?.postal_code;
  const postalCode = normalizePostal(typeof rawPostal === "string" ? rawPostal : null);
  if (!postalCode) throw new Error("A valid postal code is required.");
  return { name, fatherName, nationalCode, birthDate, postalCode };
}

function hasIdentityConflict(customerId: number | null, nationalCode: string): boolean {
  const active = queryRows<{ id: number; national_code: string | null }>(
    `SELECT id,national_code FROM customers
     WHERE merged_into_customer_id IS NULL AND COALESCE(status,'in_progress') <> 'cancelled'`,
  );
  return active.some((row) =>
    (customerId === null || Number(row.id) !== customerId) &&
    row.national_code != null &&
    normalizeCustomerNationalCode(row.national_code) === nationalCode &&
    validNationalCode(normalizeCustomerNationalCode(row.national_code)),
  );
}

router.patch("/profile", (req, res): void => {
  const session = customerPortalSession(res);
  if (!session) {
    res.status(401).json({ error: "Customer authentication required" });
    return;
  }
  const existing = session.customerId === null ? undefined : findPortalCustomer(session.customerId);
  if (session.customerId !== null && !existing) {
    res.status(409).json({ error: "Customer record is unavailable; contact support." });
    return;
  }
  let profile: ReturnType<typeof validatePortalProfile>;
  try {
    profile = validatePortalProfile(req.body, existing);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Profile data is invalid." });
    return;
  }
  if (hasIdentityConflict(existing?.id ?? null, profile.nationalCode)) {
    res.status(409).json({ error: "An active customer already has this national code." });
    return;
  }

  const now = new Date().toISOString();
  try {
    const customerId = runTransaction(() => {
      if (existing) {
        const oldValues = {
          name: existing.name,
          nationalCode: existing.national_code,
          birthDate: existing.birth_date_jalali,
          postalCode: existing.postal_code,
          fatherName: existing.father_name,
        };
        const identityChanged =
          existing.name !== profile.name ||
          normalizeCustomerNationalCode(existing.national_code ?? "") !== profile.nationalCode ||
          existing.birth_date_jalali !== profile.birthDate ||
          existing.postal_code !== profile.postalCode ||
          existing.father_name !== profile.fatherName;
        const identityStamp = identityChanged && identityValuesChanged([
          [existing.name, profile.name], [existing.national_code, profile.nationalCode],
          [existing.birth_date_jalali, profile.birthDate], [existing.postal_code, profile.postalCode],
          [existing.father_name, profile.fatherName],
        ]);
        executeChanges(
          `UPDATE customers SET name=?,national_code=?,birth_date_jalali=?,postal_code=?,father_name=?,
             verification_status=CASE WHEN ? THEN 'unverified' ELSE verification_status END,
             verification_checked_at=CASE WHEN ? THEN NULL ELSE verification_checked_at END,
             verification_version=CASE WHEN ? THEN COALESCE(verification_version,0)+1 ELSE verification_version END,
             verification_provider=CASE WHEN ? THEN NULL ELSE verification_provider END,
              identity_changed_at=CASE WHEN ? THEN ? ELSE identity_changed_at END,
             shahkar_status=CASE WHEN ? THEN NULL ELSE shahkar_status END,
             person_info_status=CASE WHEN ? THEN NULL ELSE person_info_status END,
             postal_code_info_status=CASE WHEN ? THEN NULL ELSE postal_code_info_status END,
             sana_status=CASE WHEN ? THEN NULL ELSE sana_status END,
             shahkar_ok=CASE WHEN ? THEN NULL ELSE shahkar_ok END,
             person_info_ok=CASE WHEN ? THEN NULL ELSE person_info_ok END,
             postal_code_info_ok=CASE WHEN ? THEN NULL ELSE postal_code_info_ok END,
             sana_ok=CASE WHEN ? THEN NULL ELSE sana_ok END
           WHERE id=? AND merged_into_customer_id IS NULL`,
          [
            profile.name, profile.nationalCode, profile.birthDate, profile.postalCode, profile.fatherName,
             ...Array.from({ length: 4 }, () => identityChanged ? 1 : 0),
             identityStamp ? 1 : 0,
             identityStamp ? now : null,
             ...Array.from({ length: 8 }, () => identityChanged ? 1 : 0),
            existing.id,
          ],
        );
        execute(
          `INSERT INTO customer_portal_profile_audit
             (customer_id,actor_mobile,old_values_json,new_values_json,created_at)
           VALUES (?,?,?,?,?)`,
          [existing.id, session.mobile, JSON.stringify(oldValues), JSON.stringify(profile), now],
        );
        return existing.id;
      }

      const owner = portalNewCustomerOwner();
      const salespersonId = owner.salespersonId;
      if (salespersonId === undefined) throw new Error("NO_ACTIVE_SALESPERSON");
      const phone = session.mobile.replace(/^\+98/, "0");
      const id = execute(
        `INSERT INTO customers
           (name,phone,description,national_code,birth_date_jalali,postal_code,father_name,
             verification_status,is_urgent,created_at,salesperson_id,priority,status,identity_changed_at,registered_by,registration_source)
         VALUES (?,?,NULL,?,?,?,?,'unverified',0,?,?,NULL,'in_progress',?,NULL,'portal')`,
        [profile.name, phone, profile.nationalCode, profile.birthDate, profile.postalCode, profile.fatherName, now, salespersonId, now],
      );
      portalOwnerLogged(id, owner);
      markPortalRegistration(id);
      execute(
        `INSERT INTO customer_portal_profile_audit
           (customer_id,actor_mobile,old_values_json,new_values_json,created_at)
         VALUES (?,?,'{}',?,?)`,
        [id, session.mobile, JSON.stringify(profile), now],
      );
      updateCustomerPortalSessionCustomer(req, id);
      return id;
    });
    const customer = findPortalCustomer(customerId);
    if (!customer) throw new Error("Created customer profile could not be loaded.");
    res.status(existing ? 200 : 201).json({
      customer: safeProfile(customer),
      profileComplete: isComplete(customer),
    });
  } catch (error) {
    if (error instanceof Error && ["NO_ACTIVE_SALESPERSON", "NO_DEFAULT_ALLOCATION_PROGRAM"].includes(error.message)) {
      res.status(503).json({ error: "Customer registration is temporarily unavailable because no active salesperson is assigned." });
      return;
    }
    if (error instanceof Error && (error.message.includes("ACTIVE_CUSTOMER_") || error.message.includes("UNIQUE constraint failed"))) {
      res.status(409).json({ error: "An active customer already has this mobile or national code." });
      return;
    }
    throw error;
  }
});

function verificationSnapshot(customer: PortalCustomer) {
  return JSON.stringify({
    phone: customer.phone,
    name: customer.name,
    nationalCode: customer.national_code,
    birthDate: customer.birth_date_jalali,
    postalCode: customer.postal_code,
    fatherName: customer.father_name,
    verificationStatus: customer.verification_status,
    verificationCheckedAt: customer.verification_checked_at,
    checkFlags: [customer.shahkar_ok, customer.person_info_ok, customer.postal_code_info_ok, customer.sana_ok],
  });
}

export async function verifyPortalCustomer(req: Request, res: Response): Promise<void> {
  const session = customerPortalSession(res);
  const customer = session?.customerId == null ? undefined : findPortalCustomer(session.customerId);
  if (!session || !customer) {
    res.status(409).json({ status: "pending", error: "Complete your customer profile before identity verification." });
    return;
  }
  if (customer.verification_status === "verified" &&
      [customer.shahkar_ok, customer.person_info_ok, customer.postal_code_info_ok, customer.sana_ok].every(ok => ok === 1)) {
    res.json({ customerId: customer.id, status: "verified", checks: retainedIdentityChecks(customer, {
      nationalCode: customer.national_code ?? "", mobile: customer.phone,
      birthDateJalali: customer.birth_date_jalali, postalCode: customer.postal_code,
    }), error: null });
    return;
  }
  if (!isComplete(customer) || !customer.national_code || !customer.birth_date_jalali || !customer.postal_code) {
    res.status(200).json({ customerId: customer.id, status: "pending", checks: null, error: "Complete all profile fields before verification." });
    return;
  }

  const input = {
    nationalCode: customer.national_code,
    mobile: customer.phone,
    birthDateJalali: customer.birth_date_jalali,
    postalCode: customer.postal_code,
    name: customer.name,
    fatherName: customer.father_name,
  };
  const snapshot = verificationSnapshot(customer);
  const now = new Date().toISOString();
  const retained = retainedIdentityChecks(customer, input, true);
  if (!customerPortalIdentityReady(customer)) {
    res.status(403).json({error:"identity_verification_required"}); return;
  }
  if (!queryRow("SELECT 1 FROM loan_filing_fee_charges WHERE customer_id=? LIMIT 1", [customer.id])) {
    res.status(422).json({error:"filing_fee_required",message:"ابتدا هزینهٔ ثابت طرح انتخاب‌شده را تکمیل کنید."}); return;
  }
  const key=createHash("sha256").update(JSON.stringify(input)).digest("hex");
  const claim=claimInquiry(customer.id,key);
  if(claim.cached){res.json(claim.cached);return;}
  if(!claim.claimed){
    res.json({customerId:customer.id,status:"pending",checks:retained,error:"نتیجهٔ این استعلام هنوز قطعی نیست. برای پیگیری با کارشناس تماس بگیرید."});return;
  }
  const completeClaim=(response:unknown,completed:boolean,canonicalApplied=false) => runTransaction(()=>{
    const at=new Date().toISOString(),status=completed?"completed":"unknown",encoded=JSON.stringify(response);
    executeChanges("UPDATE customer_portal_inquiry_claims SET status=?,response_json=?,updated_at=? WHERE customer_id=? AND identity_key=?",
      [status,encoded,at,customer.id,key]);
    // Official normalization must not turn an already attempted paid inquiry
    // into a fresh request. Do not alias failures caused by concurrent edits.
    if(canonicalApplied){
      const c=queryRow<any>("SELECT * FROM customers WHERE id=?",[customer.id]);
      const canonicalKey=createHash("sha256").update(JSON.stringify({nationalCode:c.national_code,mobile:c.phone,
        birthDateJalali:c.birth_date_jalali,postalCode:c.postal_code,name:c.name,fatherName:c.father_name})).digest("hex");
      if(canonicalKey!==key)executeChanges(`INSERT OR IGNORE INTO customer_portal_inquiry_claims
        (customer_id,identity_key,status,response_json,updated_at) VALUES(?,?,?,?,?)`,[customer.id,canonicalKey,status,encoded,at]);
    }
  });
  try {
    const result = await verifyCustomer(input, retained);
    const verified = result.status === "verified" &&
      Object.values(result.checks).every((check) => check.ok);
    const publicChecks = Object.fromEntries(
      Object.entries(result.checks).map(([key, check]) => [
        key,
        { ok: check.ok, completed:check.completed!==false, providerStatus: check.completed===false ? "unavailable" : check.providerStatus?.startsWith("manual_") ? check.providerStatus : check.ok ? "success" : "failed" },
      ]),
    );
    runTransaction(() => {
      const current = findPortalCustomer(customer.id);
      if (!current || verificationSnapshot(current) !== snapshot) {
        throw new Error("Customer verification state changed while checks were running.");
      }
      executeChanges(
        `UPDATE customers SET verification_status=?,verification_checked_at=?,
           verification_version=COALESCE(verification_version,0)+1,verification_provider='sapi.ir',
           shahkar_status=?,person_info_status=?,postal_code_info_status=?,sana_status=?,
           shahkar_ok=?,person_info_ok=?,postal_code_info_ok=?,sana_ok=?,
           first_name=COALESCE(?,first_name),last_name=COALESCE(?,last_name),
           name=COALESCE(?,name),father_name=COALESCE(?,father_name),
           address=COALESCE(?,address),postal_code=COALESCE(?,postal_code),
           official_first_name=COALESCE(?,official_first_name),
           official_last_name=COALESCE(?,official_last_name),
           official_father_name=COALESCE(?,official_father_name),
           official_address=COALESCE(?,official_address),
           official_postal_code=COALESCE(?,official_postal_code)
         WHERE id=?`,
        [
          verified ? "verified" : "unverified",
          now,
          ...[result.checks.shahkarLite,result.checks.personInfo,result.checks.postalCodeInfo,result.checks.sana]
            .map(check=>check.completed===false?"unavailable":check.providerStatus?.startsWith("manual_")?check.providerStatus:check.ok?"success":"failed"),
          ...[result.checks.shahkarLite,result.checks.personInfo,result.checks.postalCodeInfo,result.checks.sana]
            .map(check=>check.completed===false?null:check.ok?1:0),
          result.canonical.officialFirstName ?? null,
          result.canonical.officialLastName ?? null,
          [result.canonical.officialFirstName, result.canonical.officialLastName].filter(Boolean).join(" ") || null,
          result.canonical.officialFatherName ?? null,
          result.canonical.officialAddress ?? null,
          result.canonical.officialPostalCode ?? null,
          result.canonical.officialFirstName ?? null,
          result.canonical.officialLastName ?? null,
          result.canonical.officialFatherName ?? null,
          result.canonical.officialAddress ?? null,
          result.canonical.officialPostalCode ?? null,
          customer.id,
        ],
      );
      if (result.canonical.officialPostalCode != null &&
          identityValueChanged(current.postal_code, result.canonical.officialPostalCode)) {
        executeChanges("UPDATE customers SET identity_changed_at=? WHERE id=?", [now, customer.id]);
      }
      execute(
        `INSERT INTO customer_portal_verification_events
           (customer_id,checks_json,canonical_json,status,error_message,created_at)
         VALUES (?,?,?,?,?,?)`,
        [customer.id, JSON.stringify(result.checks), JSON.stringify(result.canonical), verified ? "verified" : "failed", verified ? null : result.error ?? "SAPI identity checks failed", now],
      );
    });
    const completed=Object.values(result.checks).every(check=>check.completed!==false);
    const response={
      customerId: customer.id,
      status: verified ? "verified" : completed ? "error" : "pending",
      checks: publicChecks,
      checkedAt: now,
      error: verified ? null : "Identity verification did not pass all required checks.",
    };
    completeClaim(response,completed,true);
    res.status(200).json(response);
  } catch (error) {
    if (error instanceof Error && error.message.includes("verification state changed")) {
      res.status(409).json({ status: "pending", error: "Customer profile changed while identity checks were running; retry verification." });
      return;
    }
    const failedChecks = {
      shahkarLite: retained.shahkarLite ?? { ok: false, providerStatus: "unavailable" },
      personInfo: retained.personInfo ?? { ok: false, providerStatus: "unavailable" },
      postalCodeInfo: retained.postalCodeInfo ?? { ok: false, providerStatus: "unavailable" },
      sana: retained.sana ?? { ok: false, providerStatus: "unavailable" },
    };
    try {
      runTransaction(() => {
        const current = findPortalCustomer(customer.id);
        if (!current || verificationSnapshot(current) !== snapshot) {
          throw new Error("Customer verification state changed while checks were running.");
        }
        executeChanges(
          `UPDATE customers SET verification_status='unverified',verification_checked_at=?,
             verification_provider='sapi.ir',shahkar_status=?,person_info_status=?,
             postal_code_info_status=?,sana_status=?,shahkar_ok=?,
             person_info_ok=?,postal_code_info_ok=?,sana_ok=? WHERE id=?`,
          [now, ...Object.values(failedChecks).map(check => check.providerStatus ?? "unavailable"),
            ...Object.values(failedChecks).map(check => check.ok ? 1 : 0), customer.id],
        );
        execute(
          `INSERT INTO customer_portal_verification_events
             (customer_id,checks_json,canonical_json,status,error_message,created_at)
           VALUES (?, ?, NULL, 'failed', 'SAPI verification unavailable', ?)`,
          [customer.id, JSON.stringify(failedChecks), now],
        );
      });
    } catch {
      // Return an explicit unavailable state without leaking provider or database details.
    }
    const response={
      customerId: customer.id,
      status: "pending",
      checks: failedChecks,
      checkedAt: now,
      error: "Identity verification is currently unavailable.",
    };
    completeClaim(response,false);
    res.status(200).json(response);
  }
}

router.post("/verify", verifyPortalCustomer);
export default router;