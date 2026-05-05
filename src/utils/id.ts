/**
 * Session id generation — ULID-shape (Crockford base32, sortable, time-prefix).
 *
 * Keep the dependency footprint at zero — implement inline rather than
 * pull `ulid` library. A V1 session id only needs:
 *   - sortable (timestamp prefix)
 *   - collision-safe across one host (~80 bits of randomness is plenty)
 *   - URL/filename safe
 *   - human-recognisable as a session id (e.g. `term_01HRABC...`)
 *
 * Format: `term_` + 26 chars (10 timestamp + 16 random),
 *         all in Crockford base32 (no I L O U).
 */

import { randomBytes } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Encode a non-negative number into Crockford base32 of fixed `length`. */
function encodeTimestamp(ms: number, length = 10): string {
  if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`invalid timestamp: ${ms}`);
  let n = Math.floor(ms);
  const out: string[] = [];
  for (let i = 0; i < length; i++) {
    out.push(CROCKFORD[n % 32]!);
    n = Math.floor(n / 32);
  }
  return out.reverse().join("");
}

/** Encode `length` random Crockford-base32 characters from CSPRNG bytes. */
function encodeRandom(length = 16): string {
  // 5 bits per char → ceil(length * 5 / 8) bytes
  const byteLen = Math.ceil((length * 5) / 8);
  const bytes = randomBytes(byteLen);
  // Build a bit stream and pull 5 bits at a time.
  let bits = 0;
  let bitCount = 0;
  const out: string[] = [];
  for (const b of bytes) {
    bits = (bits << 8) | b;
    bitCount += 8;
    while (bitCount >= 5 && out.length < length) {
      bitCount -= 5;
      out.push(CROCKFORD[(bits >>> bitCount) & 0x1f]!);
    }
  }
  // Pad if we ran out of bytes (shouldn't happen given byteLen calc, but defensive).
  while (out.length < length) out.push(CROCKFORD[0]!);
  return out.join("");
}

/**
 * Mint a new session id.
 *
 * @param prefix   default `"term_"`. Pass `""` to omit. Sandbox uses `"sbx_"`.
 * @param now      override clock for testing (default `Date.now()`).
 */
export function newSessionId(prefix = "term_", now: () => number = Date.now): string {
  return prefix + encodeTimestamp(now()) + encodeRandom();
}

/** Lexically-comparable shorter id for non-Session things (snapshot ids etc). */
export function newShortId(prefix = ""): string {
  return prefix + encodeTimestamp(Date.now(), 8) + encodeRandom(8);
}
