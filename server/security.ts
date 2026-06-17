import type { NextFunction, Request, Response } from "express";
import { config } from "./config.js";

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const authAttempts = new Map<string, RateLimitEntry>();

function clientIp(req: Request) {
  if (config.trustProxy) {
    const forwarded = req.headers["x-forwarded-for"];
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    if (first) return first.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

function rateLimitKey(req: Request) {
  return `${clientIp(req)}:${req.path}`;
}

function contentSecurityPolicy() {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-src 'self' blob:",
    "frame-ancestors 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'"
  ].join("; ");
}

export function securityHeaders(req: Request, res: Response, next: NextFunction) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Content-Security-Policy", contentSecurityPolicy());
  }
  if (config.enableHsts) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
}

export function authRateLimit(req: Request, res: Response, next: NextFunction) {
  const now = Date.now();
  const key = rateLimitKey(req);
  const existing = authAttempts.get(key);
  const entry =
    existing && existing.resetAt > now
      ? existing
      : {
          count: 0,
          resetAt: now + config.authRateLimitWindowMs
        };

  entry.count += 1;
  authAttempts.set(key, entry);

  const remaining = Math.max(0, config.authRateLimitMax - entry.count);
  res.setHeader("RateLimit-Limit", String(config.authRateLimitMax));
  res.setHeader("RateLimit-Remaining", String(remaining));
  res.setHeader("RateLimit-Reset", String(Math.ceil(entry.resetAt / 1000)));

  if (entry.count > config.authRateLimitMax) {
    res.status(429).json({ error: "登录尝试过于频繁，请稍后再试。" });
    return;
  }

  next();
}

export function clearAuthRateLimit(req: Request) {
  authAttempts.delete(rateLimitKey(req));
}
