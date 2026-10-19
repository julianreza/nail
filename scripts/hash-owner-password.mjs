import { randomBytes, scryptSync } from "node:crypto";
import { stdin, stdout } from "node:process";

const MIN_PASSWORD_LENGTH = 12;
const PASSWORD_BYTES = 64;

if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
  process.stderr.write("Run this command in an interactive terminal.\n");
  process.exit(1);
}

stdout.write("Owner password (minimum 12 characters): ");
stdin.setRawMode(true);
stdin.resume();
let password = "";

stdin.on("data", (chunk) => {
  for (const character of chunk.toString("utf8")) {
    if (character === "\u0003") {
      stdout.write("\nCancelled.\n");
      process.exit(130);
    }
    if (character === "\r" || character === "\n") {
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
      if (password.length < MIN_PASSWORD_LENGTH || password.length > 1024) {
        process.stderr.write("Password must be between 12 and 1024 characters.\n");
        process.exit(1);
      }
      const salt = randomBytes(16);
      const digest = scryptSync(password, salt, PASSWORD_BYTES);
      password = "";
      stdout.write(`OWNER_PASSWORD_HASH=scrypt:${salt.toString("base64url")}:${digest.toString("base64url")}\n`);
      process.exit(0);
    }
    if (character === "\u007f" || character === "\b") {
      password = password.slice(0, -1);
      continue;
    }
    if (character >= " " && character !== "\u007f") {
      password += character;
    }
  }
});
