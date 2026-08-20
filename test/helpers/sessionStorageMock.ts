export type SessionStorageMock = Storage & {
  backing: Map<string, string>;
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  has(key: string): boolean;
};

export function createSessionStorageMock(initial?: Record<string, string>): SessionStorageMock {
  const backing = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    backing,
    get(key: string) {
      return backing.get(key);
    },
    set(key: string, value: string) {
      backing.set(key, value);
    },
    has(key: string) {
      return backing.has(key);
    },
    get length() {
      return backing.size;
    },
    clear() {
      backing.clear();
    },
    getItem(key: string) {
      return backing.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      backing.set(key, value);
    },
    removeItem(key: string) {
      backing.delete(key);
    },
    key(index: number) {
      return [...backing.keys()][index] ?? null;
    },
  };
}

export function installSessionStorage(mock: SessionStorageMock): () => void {
  const previous = globalThis.sessionStorage;
  globalThis.sessionStorage = mock as unknown as Storage;
  return () => {
    globalThis.sessionStorage = previous;
  };
}
