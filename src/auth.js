/**
 * Two-tier access:
 *   viewer — anyone with the dashboard URL. Sees brokers, businesses, funded
 *            volume, lenders, deal counts. Never receives commission data.
 *   admin  — logged in with ADMIN_PASSWORD. Additionally sees commission,
 *            fees, and combined totals.
 *
 * The gate is enforced server-side in the API response shape: commission fields
 * are not computed into the payload for viewers, so there is nothing to unhide
 * in devtools.
 */

import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

const TOKEN_TTL = '12h';
const COOKIE_NAME = 'pcg_session';

/** Constant-time compare so a wrong password can't be timed character by character. */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    // Still burn a comparison to keep timing flat.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

export function createSession(res, { role }, secret) {
  const token = jwt.sign({ role }, secret, { expiresIn: TOKEN_TTL });
  const isProd = process.env.NODE_ENV === 'production';

  /**
   * When the dashboard is embedded as a GHL custom menu link, it runs in a
   * cross-site iframe. A SameSite=Lax cookie is dropped in that context, so
   * login would appear to succeed and then immediately revert to viewer.
   * SameSite=None keeps the session working inside the iframe, and the spec
   * requires Secure alongside it — which Railway satisfies (HTTPS by default).
   *
   * Locally over plain HTTP, Secure cookies can't be set at all, so fall back
   * to Lax for development.
   */
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    maxAge: 12 * 60 * 60 * 1000,
  });

  return token;
}

export function clearSession(res) {
  const isProd = process.env.NODE_ENV === 'production';
  // Browsers only clear a cookie when the attributes match the ones it was set
  // with — a bare clearCookie() would leave the iframe session alive.
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
  });
}

/** Reads the session cookie and attaches req.role ('admin' | 'viewer'). */
export function attachRole(secret) {
  return (req, _res, next) => {
    req.role = 'viewer';
    const token = req.cookies?.[COOKIE_NAME];

    if (token) {
      try {
        const payload = jwt.verify(token, secret);
        if (payload?.role === 'admin') req.role = 'admin';
      } catch {
        // Expired or tampered token — silently fall back to viewer.
      }
    }

    next();
  };
}

export function verifyAdminPassword(submitted, expected) {
  if (!expected) return false;
  return safeEqual(submitted || '', expected);
}

export { COOKIE_NAME };
