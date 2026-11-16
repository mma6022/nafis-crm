// Only loaded by the isolated Instagram/Manychat fixture, never by the live API.
import { randomUUID } from "node:crypto";

const originalFetch = globalThis.fetch;
let lastPreparedModelMarker = null;
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url === "https://api.manychat.com/fb/page/getInfo") {
    await new Promise((resolve) => setTimeout(resolve, 120));
    const authorization = init?.headers?.Authorization;
    const valid = authorization === "Bearer synthetic-valid-manychat-api-token";
    const nullPage = ["Bearer synthetic-null-page-manychat-token-a",
      "Bearer synthetic-null-page-manychat-token-b",
      "Bearer synthetic-null-page-manychat-token-c"].includes(authorization);
    const missingPage = authorization === "Bearer synthetic-missing-page-manychat-token";
    return new Response(JSON.stringify(valid
      ? { status: "success", data: { id: "fixture-page-1" } }
      : nullPage ? { status: "success", data: { id: null, name: "Synthetic account" } }
      : missingPage ? { status: "success", data: {} }
      : { status: "error" }), {
      status: valid || nullPage || missingPage ? 200 : 401, headers: { "Content-Type": "application/json" },
    });
  }
  if (url === "https://api.manychat.com/fb/sending/sendContent") {
    const body = JSON.parse(init?.body ?? "{}");
    if (process.env.INSTAGRAM_MULTIMESSAGE_NOTIFY_URL) {
      const text = body.data?.content?.messages?.[0]?.text ?? "";
      const control = await originalFetch(
        `${process.env.INSTAGRAM_MULTIMESSAGE_NOTIFY_URL}?text=${encodeURIComponent(text)}`,
      );
      const action = (await control.json().catch(() => ({}))).action;
      if (action === "429") {
        return new Response(JSON.stringify({ status: "error" }), {
          status: 429, headers: { "Content-Type": "application/json" },
        });
      }
      if (action === "uncertain") throw new Error("synthetic_network_outcome_uncertain");
      if (action === "wait") {
        await originalFetch(`${process.env.INSTAGRAM_MULTIMESSAGE_NOTIFY_URL}/release`);
      }
    }
    if (lastPreparedModelMarker === "SYNTHETIC_NAME_MARKER") {
      const notifyUrl = process.env.INSTAGRAM_FIXTURE_NOTIFY_URL;
      if (notifyUrl) {
        await originalFetch(`${notifyUrl}?marker=${encodeURIComponent("API_SEND:SYNTHETIC_NAME_MARKER")}`).catch(() => undefined);
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    lastPreparedModelMarker = null;
    return new Response(JSON.stringify({ status: "success", message_id: `synthetic-outbound-${randomUUID()}` }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }
  if (url.includes("/chat/completions")) {
    const body = JSON.parse(init?.body ?? "{}");
    const serialized = JSON.stringify(body);
    const systemPrompt = body.messages?.find((message) => message.role === "system")?.content ?? "";
    // Identity intake deliberately sees only user-posted DM text, not CRM
    // context. Its isolated fixture exercises evidence selections; legacy
    // transport cases keep their deterministic captures without AI additions.
    if (systemPrompt.startsWith("You extract sender identity from Persian Instagram")) {
      if (serialized.includes("Synthetic Internal Note") ||
        serialized.includes("synthetic-template-id")) {
        return new Response(JSON.stringify({ error: "fixture_private_intake_context" }), { status: 400 });
      }
      return new Response(JSON.stringify({
        choices: [{ finish_reason: "stop", message: {
          role: "assistant", content: JSON.stringify({ nameEvidence: [], phoneEvidence: [] }),
        } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const planContext = systemPrompt.match(/<loan_plans>(.*?)<\/loan_plans>/s)?.[1];
    let plans;
    try {
      plans = JSON.parse(planContext ?? "null");
    } catch {
      plans = null;
    }
    const expectedPlanKeys = [
      "customerCollateral", "customerDocuments", "guarantorCollateral",
      "guarantorDocuments", "guarantorRequired", "name", "options",
    ];
    const expectedOptionKeys = [
      "customerCollateral", "customerPayout", "guarantorCollateral",
      "guarantorRequired", "installmentAmount", "installmentCount",
    ];
    const plan = Array.isArray(plans) ? plans[0] : null;
    const option = plan?.options?.[0];
    const guardFailures = [];
    if (!Array.isArray(plans) || plans.length !== 1) guardFailures.push("plan_count");
    if (!plan || JSON.stringify(Object.keys(plan).sort()) !== JSON.stringify(expectedPlanKeys)) {
      guardFailures.push("plan_keys");
    }
    if (!option ||
      JSON.stringify(Object.keys(option).sort()) !== JSON.stringify(expectedOptionKeys)) {
      guardFailures.push("option_keys");
    }
    if (plan?.name !== "Synthetic Public Loan") guardFailures.push("plan_name");
    if (option?.installmentCount !== 12) guardFailures.push("installment_count");
    if (option?.customerPayout !== 90_000_000) guardFailures.push("customer_payout");
    if (option?.installmentAmount !== null) guardFailures.push("installment_amount");
    if (JSON.stringify(plan?.customerDocuments) !== JSON.stringify(["مدرک شغلی"])) {
      guardFailures.push("customer_documents");
    }
    if (plan?.guarantorDocuments !== null) guardFailures.push("guarantor_documents");
    if (plan?.guarantorRequired !== false || option?.guarantorRequired !== false) {
      guardFailures.push("guarantor_required");
    }
    if (plan?.customerCollateral !== null || plan?.guarantorCollateral !== null ||
      option?.customerCollateral !== null || option?.guarantorCollateral !== null) {
      guardFailures.push("collateral");
    }
    if (serialized.includes('"templateId"') || serialized.includes('"id":1')) {
      guardFailures.push("internal_identifiers");
    }
    if (guardFailures.length) {
      console.error("[synthetic-manychat-mock] allowlisted_plan_context_guard_failed", guardFailures);
      return new Response(JSON.stringify({
        error: "fixture_allowlisted_plan_context_missing",
        failures: guardFailures,
      }), { status: 400 });
    }
    for (const forbidden of [
      "سارا احمدی", "09123456789", "09122223333", "Synthetic Internal Note", "synthetic-template-id",
      "Synthetic Bank", "Synthetic Platform", "PRIVATE_INTEREST_MARKER", "Synthetic Private Job",
      "fixture_internal_document_id", "guarantee_check", "bankName", "platformName",
      "annualInterest", "customerJobs", "conditions", "needsGuarantor",
      "مريم  يوسفي", "مریم یوسفی", "آرش کریمی", "آرش  كريمي", "نرگس یوسفی", "نرگس‌  يوسفي",
    ]) {
      if (serialized.includes(forbidden)) return new Response(JSON.stringify({ error: "fixture_private_context_leak" }), { status: 400 });
    }
    const history = body.messages ?? [];
    const latestUser = [...history].reverse().find((message) => message.role === "user")?.content ?? "";
    const marker = latestUser.match(/SYNTHETIC_[A-Z0-9_]+/)?.[0] ?? "SYNTHETIC_UNMARKED";
    if (marker === "SYNTHETIC_FLOW_SECOND" && !serialized.includes("SYNTHETIC_FLOW_FIRST")) {
      return new Response(JSON.stringify({ error: "fixture_thread_history_missing" }), { status: 400 });
    }
    const notifyUrl = process.env.INSTAGRAM_FIXTURE_NOTIFY_URL;
    if (notifyUrl) {
      await originalFetch(`${notifyUrl}?marker=${encodeURIComponent(marker)}`).catch(() => undefined);
      if (marker === "SYNTHETIC_FORGED_ANSWER" &&
        body.messages?.some((message) =>
          message.role === "system" && message.content.includes("هیچ متن پاسخ یا واقعیت مالی تولید نکن"))) {
        await originalFetch(`${notifyUrl}?marker=${encodeURIComponent("SYNTHETIC_FORGED_ANSWER_REGENERATED")}`).catch(() => undefined);
      }
    }
    if (marker === "SYNTHETIC_MODEL_TIMEOUT" || marker === "SYNTHETIC_NAME_MARKER" ||
      marker === "SYNTHETIC_MODE_RACE" ||
      marker === "SYNTHETIC_DISABLE_RACE" || marker === "SYNTHETIC_PAUSE_RACE" ||
      marker === "SYNTHETIC_LATEST_RACE" || marker === "SYNTHETIC_API_ROTATE_RACE" ||
      marker === "SYNTHETIC_FLOW_ROTATE_RACE") {
      await new Promise((resolve) => setTimeout(resolve, marker === "SYNTHETIC_MODEL_TIMEOUT" ? 1_800 : 600));
    }
    if (marker === "SYNTHETIC_MODEL_ERROR") {
      return new Response(JSON.stringify({ error: "synthetic provider failure" }), { status: 503 });
    }
    lastPreparedModelMarker = marker;
    let selection;
    if (marker === "SYNTHETIC_OFFTOPIC") {
      selection = { kind: "redirect" };
    } else if (marker === "SYNTHETIC_TRUST") {
      selection = { kind: "trust" };
    } else if (marker === "SYNTHETIC_LATEST_RACE") {
      selection = { kind: "advice", planName: plans[0].name, fields: ["customerPayout"] };
    } else if (marker === "SYNTHETIC_LATEST_NEW") {
      selection = { kind: "advice", planName: plans[0].name, fields: ["installments"] };
    } else if (marker === "SYNTHETIC_FORGED_ANSWER") {
      selection = {
        kind: "advice",
        planName: plans[0].name,
        answer: "Synthetic Bank promises 75% interest approval; credit rank and provider details are verified.",
      };
    } else if (marker === "SYNTHETIC_OVERSIZE_RESPONSE") {
      selection = { kind: "advice", planName: plans[0].name, answer: "x".repeat(1_100) };
    } else {
      selection = { kind: "advice", planName: plans[0].name };
    }
    const content = marker === "SYNTHETIC_EMPTY_RESPONSE" ? "" : JSON.stringify(selection);
    return new Response(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { role: "assistant", content } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  return originalFetch(input, init);
};