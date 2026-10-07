"use strict";

/*
 * Role-based access control.
 *
 * Exactly one identity is the app owner: the account whose verified email equals
 * ADMIN_EMAIL (default below). Everyone else is a regular user.
 *
 * Accounts are name-only (no passwords), so an email is never taken from user input
 * as-is: it is stored on an account only by POST /api/admin/claim-owner, after the
 * caller proves ADMIN_SECRET_KEY. Roles are derived from that stored email on every
 * lookup, so changing ADMIN_EMAIL demotes the previous owner immediately.
 */

const DEFAULT_ADMIN_EMAIL = "eliyamistriel1234@gmail.com";

const normalizeEmail = (email) => String(email || "").trim().toLowerCase();

const adminEmail = () => normalizeEmail(process.env.ADMIN_EMAIL || DEFAULT_ADMIN_EMAIL);

const ROLES = { owner: "owner", user: "user" };

/* { role, isAdmin } for an account's stored (verified) email, or none. */
function roleForEmail(email) {
  const isAdmin = !!email && normalizeEmail(email) === adminEmail();
  return { role: isAdmin ? ROLES.owner : ROLES.user, isAdmin };
}

module.exports = { DEFAULT_ADMIN_EMAIL, ROLES, adminEmail, normalizeEmail, roleForEmail };
