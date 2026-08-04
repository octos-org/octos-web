const LEASE_KEY = "octos_learning_tab_lease";
const OWNER_KEY = "octos_learning_tab_owner";
export const LEARNING_LEASE_TTL_MS = 15_000;

interface LearningTabLease {
  owner: string;
  expiresAt: number;
}

/** A browser refresh keeps sessionStorage, so it must keep the same lease
 * owner too. A newly opened tab receives a different owner. */
export function getLearningTabOwner(): string {
  const existing = sessionStorage.getItem(OWNER_KEY);
  if (existing) return existing;
  const owner =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `learning-tab-${Math.random().toString(36).slice(2)}`;
  sessionStorage.setItem(OWNER_KEY, owner);
  return owner;
}
function readLease(): LearningTabLease | null {
  try {
    const value = JSON.parse(localStorage.getItem(LEASE_KEY) ?? "null");
    return value &&
      typeof value.owner === "string" &&
      typeof value.expiresAt === "number"
      ? value
      : null;
  } catch {
    return null;
  }
}

export function acquireLearningTabLease(
  owner: string,
  now = Date.now(),
): boolean {
  const current = readLease();
  if (current && current.owner !== owner && current.expiresAt > now) {
    return false;
  }
  localStorage.setItem(
    LEASE_KEY,
    JSON.stringify({ owner, expiresAt: now + LEARNING_LEASE_TTL_MS }),
  );
  return true;
}

export function renewLearningTabLease(
  owner: string,
  now = Date.now(),
): boolean {
  const current = readLease();
  if (!current || current.owner !== owner) return false;
  localStorage.setItem(
    LEASE_KEY,
    JSON.stringify({ owner, expiresAt: now + LEARNING_LEASE_TTL_MS }),
  );
  return true;
}

export function releaseLearningTabLease(owner: string): void {
  if (readLease()?.owner === owner) localStorage.removeItem(LEASE_KEY);
}
