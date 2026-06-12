import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  StartupInputBuffer,
  exportPendingStartupInput,
  importPendingStartupInput,
} from '../../src/interface/startup-input.ts';

class FakeStartupStream extends EventEmitter {
  isTTY = true;
  isRaw = false;
  rawTransitions: boolean[] = [];
  paused = true;
  refs = 0;

  setRawMode(mode: boolean): void {
    this.isRaw = mode;
    this.rawTransitions.push(mode);
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  ref(): void {
    this.refs += 1;
  }

  unref(): void {
    this.refs -= 1;
  }
}

test('captures startup keys FIFO, including multi-byte sequences', async () => {
  const stream = new FakeStartupStream();
  const startup = new StartupInputBuffer();
  startup.arm(stream);

  stream.emit('data', Buffer.from('n1'));
  stream.emit('data', Buffer.from('\x1b[A'));

  const readKey = startup.handoff();
  assert.equal(await readKey(() => Promise.resolve('x')), 'n');
  assert.equal(await readKey(() => Promise.resolve('x')), '1');
  assert.equal(await readKey(() => Promise.resolve('x')), '\x1b[A');
});

test('handoff drains queued keys before delegating to ink readKey', async () => {
  const stream = new FakeStartupStream();
  const startup = new StartupInputBuffer();
  startup.arm(stream);
  stream.emit('data', Buffer.from('ab'));

  const delegated: string[] = [];
  const readKey = startup.handoff();
  const delegate = async (): Promise<string> => {
    delegated.push('delegate');
    return 'z';
  };

  assert.equal(await readKey(delegate), 'a');
  assert.equal(await readKey(delegate), 'b');
  assert.equal(await readKey(delegate), 'z');
  assert.deepEqual(delegated, ['delegate']);
});

test('handoff detaches the startup listener so keys are not delivered twice', async () => {
  const stream = new FakeStartupStream();
  const startup = new StartupInputBuffer();
  startup.arm(stream);
  stream.emit('data', Buffer.from('n'));

  const readKey = startup.handoff();
  stream.emit('data', Buffer.from('x'));

  assert.equal(await readKey(() => Promise.resolve('fallback')), 'n');
  assert.equal(await readKey(() => Promise.resolve('fallback')), 'fallback');
});

test('arm saves raw state and dispose restores it', () => {
  const stream = new FakeStartupStream();
  stream.isRaw = true;
  const startup = new StartupInputBuffer();
  startup.arm(stream);
  startup.dispose();

  assert.deepEqual(stream.rawTransitions, [true, true]);
  assert.equal(stream.isRaw, true);
  assert.equal(stream.paused, true);
  assert.equal(stream.refs, 0);
});

test('dispose detaches the listener and stops further capture', () => {
  const stream = new FakeStartupStream();
  const startup = new StartupInputBuffer();
  startup.arm(stream);
  startup.dispose();
  stream.emit('data', Buffer.from('n'));

  assert.equal(startup.pendingCount(), 0);
  assert.equal(stream.listenerCount('data'), 0);
});

test('base64 export/import carries the pending queue across a simulated relaunch', async () => {
  const firstStream = new FakeStartupStream();
  const first = new StartupInputBuffer();
  first.arm(firstStream);
  firstStream.emit('data', Buffer.from('n\x03'));

  const encoded = first.exportPendingBase64();
  assert.ok(encoded !== null);
  assert.deepEqual(importPendingStartupInput(encoded ?? ''), ['n', '\x03']);

  const relaunched = new StartupInputBuffer(importPendingStartupInput(encoded ?? ''));
  const readKey = relaunched.handoff();
  assert.equal(await readKey(() => Promise.resolve('fallback')), 'n');
  assert.equal(await readKey(() => Promise.resolve('fallback')), '\x03');
});

test('standalone export/import helpers round-trip an empty queue safely', () => {
  assert.equal(exportPendingStartupInput([]), null);
  assert.deepEqual(importPendingStartupInput('not-base64'), []);
});
