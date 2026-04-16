import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { StateStore } from "./state.js";

/**
 * Ensure a host secret exists at the given path.
 * If the file exists, read and return it (trimmed).
 * Otherwise generate a 32-byte base64url secret, write it (mode 0o600), and return it.
 */
export function ensureHostSecret(secretPath: string): string {
  try {
    const existing = readFileSync(secretPath, "utf-8").trim();
    if (existing.length > 0) return existing;
  } catch {
    // File doesn't exist — fall through to creation.
  }

  const secret = randomBytes(32).toString("base64url");

  const dir = dirname(secretPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(secretPath, secret + "\n", { mode: 0o600 });

  return secret;
}

/** Extract the bearer token from an Authorization header value. */
export function extractBearerToken(
  authHeader: string | undefined,
): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : null;
}

/** Verify a token matches the host secret using constant-time comparison. */
export function verifyHostSecret(token: string, hostSecret: string): boolean {
  const a = Buffer.from(token);
  const b = Buffer.from(hostSecret);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Verify a container token against the state store.
 * Returns the container name if the token is valid, null otherwise.
 */
export function verifyContainerToken(
  token: string,
  stateStore: StateStore,
): string | null {
  return stateStore.resolveToken(token);
}
