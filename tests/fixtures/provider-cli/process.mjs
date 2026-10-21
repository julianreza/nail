import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const mode = process.argv[2];

if (mode === "echo") {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    const keys = [
      "HOME", "PATH", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "LC_CTYPE",
      "SSL_CERT_FILE", "SSL_CERT_DIR", "CODEX_HOME", "OPENAI_API_KEY", "ANTHROPIC_API_KEY",
      "GEMINI_API_KEY", "DATABASE_URL", "DATABASE_CA_CERT_PATH", "NODE_OPTIONS", "HTTPS_PROXY",
    ];
    const env = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    process.stdout.write(JSON.stringify({ input, env }));
  });
} else if (mode === "exit-seven") {
  process.stderr.write("fixture failure");
  process.exitCode = 7;
} else if (mode === "oversized") {
  process.stdout.write("O".repeat(100_000));
} else if (mode === "spawn-descendant") {
  const marker = process.argv[3];
  spawn(process.execPath, [new URL(import.meta.url).pathname, "write-after", marker], { stdio: "ignore" });
  process.stdout.write("descendant-started");
  setInterval(() => undefined, 1000);
} else if (mode === "write-after") {
  const marker = process.argv[3];
  setTimeout(() => writeFileSync(marker, "child survived process-group termination"), 650);
} else {
  process.stderr.write("unknown fixture mode");
  process.exitCode = 2;
}
