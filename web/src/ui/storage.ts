/** The slice of `Storage` the UI uses, so tests and a blocked `localStorage` both have a stand-in. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export class MemoryStorage implements KeyValueStorage {
  private readonly data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
}

/** `localStorage`, or memory when the browser refuses access (blocked site data, some private modes). */
export function browserStorage(): KeyValueStorage {
  try {
    const probe = "mimivox.probe";
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    return new MemoryStorage();
  }
}

/** Reads never throw: a storage that fails to answer is a storage with nothing in it. */
export function readItem(storage: KeyValueStorage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

/** Reports whether the write stuck, so callers can say "not saved" instead of failing. */
export function writeItem(storage: KeyValueStorage, key: string, value: string): boolean {
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function clearItem(storage: KeyValueStorage, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // Nothing to clear.
  }
}
