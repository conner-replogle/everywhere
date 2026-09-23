#!/usr/bin/env bun
// Resets a user's password when they're locked out. There is no email reset:
// access to the Cloudflare account (wrangler login) is the root of trust.
//
//   bun run reset-password <username> [--disable-2fa] [--local]
//
// Prints a random temporary password, signs out every session, and with
// --disable-2fa also removes the authenticator and recovery codes.
import { spawnSync } from "node:child_process";
import { hashPassword, randomToken } from "../src/crypto";

const args = process.argv.slice(2);
const username = args.find((a) => !a.startsWith("--"));
const disable2fa = args.includes("--disable-2fa");
const local = args.includes("--local");
const persistTo = args.find((a) => a.startsWith("--persist-to="));
if (!username) {
  console.error("usage: bun run reset-password <username> [--disable-2fa] [--local]");
  process.exit(2);
}

const sqlString = (s: string) => `'${s.replaceAll("'", "''")}'`;
const password = randomToken(15); // 20 url-safe chars
const hash = await hashPassword(password);
const who = `(SELECT id FROM users WHERE username = ${sqlString(username)})`;
const statements = [
  `UPDATE users SET password_hash = ${sqlString(hash)} WHERE username = ${sqlString(username)}`,
  `DELETE FROM sessions WHERE user_id = ${who}`,
  `DELETE FROM mfa_challenges WHERE user_id = ${who}`,
];
if (disable2fa) {
  statements.push(
    `UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_last_step = NULL WHERE username = ${sqlString(username)}`,
    `DELETE FROM recovery_codes WHERE user_id = ${who}`,
  );
}

const run = (sql: string) =>
  spawnSync(
    "bunx",
    ["wrangler", "d1", "execute", "DB", local ? "--local" : "--remote", ...(persistTo ? [persistTo] : []), "--json", "--command", sql],
    {
      cwd: new URL("..", import.meta.url).pathname,
      encoding: "utf8",
    },
  );

const check = run(`SELECT COUNT(*) AS n FROM users WHERE username = ${sqlString(username)}`);
if (check.status !== 0) {
  console.error(check.stderr || check.stdout);
  process.exit(1);
}
if (!/"n":\s*1/.test(check.stdout)) {
  console.error(`no user named ${username}`);
  process.exit(1);
}
const res = run(statements.join("; "));
if (res.status !== 0) {
  console.error(res.stderr || res.stdout);
  process.exit(1);
}
console.log(`Password for ${username} reset. All sessions were signed out${disable2fa ? " and 2FA was disabled" : ""}.`);
console.log(`Temporary password: ${password}`);
console.log("Sign in and change it under Settings → Security.");
