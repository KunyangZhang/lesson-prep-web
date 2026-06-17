import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { NextFunction, Request, Response } from "express";
import { parse, serialize } from "cookie";
import { config } from "./config.js";
import type { Store } from "./store.js";
import { newId, nowIso } from "./store.js";

const cookieName = "prep_session";
const maxAgeSeconds = 60 * 60 * 24 * 14;

function sessionCookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: "lax" as const,
    path: "/",
    maxAge
  };
}

function getSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;

  const secretPath = path.join(config.dataDir, "session-secret.txt");
  if (fs.existsSync(secretPath)) return fs.readFileSync(secretPath, "utf8").trim();

  fs.mkdirSync(path.dirname(secretPath), { recursive: true });
  const generated = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(secretPath, generated, "utf8");
  return generated;
}

function base64url(input: string | Buffer) {
  return Buffer.from(input).toString("base64url");
}

function sign(payload: string) {
  return crypto.createHmac("sha256", getSecret()).update(payload).digest("base64url");
}

function createToken(userId: string) {
  const payload = base64url(
    JSON.stringify({
      userId,
      exp: Date.now() + maxAgeSeconds * 1000
    })
  );
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token: string) {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expected = sign(payload);
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (signatureBuffer.length !== expectedBuffer.length) return null;
  if (!crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      userId: string;
      exp: number;
    };
    if (Date.now() > parsed.exp) return null;
    return parsed.userId;
  } catch {
    return null;
  }
}

export function setSessionCookie(res: Response, userId: string) {
  res.setHeader(
    "Set-Cookie",
    serialize(cookieName, createToken(userId), sessionCookieOptions(maxAgeSeconds))
  );
}

export function clearSessionCookie(res: Response) {
  res.setHeader(
    "Set-Cookie",
    serialize(cookieName, "", sessionCookieOptions(0))
  );
}

export async function createAdminUser(store: Store, username: string, password: string) {
  if (store.data.users.length > 0) throw new Error("Admin user already exists.");
  const passwordHash = await bcrypt.hash(password, 12);
  const user = {
    id: newId("user"),
    username,
    passwordHash,
    createdAt: nowIso()
  };
  store.addUser(user);
  return user;
}

export async function verifyPassword(store: Store, username: string, password: string) {
  const user = store.findUserByUsername(username);
  if (!user) return null;
  const ok = await bcrypt.compare(password, user.passwordHash);
  return ok ? user : null;
}

export async function updateUserCredentials(
  store: Store,
  userId: string,
  currentPassword: string,
  nextUsername: string,
  nextPassword: string
) {
  const user = store.findUserById(userId);
  if (!user) return null;

  const ok = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!ok) throw new Error("当前密码不正确。");

  const username = nextUsername.trim();
  if (username.length < 2) throw new Error("账号至少需要 2 个字符。");

  const existing = store.findUserByUsername(username);
  if (existing && existing.id !== user.id) throw new Error("这个账号已经被使用。");

  user.username = username;
  if (nextPassword.trim()) {
    if (nextPassword.length < 8) throw new Error("新密码至少需要 8 个字符。");
    user.passwordHash = await bcrypt.hash(nextPassword, 12);
  }
  store.save();
  return user;
}

export function authMiddleware(store: Store) {
  return (req: Request, res: Response, next: NextFunction) => {
    const cookies = parse(req.headers.cookie || "");
    const token = cookies[cookieName];
    const userId = token ? verifyToken(token) : null;
    const user = userId ? store.findUserById(userId) : null;
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    res.locals.user = { id: user.id, username: user.username };
    next();
  };
}
