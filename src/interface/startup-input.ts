export const STARTUP_INPUT_CARRIER_ENV = 'MYSHELL_STARTUP_INPUT_B64';

type ReadKeyDelegate = () => Promise<string>;

export interface StartupInputStream {
  isRaw?: boolean;
  isTTY?: boolean;
  setRawMode?(mode: boolean): void;
  pause(): void;
  resume(): void;
  on(event: string, listener: (...args: never[]) => void): unknown;
  removeListener(event: string, listener: (...args: never[]) => void): unknown;
  ref?(): void;
  unref?(): void;
}

type QueueRecord = readonly string[];

const importedQueue = (() => {
  const raw = process.env[STARTUP_INPUT_CARRIER_ENV];
  Reflect.deleteProperty(process.env, STARTUP_INPUT_CARRIER_ENV);
  if (typeof raw !== 'string' || raw.length === 0) return [] as string[];
  return decodePendingQueue(raw);
})();

function decodePendingQueue(encoded: string): string[] {
  try {
    const json = Buffer.from(encoded, 'base64').toString('utf8');
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

function encodePendingQueue(queue: QueueRecord): string | null {
  if (queue.length === 0) return null;
  return Buffer.from(JSON.stringify(queue), 'utf8').toString('base64');
}

function decodeUtf8Char(bytes: Uint8Array, start: number): { value: string; size: number } | null {
  const first = bytes[start];
  if (first === undefined) return null;
  if ((first & 0x80) === 0) return { value: String.fromCharCode(first), size: 1 };
  const size =
    (first & 0xe0) === 0xc0 ? 2
    : (first & 0xf0) === 0xe0 ? 3
    : (first & 0xf8) === 0xf0 ? 4
    : 1;
  if (start + size > bytes.length) return null;
  for (let i = 1; i < size; i += 1) {
    const next = bytes[start + i];
    if (next === undefined || (next & 0xc0) !== 0x80) {
      return { value: String.fromCharCode(first), size: 1 };
    }
  }
  return { value: Buffer.from(bytes.slice(start, start + size)).toString('utf8'), size };
}

function parseEscapeSequence(bytes: Uint8Array, start: number): { value: string; size: number } | null {
  const next = bytes[start + 1];
  if (next === undefined) return null;
  if (next === 0x5b) {
    let i = start + 2;
    while (i < bytes.length) {
      const code = bytes[i];
      if (code !== undefined && code >= 0x40 && code <= 0x7e) {
        return { value: Buffer.from(bytes.slice(start, i + 1)).toString('utf8'), size: i + 1 - start };
      }
      i += 1;
    }
    return null;
  }
  if (next === 0x4f) {
    const final = bytes[start + 2];
    if (final === undefined) return null;
    return {
      value: Buffer.from(bytes.slice(start, start + 3)).toString('utf8'),
      size: 3,
    };
  }
  return {
    value: Buffer.from(bytes.slice(start, start + 2)).toString('utf8'),
    size: 2,
  };
}

function parseLogicalKeys(raw: Buffer, carry: readonly number[]): { keys: string[]; carry: number[] } {
  const bytes = Buffer.concat([Buffer.from(carry), raw]);
  const keys: string[] = [];
  let i = 0;
  while (i < bytes.length) {
    const byte = bytes[i];
    if (byte === undefined) break;
    if (byte === 0x1b) {
      const seq = parseEscapeSequence(bytes, i);
      if (seq === null) break;
      keys.push(seq.value);
      i += seq.size;
      continue;
    }
    if (byte === 0x03 || byte === 0x04) {
      keys.push(String.fromCharCode(byte));
      i += 1;
      continue;
    }
    if (byte === 0x0d) {
      keys.push('\r');
      i += bytes[i + 1] === 0x0a ? 2 : 1;
      continue;
    }
    if (byte === 0x0a) {
      keys.push('\r');
      i += 1;
      continue;
    }
    if (byte === 0x09) {
      keys.push('\x1b[tab');
      i += 1;
      continue;
    }
    const decoded = decodeUtf8Char(bytes, i);
    if (decoded === null) break;
    keys.push(decoded.value);
    i += decoded.size;
  }
  return { keys, carry: Array.from(bytes.subarray(i)) };
}

export class StartupInputBuffer {
  private readonly queue: string[];
  private stream: StartupInputStream | null = null;
  private readonly onData = (chunk: Buffer | string): void => {
    const raw = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const parsed = parseLogicalKeys(raw, this.carry);
    this.carry = parsed.carry;
    this.queue.push(...parsed.keys);
  };
  private carry: number[] = [];
  private armed = false;
  private previousRaw: boolean | null = null;

  constructor(initialQueue: readonly string[] = importedQueue) {
    this.queue = [...initialQueue];
  }

  arm(stream: StartupInputStream): void {
    if (this.armed) throw new Error('StartupInputBuffer: already armed');
    this.stream = stream;
    this.armed = true;
    this.carry = [];
    this.previousRaw = stream.isTTY === true ? stream.isRaw === true : null;
    if (stream.isTTY === true && typeof stream.setRawMode === 'function') {
      stream.setRawMode(true);
    }
    stream.resume();
    stream.ref?.();
    stream.on('data', this.onData as (...args: never[]) => void);
  }

  handoff(): (delegate: ReadKeyDelegate) => Promise<string> {
    if (this.stream !== null) {
      this.stream.removeListener('data', this.onData as (...args: never[]) => void);
      this.stream.pause();
      this.stream.unref?.();
    }
    this.armed = false;
    this.stream = null;
    this.carry = [];
    return async (delegate) => {
      const next = this.queue.shift();
      return next !== undefined ? next : delegate();
    };
  }

  dispose(): void {
    const stream = this.stream;
    if (stream !== null) {
      stream.removeListener('data', this.onData as (...args: never[]) => void);
      stream.pause();
      stream.unref?.();
      if (stream.isTTY === true && typeof stream.setRawMode === 'function' && this.previousRaw !== null) {
        stream.setRawMode(this.previousRaw);
      }
    }
    this.stream = null;
    this.armed = false;
    this.previousRaw = null;
    this.carry = [];
  }

  exportPendingBase64(): string | null {
    return encodePendingQueue(this.queue);
  }

  pendingCount(): number {
    return this.queue.length;
  }
}

export function exportPendingStartupInput(queue: readonly string[]): string | null {
  return encodePendingQueue(queue);
}

export function importPendingStartupInput(encoded: string): string[] {
  return decodePendingQueue(encoded);
}
