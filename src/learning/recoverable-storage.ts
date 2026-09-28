export const RECOVERABLE_STORAGE_LOCK_SCHEMA =
  "octos.recoverable-storage-lock.v1" as const;

export interface RecoverableStorageLock {
  schema: typeof RECOVERABLE_STORAGE_LOCK_SCHEMA;
  storage_key: string;
  detected_at: string;
  reason: "invalid-json" | "invalid-shape";
}

interface LoadRecoverableJsonOptions<T> {
  storage: Storage;
  key: string;
  fallback: () => T;
  decode: (value: unknown) => T;
}

let inMemoryLocks = new WeakMap<Storage, Set<string>>();
if (typeof window !== "undefined") {
  window.addEventListener("crew:token_cleared", () => {
    inMemoryLocks = new WeakMap();
  });
}
const RECOVERY_PREFIX = "octos-recovery-lock:v1:";

export function recoverableStorageLockKey(storageKey: string): string {
  return `${RECOVERY_PREFIX}${storageKey}`;
}

function memoryLocks(storage: Storage): Set<string> {
  const current = inMemoryLocks.get(storage);
  if (current) return current;
  const created = new Set<string>();
  inMemoryLocks.set(storage, created);
  return created;
}

function lockRecoverableStorage(
  storage: Storage,
  key: string,
  reason: RecoverableStorageLock["reason"],
): void {
  memoryLocks(storage).add(key);
  const lock: RecoverableStorageLock = {
    schema: RECOVERABLE_STORAGE_LOCK_SCHEMA,
    storage_key: key,
    detected_at: new Date().toISOString(),
    reason,
  };
  try {
    storage.setItem(recoverableStorageLockKey(key), JSON.stringify(lock));
  } catch {
    // The in-memory lock still prevents this page from overwriting the raw value.
  }
}

function clearRecoverableStorageLock(storage: Storage, key: string): void {
  memoryLocks(storage).delete(key);
  try {
    storage.removeItem(recoverableStorageLockKey(key));
  } catch {
    // A valid source value is authoritative even when stale lock cleanup fails.
  }
}

export function isRecoverableStorageLocked(
  storage: Storage,
  key: string,
): boolean {
  if (memoryLocks(storage).has(key)) return true;
  try {
    return storage.getItem(recoverableStorageLockKey(key)) !== null;
  } catch {
    return false;
  }
}

function readRecoverableRaw(
  storage: Storage,
  key: string,
): { raw: string; parsed: unknown } | null {
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    return { raw, parsed: JSON.parse(raw) };
  } catch {
    lockRecoverableStorage(storage, key, "invalid-json");
    return { raw, parsed: undefined };
  }
}

export function loadRecoverableJson<T>({
  storage,
  key,
  fallback,
  decode,
}: LoadRecoverableJsonOptions<T>): T {
  const source = readRecoverableRaw(storage, key);
  if (!source) return fallback();
  if (source.parsed === undefined) return fallback();
  try {
    const value = decode(source.parsed);
    clearRecoverableStorageLock(storage, key);
    return value;
  } catch {
    lockRecoverableStorage(storage, key, "invalid-shape");
    return fallback();
  }
}

export async function loadRecoverableJsonAsync<T>({
  storage,
  key,
  fallback,
  decode,
}: Omit<LoadRecoverableJsonOptions<T>, "decode"> & {
  decode: (value: unknown) => Promise<T>;
}): Promise<T> {
  const source = readRecoverableRaw(storage, key);
  if (!source) return fallback();
  if (source.parsed === undefined) return fallback();
  try {
    const value = await decode(source.parsed);
    clearRecoverableStorageLock(storage, key);
    return value;
  } catch {
    lockRecoverableStorage(storage, key, "invalid-shape");
    return fallback();
  }
}

export function writeRecoverableJson(
  storage: Storage,
  key: string,
  value: unknown,
): boolean {
  if (isRecoverableStorageLocked(storage, key)) return false;
  try {
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function removeRecoverableValue(
  storage: Storage,
  key: string,
): boolean {
  if (isRecoverableStorageLocked(storage, key)) return false;
  try {
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

/** Explicit recovery action for future UI tooling; ordinary saves never call it. */
export function discardRecoverableValue(storage: Storage, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // Best effort: still try to clear the separate recovery lock below.
  }
  try {
    storage.removeItem(recoverableStorageLockKey(key));
  } catch {
    // The in-memory state can still be cleared for the current page.
  }
  memoryLocks(storage).delete(key);
}
