import { randomBytes } from "node:crypto";

process.stdout.write(
  `NAIL_SECRET_ENCRYPTION_KEY=${randomBytes(32).toString("base64url")}\n`,
);
