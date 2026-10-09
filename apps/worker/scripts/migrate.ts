#!/usr/bin/env bun
// Applies D1 migrations to the remote database, for `bun run deploy`.
//
// Wrangler's OAuth access token lasts an hour. Past that, wrangler refreshes
// it just before its first request, and Cloudflare's API refuses the new
// token for a little while: 403, code 7403, "The given account is not valid
// or is not authorized to access this service". So the first deploy after an
// hour away failed. This retries that refusal, and only that, until the token
// is accepted.
const DELAYS_S = [10, 20, 30, 60];

for (let attempt = 0; ; attempt++) {
  const proc = Bun.spawn(["wrangler", "d1", "migrations", "apply", "DB", "--remote"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  if (code === 0) {
    process.stdout.write(out);
    process.stderr.write(err);
    process.exit(0);
  }
  const delay = DELAYS_S[attempt];
  if (delay === undefined || !`${out}\n${err}`.includes("code: 7403")) {
    process.stdout.write(out);
    process.stderr.write(err);
    process.exit(code);
  }
  console.error(`Cloudflare hasn't accepted wrangler's refreshed login yet (7403); trying again in ${delay}s…`);
  await Bun.sleep(delay * 1000);
}
