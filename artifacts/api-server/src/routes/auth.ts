import { Router, type IRouter } from "express";
import {
  GetAuthSessionResponse,
  LoginBody,
  LoginResponse,
  UpdateAuthProfileBody,
  UpdateAuthProfileResponse,
} from "@workspace/api-zod";
import { executeChanges, queryRow } from "../lib/crm-db";
import {
  createSession,
  destroySession,
  getAuthenticatedUser,
  getAuthUserById,
  hashPassword,
  performDummyPasswordCheck,
  verifyPassword,
} from "../lib/auth";

const router: IRouter = Router();
const failures = new Map<
  string,
  { count: number; windowStartedAt: number; blockedUntil: number }
>();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;

type LoginRow = {
  id: number;
  password_hash: string;
  active: number;
};

router.post("/login", (req, res): void => {
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const username = parsed.data.username.trim().toLowerCase();
  const key = `${req.ip}:${username}`;
  const storedState = failures.get(key);
  const state =
    storedState && Date.now() - storedState.windowStartedAt <= WINDOW_MS
      ? storedState
      : undefined;
  if (!state && storedState) failures.delete(key);
  if (state && state.blockedUntil > Date.now()) {
    res.status(429).json({ error: "Too many attempts. Try again later." });
    return;
  }
  const row = queryRow<LoginRow>(
    "SELECT id, password_hash, active FROM users WHERE LOWER(username) = ?",
    [username],
  );
  if (!row) performDummyPasswordCheck(parsed.data.password);
  const valid = row
    ? Boolean(row.active) && verifyPassword(parsed.data.password, row.password_hash)
    : false;
  if (!valid || !row) {
    const nextCount = (state?.count ?? 0) + 1;
    failures.set(key, {
      count: nextCount,
      windowStartedAt: state?.windowStartedAt ?? Date.now(),
      blockedUntil: nextCount >= MAX_ATTEMPTS ? Date.now() + WINDOW_MS : 0,
    });
    res.status(401).json({ error: "Invalid username or password" });
    return;
  }
  failures.delete(key);
  const user = getAuthUserById(Number(row.id));
  if (!user) {
    res.status(401).json({ error: "Invalid username or password" });
    return;
  }
  createSession(user.id, res);
  res.json(LoginResponse.parse({ user }));
});

router.post("/logout", (req, res): void => {
  destroySession(req, res);
  res.status(204).end();
});

router.get("/session", (req, res): void => {
  const user = getAuthenticatedUser(req);
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  res.json(GetAuthSessionResponse.parse({ user }));
});

router.patch("/profile", (req, res): void => {
  const user = getAuthenticatedUser(req);
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const parsed = UpdateAuthProfileBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const body = parsed.data;
  const values: Array<[string, string | null]> = [];
  const normalized = (value: string | null | undefined) =>
    typeof value === "string" ? value.trim() || null : value;
  if (body.username !== undefined) values.push(["username", body.username.trim().toLowerCase()]);
  if (body.password !== undefined) values.push(["password_hash", hashPassword(body.password)]);
  if (body.fullName !== undefined) values.push(["full_name", normalized(body.fullName) ?? null]);
  if (body.mobile !== undefined) values.push(["mobile", normalized(body.mobile) ?? null]);
  if (body.telegramId !== undefined) values.push(["telegram_id", normalized(body.telegramId) ?? null]);
  if (body.priorityColors !== undefined) values.push(["priority_colors", JSON.stringify(body.priorityColors)]);
  if (!values.length) {
    res.status(400).json({ error: "At least one field is required" });
    return;
  }
  try {
    executeChanges(
      `UPDATE users SET ${values.map(([column]) => `${column} = ?`).join(", ")} WHERE id = ?`,
      [...values.map(([, value]) => value), user.id],
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE")) {
      res.status(409).json({ error: "Username already exists" });
      return;
    }
    throw error;
  }
  const updatedUser = getAuthUserById(user.id);
  if (!updatedUser) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  res.json(UpdateAuthProfileResponse.parse({ user: updatedUser }));
});

export default router;