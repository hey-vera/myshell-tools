/**
 * scripts/pty-ink-inner.mts — the INNER process of the END-TO-END Ink RENDER
 * smoke (run via tsx under a real PTY by pty-smoke-ink.mjs).
 *
 * Unlike the hermetic ink-testing-library tests, this mounts the REAL Ink app on
 * a genuine pseudo-terminal and drives a scripted MULTI-TURN conversation through
 * the REAL renderTurn path with a FAKE CoreEvent provider. The parent captures the
 * raw PTY bytes and replays them through @xterm/headless to reconstruct the exact
 * on-screen pixels a human would see — catching live-render bugs (scrollback
 * <Static> duplication, panel/GOALS box rendering, input-box border integrity
 * while streaming, ESC interrupt) that the hermetic tests cannot reach.
 *
 * Choreography (markers go to stdout, OUTSIDE Ink's frame, so the parent can
 * bound the capture and snapshot the screen at the right moments):
 *   <<READY>>            — Ink app mounted.
 *   Turn 1 (sequential)  — fake stream: tier-start → text deltas → tier-done →
 *                          final. Inter-turn chrome (echoed prompt + recap) via
 *                          out.write between turns.
 *   <<PANEL_OPEN>>       — Turn 2 is a PANEL turn (phase:panel + 2 candidates);
 *                          we HOLD it open mid-turn (before synthesis/final) and
 *                          emit this marker so the parent snapshots the live
 *                          "Waiting on N models" panel status line.
 *   <<GOALS_OPEN>>       — Turn 3 is a sequential turn HELD open mid-stream with a
 *                          running goal/agent present, so the bordered GOALS box +
 *                          an agent row are on screen; the parent snapshots it.
 *   <<ESC_BEFORE>>       — about to drive an ESC interrupt during a 4th turn.
 *   <<ESC_FIRED>>        — the interrupt handler actually ran (set via setInterrupt
 *                          + the parent feeding a raw ESC byte to the InputBox).
 *   <<ALL_DONE>>         — every turn committed; parent snapshots the final screen.
 *
 * Timing is deliberately spaced (small awaits) so Ink commits each frame to the
 * PTY before the next mutation; it stays deterministic (fixed fake streams, no
 * wall-clock-dependent assertions on this side).
 */
import { mountInk } from '../src/interface/ui/mount.js';
import type { CoreEvent } from '../src/core/types.js';

const emit = (s: string): void => {
  // Write OUTSIDE the Ink frame so the marker survives Ink's ANSI clears and the
  // parent can pattern-match it in the raw byte stream.
  process.stdout.write(`\n<<${s}>>\n`);
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A fake CoreEvent async generator. `gateMs` (default small) spaces the events
 *  so the live region is on screen long enough for Ink to commit a PTY frame and
 *  the parent to snapshot it; a `hold` promise (when supplied) pauses the stream
 *  at the indicated yield so a turn can be captured MID-STREAM. */
async function* fakeStream(
  events: readonly CoreEvent[],
  opts: { gateMs?: number; holdAt?: number; hold?: Promise<void> } = {},
): AsyncIterable<CoreEvent> {
  const gateMs = opts.gateMs ?? 120;
  let i = 0;
  for (const ev of events) {
    if (opts.hold !== undefined && opts.holdAt === i) {
      // Pause the stream HERE (turn stays active, live region painted) until the
      // parent has snapshotted; then resume to the terminal final.
      await opts.hold;
    }
    yield ev;
    i += 1;
    await sleep(gateMs);
  }
}

// --- the three+ scripted turns (deterministic fake provider) --------------

const TURN1: CoreEvent[] = [
  { type: 'tier-start', tier: 'ic', provider: 'claude', model: 'claude-sonnet-4-6', attempt: 1 },
  { type: 'provider-event', tier: 'ic', event: { type: 'text', delta: 'Turn one ' } },
  { type: 'provider-event', tier: 'ic', event: { type: 'text', delta: 'answer ' } },
  { type: 'provider-event', tier: 'ic', event: { type: 'text', delta: 'ALPHA-UNIQUE.' } },
  { type: 'tier-done', tier: 'ic', success: true, confidence: 0.9, costUsd: 0, inputTokens: 100, outputTokens: 40, durationMs: 100 },
  { type: 'final', success: true, output: 'Turn one answer ALPHA-UNIQUE.', tier: 'ic', totalCostUsd: 0, sessionId: 't1', attempts: 1 },
];

// Turn 2: a PANEL turn — phase:panel with 2 candidates, then synthesis + final.
// We HOLD it open right after the two candidate tier-starts so the live panel
// status line ("Waiting on N models · claude … · codex …") is on screen.
const TURN2_PANEL: CoreEvent[] = [
  { type: 'notice', level: 'info', message: 'Panel (hard turn): claude, codex → synthesized by claude · 3 quota-consuming runs, may take longer' },
  { type: 'phase', phase: 'panel', participants: ['claude', 'codex'] },
  { type: 'tier-start', tier: 'ic', provider: 'claude', model: 'claude-sonnet-4-6', attempt: 1 },
  { type: 'tier-start', tier: 'ic', provider: 'codex', model: 'gpt-5-codex', attempt: 2 }, // holdAt: 4 (pause here)
  { type: 'tier-done', tier: 'ic', success: true, confidence: 0.8, costUsd: 0, inputTokens: 60, outputTokens: 20, durationMs: 150 },
  { type: 'tier-done', tier: 'ic', success: true, confidence: 0.7, costUsd: 0, inputTokens: 60, outputTokens: 20, durationMs: 250 },
  { type: 'phase', phase: 'synthesis', count: 2 },
  { type: 'tier-start', tier: 'manager', provider: 'claude', model: 'claude-opus-4-8', attempt: 3 },
  { type: 'provider-event', tier: 'manager', event: { type: 'text', delta: 'Panel synthesis BETA-UNIQUE.' } },
  { type: 'tier-done', tier: 'manager', success: true, confidence: 0.95, costUsd: 0, inputTokens: 200, outputTokens: 80, durationMs: 300 },
  { type: 'final', success: true, output: 'Panel synthesis BETA-UNIQUE.', tier: 'manager', totalCostUsd: 0, sessionId: 't2', attempts: 3 },
];

// Turn 3: a sequential turn HELD open mid-stream with a running goal + agent, so
// the bordered GOALS box and an agent tree row (├─/└─ provider/model … running)
// are painted in the live status region.
const TURN3_GOALS: CoreEvent[] = [
  { type: 'tier-start', tier: 'ic', provider: 'claude', model: 'claude-opus-4-8', attempt: 1 },
  { type: 'provider-event', tier: 'ic', event: { type: 'text', delta: 'Turn three ' } }, // holdAt: 2 (pause here — goal is running)
  { type: 'provider-event', tier: 'ic', event: { type: 'text', delta: 'answer GAMMA-UNIQUE.' } },
  { type: 'tier-done', tier: 'ic', success: true, confidence: 0.9, costUsd: 0, inputTokens: 150, outputTokens: 60, durationMs: 200 },
  { type: 'final', success: true, output: 'Turn three answer GAMMA-UNIQUE.', tier: 'ic', totalCostUsd: 0, sessionId: 't3', attempts: 1 },
];

// Turn 4: a turn we INTERRUPT with ESC. The interrupt fires the installed handler;
// we then end the turn with a canceled final so the transcript shows "■ Cancelled".
const TURN4_INTERRUPT: CoreEvent[] = [
  { type: 'tier-start', tier: 'ic', provider: 'claude', model: 'claude-sonnet-4-6', attempt: 1 },
  { type: 'provider-event', tier: 'ic', event: { type: 'text', delta: 'Turn four DELTA-UNIQUE streaming…' } }, // holdAt: 2
  { type: 'final', success: false, output: '', tier: 'ic', totalCostUsd: 0, sessionId: 't4', attempts: 1, canceled: true },
];

let elapsed = 0;
const elapsedSecs = (): number => elapsed; // deterministic, not wall-clock

async function main(): Promise<void> {
  // Keep the orchestrator alive across any job-control signal (mirrors the handoff
  // inner) — a TEST-HARNESS concern only.
  for (const sig of ['SIGTTOU', 'SIGTTIN'] as const) {
    try {
      process.on(sig, () => {});
    } catch {
      /* unsupported */
    }
  }

  // color:true so the REAL bordered ✦/❯ input box renders (InputBox.canBox needs
  // color && isTty && width>=32) — the smoke must verify the box border, which the
  // plain-caret (color:false) fallback would not exercise. @xterm/headless folds
  // the SGR colour into cell attributes, so the reconstructed text is unaffected.
  const handle = mountInk({ color: true, isTty: true });
  const { out, renderTurn, setInterrupt } = handle;

  // This smoke simulates an ACTIVE CHAT CONVERSATION (the composer is only shown in
  // chat, not at the menu — runChatLoop flips this on entry). Enter chat mode so the
  // pinned composer renders, which is what the COMPOSER integrity assertion checks.
  handle.setChatActive(true);

  await sleep(400); // let Ink mount + paint the idle skeleton
  emit('READY');

  // ---- Turn 1: a full sequential turn (no hold) ----
  out.write('❯ ask one\n'); // echoed user prompt (inter-turn chrome)
  await renderTurn(fakeStream(TURN1), { elapsedSecs });
  out.write('— recap: turn one done (RECAP-ONE) —\n'); // inter-turn recap chrome
  await sleep(250);

  // ---- Turn 2: PANEL turn, held open after the 2nd candidate tier-start ----
  out.write('❯ ask two (panel)\n');
  {
    let release!: () => void;
    const hold = new Promise<void>((r) => { release = r; });
    const turn = renderTurn(fakeStream(TURN2_PANEL, { holdAt: 4, hold }), { elapsedSecs });
    await sleep(900); // both candidate tier-starts painted; panel status line live
    emit('PANEL_OPEN');
    await sleep(700); // give the parent time to snapshot the live panel frame
    release();
    await turn;
  }
  out.write('— recap: panel done (RECAP-TWO) —\n');
  await sleep(250);

  // ---- Turn 3: sequential turn, held open mid-stream (GOALS box + agent row) ----
  out.write('❯ ask three\n');
  {
    let release!: () => void;
    const hold = new Promise<void>((r) => { release = r; });
    const turn = renderTurn(fakeStream(TURN3_GOALS, { holdAt: 2, hold }), { elapsedSecs });
    await sleep(900); // tier-start + first delta painted: goal+agent running, box live
    emit('GOALS_OPEN');
    await sleep(700); // snapshot window for the GOALS box + agent row
    release();
    await turn;
  }
  out.write('— recap: turn three done (RECAP-THREE) —\n');
  await sleep(250);

  // ---- Turn 4: ESC interrupt during a streaming turn ----
  emit('ESC_BEFORE');
  out.write('❯ ask four\n');
  {
    let release!: () => void;
    const hold = new Promise<void>((r) => { release = r; });
    let fired = false;
    // Install the turn-interrupt handler exactly as the menu loop does for each
    // Ink turn. A bare ESC routed by the <InputBox> calls bridge.interrupt(),
    // which runs THIS handler — the live proof the ESC seam is wired end-to-end.
    setInterrupt(() => {
      if (fired) return;
      fired = true;
      emit('ESC_FIRED');
      release(); // unblock the stream so the turn settles (canceled final)
    });
    const turn = renderTurn(fakeStream(TURN4_INTERRUPT, { holdAt: 2, hold }), { elapsedSecs });
    await sleep(700); // turn streaming, live region painted, handler armed
    // (the parent feeds a raw ESC byte to the PTY right after ESC_BEFORE)
    // Watchdog: if the ESC never lands (env quirk), release after a bound so the
    // smoke still completes and the assertion FAILS loudly rather than hanging.
    setTimeout(() => { if (!fired) release(); }, 5000);
    await turn;
    setInterrupt(null);
  }
  await sleep(300);

  emit('ALL_DONE');
  await sleep(400); // final frame commit
  handle.unmount();
  await sleep(150);
  process.exit(0);
}

main().catch((err) => {
  emit(`FATAL=${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
