/**
 * scripts/pty-handoff-inner.mts — the INNER process of the Ink suspend/resume
 * PTY handoff smoke (run via tsx under a real PTY by pty-smoke-handoff.mjs).
 *
 * Choreography (markers go to stdout so the parent can assert on them):
 *   1. Mount the real Ink app (mountInk) on this PTY (process.stdin/stdout).
 *   2. Print READY. The parent then triggers phase B by writing a newline.
 *   3. reader.suspend() → spawn `bash -c 'read x; echo "CHILD_GOT=$x"'` with
 *      stdio:'inherit' so the CHILD owns the TTY. The parent feeds the child a
 *      line; we assert (via the child's own echo) it was received off fd0 WHILE
 *      Ink is suspended. Print CHILD_DONE when the child exits.
 *   4. reader.resume(), print RESUMED, then the FIRST line the parent feeds into
 *      the Ink input must be received on the first try → print INK_GOT=<line>.
 *   5. Print ALL_DONE and exit 0.
 *
 * The parent drives timing by writing bytes at fixed offsets; this inner process
 * just reacts to phase markers it prints. We keep raw stdout writes (process.
 * stdout.write) for the markers so they aren't swallowed by Ink's frame diffing.
 */
import { spawn } from 'node:child_process';
import { mountInk } from '../src/interface/ui/mount.js';

const emit = (s: string): void => {
  // Write OUTSIDE the Ink frame so the marker survives ANSI clears.
  process.stdout.write(`\n<<${s}>>\n`);
};

async function main(): Promise<void> {
  // Under a PTY, an inherited-stdio child can briefly take the terminal's
  // foreground process group; the parent then gets SIGTTOU when it next writes to
  // the TTY and the kernel STOPS it (so even timers stop firing — the cause of
  // the intermittent wedge in this smoke). Ignoring the job-control signals keeps
  // this orchestrator alive across the handoff. This is a TEST-HARNESS concern
  // only — the production menu loop never spawns a child mid-write like this.
  for (const sig of ['SIGTTOU', 'SIGTTIN'] as const) {
    try {
      process.on(sig, () => {});
    } catch {
      /* signal unsupported on this platform */
    }
  }

  const handle = mountInk({ color: false, isTty: true });
  const { reader } = handle;

  emit('READY');

  // --- Phase B: suspend + child handoff ------------------------------------
  // Give the parent a beat to see READY, then suspend and run the child. We do
  // NOT wait on parent input to start the child — the child reads the line the
  // parent sends after this point. This proves the child reads fd0 while Ink is
  // suspended (Ink would otherwise consume those bytes as input).
  await sleep(800);
  reader.suspend();
  emit('SUSPENDED');

  await runChild();

  // --- Phase C: resume + first-line-after-resume ---------------------------
  reader.resume();
  emit('RESUMED');

  // The FIRST submitted line after resume must land — the regression guard.
  const first = await Promise.race([reader.nextLine(), timeout(8000)]);
  emit(`INK_GOT=${first ?? '<null>'}`);

  emit('ALL_DONE');
  handle.unmount();
  await sleep(100);
  process.exit(0);
}

function runChild(): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = (marker: string): void => {
      if (done) return;
      done = true;
      emit(marker);
      resolve();
    };
    // The CONTRACT under test is that the child READS the pasted line off fd0 (the
    // TTY) while Ink is suspended. So fd0 = 'inherit' (the PTY — the child is the
    // sole reader). We PIPE fd1 instead of inheriting it: if the child wrote
    // CHILD_GOT to the TTY it could flip the terminal's foreground group and stop
    // THIS orchestrator with SIGTTOU (timers and all). Piping stdout keeps the
    // child off the TTY for writes while still proving the read-handoff, and lets
    // us read its result deterministically off the pipe.
    const child = spawn('bash', ['-c', 'IFS= read -r x; printf "CHILD_GOT=%s\\n" "$x"; exit 0'], {
      stdio: ['inherit', 'pipe', 'inherit'],
    });
    emit('CHILD_SPAWNED');
    let childOut = '';
    child.stdout?.on('data', (d: Buffer) => {
      childOut += d.toString('utf8');
      // Surface the child's echo into the captured stream for the parent's assert.
      for (const line of childOut.split('\n')) {
        if (line.startsWith('CHILD_GOT=')) emit(line.trim());
      }
    });
    child.on('exit', () => finish('CHILD_DONE'));
    child.on('close', () => finish('CHILD_DONE'));
    child.on('error', () => finish('CHILD_ERR'));
    // Watchdog: never let a missed exit event wedge the handoff test. NOT unref'd —
    // it must keep the loop alive and fire even if the SIGCHLD exit event is
    // dropped under the PTY.
    setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      finish('CHILD_TIMEOUT');
    }, 4000);
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const timeout = (ms: number): Promise<null> => new Promise((r) => setTimeout(() => r(null), ms));

main().catch((err) => {
  emit(`FATAL=${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
