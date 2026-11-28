/* t992: Enter sends in the Bale inbox composer; Shift+Enter / touch Enter insert a newline.
   node --experimental-strip-types scripts/t992-bale-enter-send-fixture.mjs */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { baleComposerEnterAction, handleBaleComposerEnter, isImeComposing } from "../src/features/bale-bot/composer-enter.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const src = (p) => readFileSync(join(root, p), "utf8");
let n = 0; const ok = (name, fn) => { fn(); n++; console.log("  ok ", name); };

const ev = (over = {}) => ({ key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false, isComposing: false, keyCode: 13, ...over });

ok("desktop Enter sends when canSend", () => {
  assert.equal(baleComposerEnterAction(ev(), { coarsePointer: false, canSend: true }), "send");
});
ok("Shift+Enter is a newline on desktop", () => {
  assert.equal(baleComposerEnterAction(ev({ shiftKey: true }), { coarsePointer: false, canSend: true }), "newline");
});
ok("empty / busy / whitespace does not send; Enter is swallowed (no newline)", () => {
  assert.equal(baleComposerEnterAction(ev(), { coarsePointer: false, canSend: false }), "ignore");
  let prevented = 0, sent = 0;
  handleBaleComposerEnter({ ...ev(), preventDefault() { prevented++; } }, { coarsePointer: false, canSend: false }, () => { sent++; });
  assert.equal(prevented, 1); assert.equal(sent, 0);
});
ok("IME composition (isComposing / keyCode 229) does not send or preventDefault", () => {
  assert.equal(isImeComposing(ev({ isComposing: true })), true);
  assert.equal(isImeComposing(ev({ keyCode: 229 })), true);
  assert.equal(isImeComposing(ev({ nativeEvent: { isComposing: true } })), true);
  assert.equal(baleComposerEnterAction(ev({ isComposing: true }), { coarsePointer: false, canSend: true }), "ignore");
  assert.equal(baleComposerEnterAction(ev({ keyCode: 229 }), { coarsePointer: false, canSend: true }), "ignore");
  let prevented = 0, sent = 0;
  handleBaleComposerEnter({ ...ev({ isComposing: true }), preventDefault() { prevented++; } }, { coarsePointer: false, canSend: true }, () => { sent++; });
  assert.equal(prevented, 0); assert.equal(sent, 0);
});
ok("touch / coarse pointer: plain Enter is a newline; Ctrl/Cmd+Enter still sends", () => {
  assert.equal(baleComposerEnterAction(ev(), { coarsePointer: true, canSend: true }), "newline");
  assert.equal(baleComposerEnterAction(ev({ shiftKey: true }), { coarsePointer: true, canSend: true }), "newline");
  assert.equal(baleComposerEnterAction(ev({ ctrlKey: true }), { coarsePointer: true, canSend: true }), "send");
  assert.equal(baleComposerEnterAction(ev({ metaKey: true }), { coarsePointer: true, canSend: true }), "send");
});
ok("Ctrl/Cmd+Enter sends on desktop too; other keys are ignored", () => {
  assert.equal(baleComposerEnterAction(ev({ ctrlKey: true }), { coarsePointer: false, canSend: true }), "send");
  assert.equal(baleComposerEnterAction({ key: "a" }, { coarsePointer: false, canSend: true }), "ignore");
  assert.equal(baleComposerEnterAction({ key: "Escape" }, { coarsePointer: false, canSend: true }), "ignore");
});
ok("handle: desktop Enter preventDefault + send", () => {
  let prevented = 0, sent = 0;
  const action = handleBaleComposerEnter({ ...ev(), preventDefault() { prevented++; } }, { coarsePointer: false, canSend: true }, () => { sent++; });
  assert.equal(action, "send"); assert.equal(prevented, 1); assert.equal(sent, 1);
});
ok("handle: Shift+Enter does not preventDefault (newline)", () => {
  let prevented = 0, sent = 0;
  const action = handleBaleComposerEnter({ ...ev({ shiftKey: true }), preventDefault() { prevented++; } }, { coarsePointer: false, canSend: true }, () => { sent++; });
  assert.equal(action, "newline"); assert.equal(prevented, 0); assert.equal(sent, 0);
});

const inbox = src("features/bale-bot/BaleBotInbox.tsx");
ok("both live composers (full-height and legacy) use the shared handler and data-enter-send", () => {
  assert.match(inbox, /import \{ handleBaleComposerEnter \} from '\.\/composer-enter'/);
  assert.equal([...inbox.matchAll(/onKeyDown=\{onComposerKey\} data-enter-send="1"/g)].length, 2);
  assert.doesNotMatch(inbox, /e\.key === 'Enter' && \(e\.ctrlKey \|\| e\.metaKey\)/);
  assert.match(inbox, /pointer: coarse/);
  assert.match(inbox, /sendingRef\.current/);
});
ok("disabled composers are unchanged (no enter-send hook)", () => {
  const disabled = inbox.match(/placeholder="پیام بنویسید" disabled[^>]*>/g) ?? [];
  assert.ok(disabled.length >= 2, disabled);
  for (const t of disabled) assert.doesNotMatch(t, /onKeyDown|data-enter-send/);
});
ok("quick-reply / canned / tray popups still do not bind Enter to send", () => {
  const tray = src("features/bale-workspace/Tray.tsx");
  const ready = src("features/quick-replies/ChatReady.tsx");
  const readyTray = src("features/quick-replies/ReadyTray.tsx");
  for (const t of [tray, ready, readyTray]) {
    assert.match(t, /Escape/);
    assert.doesNotMatch(t, /e\.key === 'Enter'/);
  }
  // canned list fills the composer on click, does not send
  assert.match(inbox, /onClick=\{\(\) => \{ setText\(b\); setPop\(null\); \}\}/);
});
ok("staff chat / other composers were not edited", () => {
  for (const f of ["chat/ChatPane.tsx", "chat/FloatingChat.tsx", "internal-chat/InternalChatPage.tsx", "features/assistant/AssistantDock.tsx"]) {
    assert.doesNotMatch(src(f), /handleBaleComposerEnter|data-enter-send|composer-enter/);
  }
});

console.log(`t992-bale-enter-send: ${n} ok`);
