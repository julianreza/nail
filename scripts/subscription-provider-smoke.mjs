#!/usr/bin/env node
import { createConnection } from "node:net";

const BINDING_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_RESPONSE_BYTES = 1024 * 1024;

function output(kind, state, probePassed) {
  process.stdout.write(`${JSON.stringify({ kind, state, probePassed })}\n`);
}

function parseArgs(args) {
  let binding = null;
  let allowLive = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--allow-live") {
      allowLive = true;
    } else if (args[index] === "--binding" && typeof args[index + 1] === "string") {
      binding = args[index + 1];
      index += 1;
    } else {
      return null;
    }
  }
  if (!binding || !BINDING_ID.test(binding)) return null;
  return { binding, allowLive };
}

function send(socketPath, request, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    let bytes = Buffer.alloc(0);
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timeout = setTimeout(() => finish(new Error("timeout")), timeoutMs);
    socket.on("connect", () => socket.end(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      bytes = Buffer.concat([bytes, Buffer.from(chunk)]);
      if (bytes.byteLength > MAX_RESPONSE_BYTES) return finish(new Error("output_limit"));
      const newline = bytes.indexOf(10);
      if (newline < 0) return;
      if (newline !== bytes.byteLength - 1) return finish(new Error("invalid_response"));
      try {
        const response = JSON.parse(bytes.subarray(0, newline).toString("utf8"));
        if (!response || response.v !== 1 || typeof response.ok !== "boolean") return finish(new Error("invalid_response"));
        if (!response.ok) return finish(new Error(typeof response.code === "string" ? response.code : "unavailable"));
        finish(null, response.result);
      } catch {
        finish(new Error("invalid_response"));
      }
    });
    socket.on("error", () => finish(new Error("unavailable")));
    socket.on("close", () => {
      if (!settled) finish(new Error("unavailable"));
    });
  });
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed) {
    output(null, "invalid_arguments", false);
    process.exitCode = 2;
    return;
  }
  if (!parsed.allowLive) {
    output(null, "live_probe_requires_opt_in", false);
    process.exitCode = 2;
    return;
  }
  const socketPath = process.env.NAIL_CONNECTOR_SOCKET;
  if (!socketPath || !socketPath.startsWith("/")) {
    output(null, "connector_unavailable", false);
    process.exitCode = 2;
    return;
  }
  try {
    const connection = await send(socketPath, { v: 1, op: "check", bindingId: parsed.binding }, 10_000);
    if (!connection || typeof connection.kind !== "string" || connection.state !== "ready") {
      output(typeof connection?.kind === "string" ? connection.kind : null,
        typeof connection?.state === "string" ? connection.state : "unavailable", false);
      process.exitCode = 2;
      return;
    }
    const result = await send(socketPath, {
      v: 1,
      op: "complete",
      bindingId: parsed.binding,
      model: connection.model,
      maxOutputTokens: 16,
      prompt: "Reply with exactly NAIL_OK. Do not use tools or call functions.",
    }, 125_000);
    const probePassed = result && result.text === "NAIL_OK" && result.model === connection.model;
    output(connection.kind, probePassed ? "ready" : "invalid_output", Boolean(probePassed));
    process.exitCode = probePassed ? 0 : 2;
  } catch (error) {
    const code = error instanceof Error && /^[a-z0-9_]{1,64}$/.test(error.message)
      ? error.message
      : "unavailable";
    output(null, code, false);
    process.exitCode = 2;
  }
}

void main().catch(() => {
  output(null, "unavailable", false);
  process.exitCode = 2;
});
