/**
 * Orin AI admin gate — 4-factor login for the OmniRoute dashboard.
 *
 * The owner signs in with ALL of: email + phone1 + phone2 + password, every
 * value provisioned via environment variables (never in the database):
 *   ADMIN_EMAIL, ADMIN_PHONE_1, ADMIN_PHONE_2, ADMIN_PASSWORD
 *
 * IP blocking:
 *   - 3 wrong attempts (ADMIN_MAX_ATTEMPTS) from one IP → that IP is blocked.
 *   - ADMIN_IP_BLOCK="On"  → blocking active (blocked IPs get 403).
 *   - ADMIN_IP_BLOCK="Off" → kill switch: blocks are ignored and no new ones
 *     are created. This is the owner's recovery path after locking themselves
 *     out — flip the env var in the hosting dashboard and log in again.
 *
 * Failure counters/blocks persist in the settings store (survive restarts);
 * an in-memory copy avoids a DB read on every attempt. When the gate is not
 * configured (no ADMIN_EMAIL), everything here is a pass-through so upstream
 * behavior is untouched.
 */
import { timingSafeEqual } from "crypto";
import { getSettings, updateSettings } from "@/lib/db/settings";

const MAX_ATTEMPTS = Number(process.env.ADMIN_MAX_ATTEMPTS || 3);

function gateConfigured(): boolean {
  return Boolean(
    process.env.ADMIN_EMAIL &&
    process.env.ADMIN_PHONE_1 &&
    process.env.ADMIN_PHONE_2
  );
}

function ipBlockActive(): boolean {
  // Exact "On" (case-insensitive) enables blocking; anything else — including
  // "Off" or unset — disables it. Fail-open by design: the owner's documented
  // recovery path is setting this variable to "Off".
  return String(process.env.ADMIN_IP_BLOCK || "").trim().toLowerCase() === "on";
}

/** Constant-time string compare (padded to equal length). */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    // Compare against itself to keep timing flat on length mismatch.
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

function normalizeEmail(v: unknown): string {
  return String(v ?? "").trim().toLowerCase();
}

/** Digits only, so +94 / 0094 / 077… formatting differences never matter. */
function normalizePhone(v: unknown): string {
  return String(v ?? "").replace(/\D/g, "");
}

export interface OrinGateCredentials {
  email?: unknown;
  phone1?: unknown;
  phone2?: unknown;
  password?: unknown;
}

export interface OrinGateResult {
  /** true when every provided factor matches (or gate not configured). */
  ok: boolean;
  /** 403-worthy block (IP already locked out while blocking is On). */
  blocked?: boolean;
  /** Password should be verified by upstream bcrypt instead of ADMIN_PASSWORD. */
  delegatePasswordToUpstream?: boolean;
  error?: string;
}

interface GateState {
  failedAttemptsByIp: Record<string, number>;
  blockedIps: Record<string, { at: string; attempts: number }>;
}

let memoryState: GateState | null = null;

async function loadState(): Promise<GateState> {
  if (memoryState) return memoryState;
  try {
    const settings = (await getSettings()) as Record<string, unknown>;
    memoryState = {
      failedAttemptsByIp:
        (settings.orinGateFailedAttempts as GateState["failedAttemptsByIp"]) || {},
      blockedIps: (settings.orinGateBlockedIps as GateState["blockedIps"]) || {},
    };
  } catch {
    memoryState = { failedAttemptsByIp: {}, blockedIps: {} };
  }
  return memoryState;
}

async function saveState(): Promise<void> {
  if (!memoryState) return;
  try {
    await updateSettings({
      orinGateFailedAttempts: memoryState.failedAttemptsByIp,
      orinGateBlockedIps: memoryState.blockedIps,
    });
  } catch (e) {
    console.error("[orin-gate] Failed to persist state:", e);
  }
}

export async function checkOrinGate(
  credentials: OrinGateCredentials,
  clientIp: string | null | undefined
): Promise<OrinGateResult> {  if (!gateConfigured()) return { ok: true };

  const ip = (clientIp || "").trim() || "__unknown__";
  const state = await loadState();

  // ── Kill switch / block check ──────────────────────────────────────────────
  if (ipBlockActive() && state.blockedIps[ip]) {
    return {
      ok: false,
      blocked: true,
      error: "This IP address has been blocked after repeated failed sign-in attempts.",
    };
  }
  // When blocking is Off we deliberately do NOT reject blocked IPs — recovery path.

  // ── Factor verification (never reveal which factor failed) ─────────────────
  const emailOk = safeEqual(normalizeEmail(credentials.email), normalizeEmail(process.env.ADMIN_EMAIL));
  const phone1Ok = safeEqual(normalizePhone(credentials.phone1), normalizePhone(process.env.ADMIN_PHONE_1));
  const phone2Ok = safeEqual(normalizePhone(credentials.phone2), normalizePhone(process.env.ADMIN_PHONE_2));

  let delegatePasswordToUpstream = false;
  let passwordOk = false;
  if (process.env.ADMIN_PASSWORD) {
    passwordOk = safeEqual(String(credentials.password ?? ""), String(process.env.ADMIN_PASSWORD));
  } else {
    // No ADMIN_PASSWORD configured → let upstream verify its own management
    // password (bcrypt hash bootstrapped from INITIAL_PASSWORD).
    delegatePasswordToUpstream = true;
    passwordOk = true;
  }

  if (emailOk && phone1Ok && phone2Ok && passwordOk) {
    if (state.failedAttemptsByIp[ip]) {
      delete state.failedAttemptsByIp[ip];
      await saveState();
    }
    return { ok: true, delegatePasswordToUpstream };
  }

  // ── Failure recording ──────────────────────────────────────────────────────
  state.failedAttemptsByIp[ip] = (state.failedAttemptsByIp[ip] || 0) + 1;
  const attempts = state.failedAttemptsByIp[ip];

  if (ipBlockActive() && attempts >= MAX_ATTEMPTS) {
    state.blockedIps[ip] = { at: new Date().toISOString(), attempts };
    delete state.failedAttemptsByIp[ip];
    await saveState();
    console.warn(`[orin-gate] IP blocked after ${attempts} failed attempts: ${ip}`);
    return {
      ok: false,
      blocked: true,
      error: "This IP address has been blocked after repeated failed sign-in attempts.",
    };
  }

  await saveState();
  return { ok: false, error: "Invalid credentials" };
}

/**
 * Records a failed attempt when the password factor was delegated to upstream
 * bcrypt (no ADMIN_PASSWORD env) and the upstream check failed. Applies the
 * same 3-strike blocking rules as checkOrinGate.
 */
export async function recordOrinGateFailure(
  clientIp: string | null | undefined
): Promise<{ blocked: boolean }> {
  if (!gateConfigured()) return { blocked: false };
  const ip = (clientIp || "").trim() || "__unknown__";
  const state = await loadState();

  state.failedAttemptsByIp[ip] = (state.failedAttemptsByIp[ip] || 0) + 1;
  const attempts = state.failedAttemptsByIp[ip];

  if (ipBlockActive() && attempts >= MAX_ATTEMPTS) {
    state.blockedIps[ip] = { at: new Date().toISOString(), attempts };
    delete state.failedAttemptsByIp[ip];
    await saveState();
    console.warn(`[orin-gate] IP blocked after ${attempts} failed attempts: ${ip}`);
    return { blocked: true };
  }

  await saveState();
  return { blocked: false };
}
