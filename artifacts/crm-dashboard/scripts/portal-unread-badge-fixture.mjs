import assert from "node:assert/strict";
import { unreadBadge } from "../src/customer-portal/unread-badge.ts";

assert.equal(unreadBadge(0), null);
assert.equal(unreadBadge(-3), null);
assert.equal(unreadBadge(undefined), null);
assert.equal(unreadBadge(3), "۳");
assert.equal(unreadBadge(42), "۴۲");
assert.equal(unreadBadge(99), "۹۹");
assert.equal(unreadBadge(100), "۹۹+");
assert.equal(unreadBadge(1234), "۹۹+");
assert.equal(unreadBadge(7, true), null, "opening the chat clears the badge");
console.log("PASS: chat unread badge uses Persian digits, caps at ۹۹+ and clears on the chat page.");
