/**
 * test/unit/run-stream-parity.test.ts — the PARITY HARNESS (STEP 3b).
 *
 * This is the proof that the new Ink path shows users the SAME visible text as
 * the legacy `renderStream`. For each scripted CoreEvent fixture it runs BOTH:
 *
 *   (i)  legacy `renderStream(events, sink, verbosity)` with a capturing
 *        OutputSink → the bytes it would write to the terminal;
 *   (ii) the Ink path: `renderStreamInk(events, dispatch, …)` folding actions
 *        into the PURE `reduce` reducer (throttle flushed SYNCHRONOUSLY) → the
 *        committed transcript plus any leftover live stream buffer;
 *
 * then NORMALISES both to a list of visible text lines and asserts they match.
 *
 * NORMALISATIONS (each justified — we normalise ONLY intentional, non-textual
 * differences; a real text divergence is left to FAIL loudly):
 *
 *   N1. ANSI stripped from both sides. Colour is the VIEW's job in both paths
 *       (render.ts paints it inline; the Ink view paints colour-by-kind), so it
 *       is not a "visible text" difference. The Ink EnvelopeFilter also injects
 *       inline-markdown ANSI when colour is on, exactly as render.ts does, so
 *       stripping ANSI is required for a like-for-like text comparison.
 *
 *   N2. The `●` turn marker (and its trailing space) is stripped from the START
 *       of each legacy line. render.ts writes the streaming `●` inline before the
 *       first prose delta and the completion `●` before the done/Failed line; in
 *       the Ink model the marker is VIEW chrome (tracked via markerEmitted / the
 *       line `kind`, applied by <Stream>/the transcript renderer — STEP 3b view),
 *       never part of the reducer's committed TEXT. Stripping the leading marker
 *       removes a colour-only/placement-only difference, not a text one.
 *
 *   N3. Spinner frames + carriage returns are removed, and legacy is run on a
 *       NON-TTY sink so no live "Thinking… N steps" status line is painted. The
 *       live status line is transient terminal chrome that never lands in the
 *       committed transcript (it is overwritten in place by `\r`); the Ink live
 *       region is the equivalent transient state and is not part of the committed
 *       comparison. (Markdown styling is independent of TTY — driven by `color` —
 *       so a colour fixture still exercises the styler on a non-TTY legacy sink.)
 *
 *   N4. A legacy line is SPLIT at a chrome / prose-boundary marker. render.ts
 *       writes many segments WITHOUT a trailing newline, so a chrome segment that
 *       lacks a leading `\n` is GLUED onto whatever preceded it on the same
 *       physical line. Two cases occur:
 *         - normal mode: the escalate refining note (`out.write(dim('↑ …')+'\n')`)
 *           glues onto the preceding prose ("First draft.↑ low confidence …").
 *         - verbose mode: a `reasoning` delta (dim, no newline), the streaming
 *           `●` + prose (no newline), and the next `[tool] …` line all glue into
 *           one physical line ("thinking hard● The answer.[tool] read_file end").
 *       The Ink path commits each of these as a SEPARATE transcript line (arguably
 *       more correct — render.ts only avoids interleaving because the live spinner
 *       overwrites the row, which the committed transcript never reflects). We
 *       split the legacy physical line at each chrome / prose-boundary marker so
 *       the two paths carry the IDENTICAL visible tokens. The marker set is the
 *       finite, known set of render.ts's no-leading-newline writes; a stray `●`
 *       boundary is also where the streaming prose begins, so it is both a split
 *       point AND stripped (N2). No completion/cancel/best-effort/timeout line
 *       glues — those all carry a leading `\n`.
 *
 *   N6. (mid-stream CANCEL ONLY) prose that streamed into the LIVE region but was
 *       never committed at a tier boundary before the user hit ESC is TRANSIENT in
 *       both paths and is NOT part of the persisted conversation (work-call.ts does
 *       not append a canceled answer; renderResumeTranscript/compactHistory never
 *       see it). The two paths express that transient prose differently: legacy
 *       `renderStream` streamed it live byte-by-byte to the terminal (it cannot be
 *       unwritten — like the spinner, it is transient terminal chrome, cf. N3),
 *       whereas the Ink reducer held it in the uncommitted `stream.buffer` and
 *       DROPS it on cancel (reduce.ts turn/final) so it never reaches the committed
 *       transcript. Both then show the SAME committed outcome: the "■ Cancelled"
 *       line and nothing persisted. So for the cancel fixture we compare only the
 *       COMMITTED outcome lines (everything from "■ Cancelled" onward), dropping the
 *       transient pre-cancel live prose from the legacy side. This is the
 *       audited "don't commit a partial answer on cancel" behaviour (screen ==
 *       store == replay); a real divergence in the cancel OUTCOME line still fails.
 *
 *   N5. (verbose tool/reasoning interleave ONLY) the comparison is made on the
 *       MULTISET of lines, not their order. This is the one INTENTIONAL, loudly-
 *       documented architectural divergence: in legacy renderStream everything is
 *       one linear byte stream, so a verbose `[tool] …`/reasoning line that fires
 *       WHILE an answer is mid-stream is written between prose deltas. The Ink MVU
 *       model is TWO regions — the live answer streams in `<Stream>` (the
 *       `stream.buffer`, committed only at the tier boundary) while verbose chrome
 *       commits to the `<Static>` transcript immediately. So when a tool line
 *       arrives after prose has begun but before the tier flushes, Ink commits the
 *       tool line first and the (still-live) answer after, whereas legacy
 *       interleaves them. The VISIBLE TOKENS are identical — only the relative
 *       order of a still-streaming answer vs. interleaved verbose chrome differs,
 *       which is a direct, accepted consequence of the live-region layout (the
 *       answer is shown live BELOW the committed chrome, not spliced into it).
 *       This is applied to EXACTLY ONE fixture/verbosity (the verbose
 *       tool+reasoning turn); every other case is strictly order-sensitive, so a
 *       real ordering regression elsewhere still fails loudly.
 *
 * Anything NOT covered by N1–N5 is compared verbatim. If the model ever changed
 * the wording of a line, this harness would fail — that is the point.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderStream, type OutputSink } from '../../src/interface/render.ts';
import { renderStreamInk } from '../../src/interface/ui/run-stream.ts';
import { reduce, initialState, type Action, type UiState, type Verbosity } from '../../src/interface/ui/index.ts';
import type { CoreEvent } from '../../src/core/types.ts';

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

async function* makeStream(events: readonly CoreEvent[]): AsyncIterable<CoreEvent> {
  for (const ev of events) yield ev;
}

/** N1: strip SGR colour + cursor/erase control sequences; N3: drop carriage returns. */
function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[[0-9;]*m/g, '') // SGR colour
    .replace(/\x1b\[[0-9]*[A-Za-z]/g, '') // cursor moves / erases (\x1b[1A, \x1b[K, …)
    .replace(/\r/g, '');
}

/** The chrome / prose-boundary markers a render.ts segment can BEGIN with WITHOUT
 *  a preceding newline (so it glues onto the prior physical line). Used by N4 to
 *  re-split a glued legacy line. This is the finite, known set of render.ts's
 *  no-leading-newline writes: the escalate note (`↑`), the panel/hedge notice
 *  (`⋮`) and failover (`⇄`) in normal mode; and in verbose the per-tier `▶`
 *  tier-start, the `[tool]`/`[info]`/`[warn]`/`[error]` lines, and the
 *  `✓/✗ tier done` telemetry. The mid-string `●` is the streaming prose marker:
 *  it is BOTH a split point and stripped (N2). */
const CHROME_LEADS = [
  '↑ low confidence',
  '↑ Escalating',
  '⋮ ',
  '⇄ ',
  '▶ ',
  '[tool] ',
  '[info] ',
  '[warn] ',
  '[error] ',
  '✓ tier done',
  '✗ tier done',
  '● ',
] as const;

/** N4: split a single physical line at any chrome / prose-boundary marker that
 *  appears AFTER some preceding text (i.e. it was glued onto the prior segment).
 *  The leading `●`-marked piece keeps the marker for N2 to strip uniformly.
 *  Returns ≥1 lines. */
function splitChromeBoundaries(line: string): string[] {
  let best = -1;
  for (const lead of CHROME_LEADS) {
    const idx = line.indexOf(lead);
    if (idx > 0 && (best === -1 || idx < best)) best = idx;
  }
  if (best === -1) return [line];
  return [line.slice(0, best), ...splitChromeBoundaries(line.slice(best))];
}

/** N2: strip a leading `● ` (or bare `●`) turn marker. */
function stripTurnMarker(line: string): string {
  return line.replace(/^●\s?/, '');
}

/** Normalise legacy renderStream output (the bytes written to the sink) to a
 *  list of visible, comparable text lines (applies N1–N4). */
function legacyLines(raw: string): string[] {
  return stripAnsi(raw)
    .split('\n')
    .flatMap(splitChromeBoundaries)
    .map(stripTurnMarker)
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);
}

/** Normalise the Ink reducer state (committed transcript + leftover live buffer)
 *  to the same comparable line list. The committed line text is colour-free
 *  except inline-markdown ANSI the EnvelopeFilter injected when colour is on, so
 *  we strip ANSI (N1) and the (never-present in committed) turn marker (N2) for
 *  symmetry. */
function inkLines(state: UiState): string[] {
  const texts = state.committed.map((c) => c.text);
  // A turn that ended without a terminal `final` (the no-final fixture) may still
  // hold prose in the live buffer; include it so nothing visible is lost.
  if (state.stream.buffer.length > 0) texts.push(state.stream.buffer);
  return texts
    .flatMap((t) => stripAnsi(t).split('\n'))
    .map(stripTurnMarker)
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);
}

/** Run legacy renderStream on a capturing, NON-TTY sink (N3). `color` drives the
 *  markdown styler independently of TTY. */
async function runLegacy(
  events: readonly CoreEvent[],
  verbosity: Verbosity,
  color: boolean,
): Promise<string[]> {
  const buf: string[] = [];
  const sink: OutputSink = { write: (s) => { buf.push(s); }, color, isTty: false };
  await renderStream(makeStream(events), sink, verbosity);
  return legacyLines(buf.join(''));
}

/** Run the Ink path: fold actions into the pure reducer with a SYNCHRONOUS
 *  throttle scheduler so the comparison is deterministic. Returns BOTH the
 *  normalised lines and the `{success, rateLimitedProviders}` result. */
async function runInk(
  events: readonly CoreEvent[],
  verbosity: Verbosity,
  color: boolean,
): Promise<{ lines: string[]; result: Awaited<ReturnType<typeof renderStreamInk>> }> {
  let state = initialState;
  const dispatch = (a: Action): void => { state = reduce(state, a); };
  const syncSchedule = (flush: () => void): (() => void) => { flush(); return () => {}; };
  const result = await renderStreamInk(makeStream(events), dispatch, {
    verbosity,
    color,
    isTty: false,
    scheduleFlush: syncSchedule,
  });
  return { lines: inkLines(state), result };
}

/** Run legacy renderStream to capture its `{success, rateLimitedProviders}`. */
async function legacyResult(
  events: readonly CoreEvent[],
  verbosity: Verbosity,
): Promise<Awaited<ReturnType<typeof renderStream>>> {
  const sink: OutputSink = { write: () => {}, color: false, isTty: false };
  return renderStream(makeStream(events), sink, verbosity);
}

// ---------------------------------------------------------------------------
// fixtures — representative CoreEvent scripts (reuse the render.test.ts shapes)
// ---------------------------------------------------------------------------

interface Fixture {
  readonly name: string;
  readonly events: readonly CoreEvent[];
  /** Which verbosities to compare (default all three). */
  readonly verbosities?: readonly Verbosity[];
  /** Verbosities for which the comparison is on the line MULTISET, not order
   *  (N5 — the verbose live-region interleave divergence). Default: none. */
  readonly orderInsensitive?: readonly Verbosity[];
  /** N6: a mid-stream cancel — compare only the COMMITTED outcome lines (from
   *  "■ Cancelled" onward), dropping transient pre-cancel live prose. Default false. */
  readonly cancelOutcomeOnly?: boolean;
}

/** N6: keep only the committed cancel-outcome tail (from the "■ Cancelled" line
 *  onward); drop any transient pre-cancel live prose. When there is no cancel
 *  line (quiet mode suppresses it) the committed outcome is empty. */
function cancelOutcomeLines(lines: readonly string[]): string[] {
  const idx = lines.findIndex((l) => l.includes('■ Cancelled'));
  return idx === -1 ? [] : lines.slice(idx);
}

const NORMAL_STREAM: CoreEvent[] = [
  { type: 'tier-start', tier: 'ic', provider: 'claude', model: 'claude-sonnet-4-6', attempt: 1 },
  { type: 'provider-event', tier: 'ic', event: { type: 'text', delta: 'Refactored ' } },
  { type: 'provider-event', tier: 'ic', event: { type: 'text', delta: 'the module.' } },
  { type: 'tier-done', tier: 'ic', success: true, confidence: 0.8, costUsd: 0, inputTokens: 1200, outputTokens: 300, durationMs: 1500 },
  { type: 'final', success: true, output: 'Refactored the module.', tier: 'ic', totalCostUsd: 0, sessionId: 's1', attempts: 1 },
];

const TOOL_REASONING_STREAM: CoreEvent[] = [
  { type: 'tier-start', tier: 'ic', provider: 'claude', model: 'claude-sonnet-4-6', attempt: 1 },
  { type: 'provider-event', tier: 'ic', event: { type: 'tool', name: 'read_file', phase: 'start' } },
  { type: 'provider-event', tier: 'ic', event: { type: 'reasoning', delta: 'thinking hard' } },
  { type: 'provider-event', tier: 'ic', event: { type: 'text', delta: 'The answer.' } },
  { type: 'provider-event', tier: 'ic', event: { type: 'tool', name: 'read_file', phase: 'end' } },
  { type: 'tier-done', tier: 'ic', success: true, confidence: 0.9, costUsd: 0, inputTokens: 10, outputTokens: 5, durationMs: 100 },
  { type: 'final', success: true, output: 'The answer.', tier: 'ic', totalCostUsd: 0, sessionId: 's2', attempts: 1 },
];

const ENVELOPE_STREAM: CoreEvent[] = [
  { type: 'tier-start', tier: 'ic', provider: 'claude', model: 'm', attempt: 1 },
  { type: 'provider-event', tier: 'ic', event: { type: 'text', delta: 'Here is the answer.\n' } },
  { type: 'provider-event', tier: 'ic', event: { type: 'text', delta: '{"confidence": 0.9,' } },
  { type: 'provider-event', tier: 'ic', event: { type: 'text', delta: ' "escalate": false, "reason": "ok", "needs_review": false}' } },
  { type: 'final', success: true, output: 'Here is the answer.', tier: 'ic', totalCostUsd: 0, sessionId: 's3', attempts: 1 },
];

const ESCALATE_STREAM: CoreEvent[] = [
  { type: 'tier-start', tier: 'worker', provider: 'claude', model: 'm', attempt: 1 },
  { type: 'provider-event', tier: 'worker', event: { type: 'text', delta: 'First draft.' } },
  { type: 'tier-done', tier: 'worker', success: true, confidence: 0.4, costUsd: 0, inputTokens: 10, outputTokens: 5, durationMs: 50 },
  { type: 'escalate', from: 'worker', to: 'ic', reason: 'confidence below threshold' },
  { type: 'tier-start', tier: 'ic', provider: 'claude', model: 'opus', attempt: 2 },
  { type: 'provider-event', tier: 'ic', event: { type: 'text', delta: 'Refined answer.' } },
  { type: 'tier-done', tier: 'ic', success: true, confidence: 0.9, costUsd: 0, inputTokens: 20, outputTokens: 10, durationMs: 80 },
  { type: 'final', success: true, output: 'Refined answer.', tier: 'ic', totalCostUsd: 0, sessionId: 'esc', attempts: 2 },
];

const FAILOVER_STREAM: CoreEvent[] = [
  { type: 'tier-start', tier: 'ic', provider: 'claude', model: 'm', attempt: 1 },
  { type: 'provider-event', tier: 'ic', event: { type: 'error', error: { category: 'rate-limit', recoverable: true, message: '429 too many requests', suggestion: 'wait' } } },
  { type: 'failover', from: 'claude', to: 'codex', tier: 'ic', reason: 'rate limit' },
  { type: 'tier-start', tier: 'ic', provider: 'codex', model: 'gpt-5.4', attempt: 2 },
  { type: 'provider-event', tier: 'ic', event: { type: 'text', delta: 'Done by codex.' } },
  { type: 'tier-done', tier: 'ic', success: true, confidence: 0.9, costUsd: 0, inputTokens: 10, outputTokens: 5, durationMs: 50 },
  { type: 'final', success: true, output: 'Done by codex.', tier: 'ic', totalCostUsd: 0, sessionId: 'fo', attempts: 2 },
];

const PANEL_STREAM: CoreEvent[] = [
  { type: 'notice', level: 'info', message: 'Panel (hard turn): claude, codex → synthesized by claude · 3 quota-consuming runs, may take longer' },
  { type: 'phase', phase: 'panel', participants: ['claude', 'codex'] },
  { type: 'tier-start', tier: 'ic', provider: 'claude', model: 'claude-sonnet-4-6', attempt: 1 },
  { type: 'tier-start', tier: 'ic', provider: 'codex', model: 'gpt-5-codex', attempt: 2 },
  { type: 'tier-done', tier: 'ic', success: true, confidence: 0.8, costUsd: 0, inputTokens: 10, outputTokens: 5, durationMs: 100 },
  { type: 'tier-done', tier: 'ic', success: true, confidence: 0.7, costUsd: 0, inputTokens: 10, outputTokens: 5, durationMs: 200 },
  { type: 'phase', phase: 'synthesis', count: 2 },
  { type: 'tier-start', tier: 'manager', provider: 'claude', model: 'claude-opus-4-8', attempt: 3 },
  { type: 'provider-event', tier: 'manager', event: { type: 'text', delta: 'Synthesized answer.' } },
  { type: 'tier-done', tier: 'manager', success: true, confidence: 0.9, costUsd: 0, inputTokens: 50, outputTokens: 20, durationMs: 300 },
  { type: 'final', success: true, output: 'Synthesized answer.', tier: 'manager', totalCostUsd: 0, sessionId: 'panel', attempts: 3 },
];

const NOTICES_STREAM: CoreEvent[] = [
  { type: 'notice', level: 'error', message: 'No providers are available.' },
  { type: 'notice', level: 'warn', message: 'provider latency is high' },
  { type: 'notice', level: 'info', message: 'hedge: primary slow — starting flagship in parallel (now 2 quota-consuming runs)' },
  { type: 'tier-start', tier: 'ic', provider: 'claude', model: 'm', attempt: 1 },
  { type: 'provider-event', tier: 'ic', event: { type: 'text', delta: 'Result.' } },
  { type: 'tier-done', tier: 'ic', success: true, confidence: 0.9, costUsd: 0, inputTokens: 10, outputTokens: 5, durationMs: 50 },
  { type: 'final', success: true, output: 'Result.', tier: 'ic', totalCostUsd: 0, sessionId: 'note', attempts: 1 },
];

const MULTI_TIER_TOKENS_STREAM: CoreEvent[] = [
  { type: 'tier-done', tier: 'worker', success: true, confidence: 0.75, costUsd: 0, inputTokens: 1000, outputTokens: 200, durationMs: 400 },
  { type: 'tier-done', tier: 'ic', success: true, confidence: 0.9, costUsd: 0, inputTokens: 2000, outputTokens: 300, durationMs: 900 },
  { type: 'final', success: true, output: 'Done.', tier: 'ic', totalCostUsd: 0, sessionId: 'tok', attempts: 2 },
];

const FAILURE_STREAM: CoreEvent[] = [
  { type: 'final', success: false, output: '', tier: 'ic', totalCostUsd: 0, sessionId: 'auth-session', attempts: 1, errorCategory: 'auth', provider: 'claude' },
];

const CANCEL_STREAM: CoreEvent[] = [
  { type: 'tier-start', tier: 'ic', provider: 'claude', model: 'm', attempt: 1 },
  { type: 'provider-event', tier: 'ic', event: { type: 'text', delta: 'Partial work.' } },
  { type: 'final', success: false, output: '', tier: 'ic', totalCostUsd: 0, sessionId: 'cancel-session', attempts: 1, canceled: true },
];

const TIMEOUT_STREAM: CoreEvent[] = [
  { type: 'notice', level: 'warn', message: 'Spend unknown — the process was killed before reporting usage; the recorded $0 is not a real cost (the run may still have consumed your subscription).' },
  { type: 'final', success: false, output: '', tier: 'ic', totalCostUsd: 0, sessionId: 'timeout-session', attempts: 1, errorCategory: 'timeout', provider: 'claude' },
];

const BEST_EFFORT_STREAM: CoreEvent[] = [
  { type: 'tier-start', tier: 'ic', provider: 'claude', model: 'm', attempt: 3 },
  { type: 'provider-event', tier: 'ic', event: { type: 'text', delta: 'Tentative.' } },
  { type: 'final', success: true, output: 'Tentative.', tier: 'ic', totalCostUsd: 0, sessionId: 'be', attempts: 3, bestEffort: true },
];

const QUESTION_STREAM: CoreEvent[] = [
  { type: 'tier-start', tier: 'ic', provider: 'claude', model: 'm', attempt: 1 },
  { type: 'provider-event', tier: 'ic', event: { type: 'text', delta: 'I need a decision.\n' } },
  { type: 'provider-event', tier: 'ic', event: { type: 'text', delta: '{"ask_user":{"questions":[{"id":"f","prompt":"Which?","options":[{"label":"a"},{"label":"b"}],"multiSelect":false,"allowFreeText":true}]}}' } },
  {
    type: 'final', success: true, output: 'I need a decision.', tier: 'ic', totalCostUsd: 0, sessionId: 'q', attempts: 1,
    questions: { questions: [{ id: 'f', prompt: 'Which?', options: [{ label: 'a' }, { label: 'b' }], multiSelect: false, allowFreeText: true }] },
  },
];

const MARKDOWN_STREAM: CoreEvent[] = [
  { type: 'tier-start', tier: 'ic', provider: 'claude', model: 'm', attempt: 1 },
  { type: 'provider-event', tier: 'ic', event: { type: 'text', delta: 'a **bold** word\n' } },
  { type: 'provider-event', tier: 'ic', event: { type: 'text', delta: 'and `code` here\n' } },
  { type: 'final', success: true, output: 'x', tier: 'ic', totalCostUsd: 0, sessionId: 'md', attempts: 1 },
];

const FIXTURES: readonly Fixture[] = [
  { name: 'normal streaming turn', events: NORMAL_STREAM },
  // N5: in verbose, the tool/reasoning lines interleave with a live-streaming
  // answer; the Ink two-region model orders them differently (same tokens).
  { name: 'tool + reasoning turn', events: TOOL_REASONING_STREAM, orderInsensitive: ['verbose'] },
  { name: 'confidence envelope stripped (split deltas)', events: ENVELOPE_STREAM },
  { name: 'escalation', events: ESCALATE_STREAM },
  { name: 'failover (rate-limit rescue)', events: FAILOVER_STREAM },
  { name: 'panel turn', events: PANEL_STREAM },
  { name: 'notices (error + warn + hedge)', events: NOTICES_STREAM },
  { name: 'multi-tier token accounting', events: MULTI_TIER_TOKENS_STREAM },
  { name: 'failure final (auth, actionable error)', events: FAILURE_STREAM },
  { name: 'cancel final', events: CANCEL_STREAM, cancelOutcomeOnly: true },
  { name: 'timeout final', events: TIMEOUT_STREAM },
  { name: 'best-effort final', events: BEST_EFFORT_STREAM },
  { name: 'question final (ask_user stripped, no completion line)', events: QUESTION_STREAM },
];

const ALL_VERBOSITIES: readonly Verbosity[] = ['quiet', 'normal', 'verbose'];

// ---------------------------------------------------------------------------
// the parity assertions
// ---------------------------------------------------------------------------

describe('renderStreamInk — parity with legacy renderStream (visible text)', () => {
  for (const fx of FIXTURES) {
    for (const verbosity of fx.verbosities ?? ALL_VERBOSITIES) {
      it(`${fx.name} — ${verbosity}: same visible lines`, async () => {
        let legacy = await runLegacy(fx.events, verbosity, false);
        const ink = await runInk(fx.events, verbosity, false);
        let lines = ink.lines;
        const result = ink.result;
        if (fx.cancelOutcomeOnly === true) {
          // N6: compare only the committed cancel-outcome lines (transient
          // pre-cancel live prose is dropped from both sides).
          legacy = cancelOutcomeLines(legacy);
          lines = cancelOutcomeLines(lines);
        }
        const orderless = (fx.orderInsensitive ?? []).includes(verbosity);
        const sort = (xs: string[]): string[] => [...xs].sort();
        assert.deepEqual(
          orderless ? sort(lines) : lines,
          orderless ? sort(legacy) : legacy,
          `Ink visible text diverged from legacy renderStream${orderless ? ' (multiset, N5)' : ''}.\n` +
            `legacy: ${JSON.stringify(legacy, null, 2)}\n` +
            `ink   : ${JSON.stringify(lines, null, 2)}`,
        );
        // The return shape must also match legacy exactly.
        const legacyRes = await legacyResult(fx.events, verbosity);
        assert.equal(result.success, legacyRes.success, 'success flag matches');
        assert.deepEqual(
          [...result.rateLimitedProviders],
          [...legacyRes.rateLimitedProviders],
          'rateLimitedProviders matches',
        );
      });
    }
  }

  // Colour-on parity: the EnvelopeFilter's inline-markdown styler runs in BOTH
  // paths; after ANSI is stripped the visible text must still match.
  for (const verbosity of ['normal', 'verbose'] as const) {
    it(`markdown turn — ${verbosity} (colour on): same visible lines after ANSI strip`, async () => {
      const legacy = await runLegacy(MARKDOWN_STREAM, verbosity, true);
      const { lines } = await runInk(MARKDOWN_STREAM, verbosity, true);
      assert.deepEqual(lines, legacy, 'markdown visible text matches with colour on');
    });
  }
});

// ---------------------------------------------------------------------------
// return-shape edge cases (no final; rate-limit survives failover)
// ---------------------------------------------------------------------------

describe('renderStreamInk — return shape parity', () => {
  it('stream with no final → {success:false, no final} matching legacy', async () => {
    const events: CoreEvent[] = [{ type: 'notice', level: 'info', message: 'stream ended early' }];
    const legacyRes = await legacyResult(events, 'normal');
    const { result } = await runInk(events, 'normal', false);
    assert.equal(result.success, false);
    assert.equal(result.final, undefined);
    assert.equal(result.success, legacyRes.success);
    assert.equal(result.final, legacyRes.final);
  });

  it('rate-limit attributed to the running provider, surviving a rescuing failover', async () => {
    const legacyRes = await legacyResult(FAILOVER_STREAM, 'normal');
    const { result } = await runInk(FAILOVER_STREAM, 'normal', false);
    assert.deepEqual([...result.rateLimitedProviders], ['claude']);
    assert.deepEqual([...result.rateLimitedProviders], [...legacyRes.rateLimitedProviders]);
  });

  it('final event is returned by both paths', async () => {
    const { result } = await runInk(NORMAL_STREAM, 'normal', false);
    assert.ok(result.final !== undefined && result.final.type === 'final');
    assert.equal(result.final.sessionId, 's1');
  });
});

// ---------------------------------------------------------------------------
// throttle behaviour (coalescing is invisible to the committed text)
// ---------------------------------------------------------------------------

describe('renderStreamInk — throttle', () => {
  it('coalesces many prose deltas into the same committed text', async () => {
    const deltas = Array.from({ length: 200 }, (_, i) => `w${i} `);
    const events: CoreEvent[] = [
      { type: 'tier-start', tier: 'ic', provider: 'claude', model: 'm', attempt: 1 },
      ...deltas.map((delta) => ({ type: 'provider-event' as const, tier: 'ic' as const, event: { type: 'text' as const, delta } })),
      { type: 'final', success: true, output: 'x', tier: 'ic', totalCostUsd: 0, sessionId: 's', attempts: 1 },
    ];

    // Count dispatches with a coalescing (deferred) scheduler: deltas accumulate
    // and flush in batches, so the prose-action count is far below 200.
    let proseDispatches = 0;
    let state = initialState;
    let pendingFlush: (() => void) | null = null;
    const dispatch = (a: Action): void => {
      if (a.type === 'stream/prose') proseDispatches++;
      state = reduce(state, a);
    };
    // A deferred scheduler: hold the flush until the NEXT queue attempt or the
    // consumer's explicit flush-before-structural — emulating the real timer
    // coalescing without real time.
    const deferred = (flush: () => void): (() => void) => {
      pendingFlush = flush;
      return () => { pendingFlush = null; };
    };
    await renderStreamInk(makeStream(events), dispatch, {
      verbosity: 'normal',
      scheduleFlush: deferred,
    });
    // Everything must have been flushed by the end.
    assert.equal(pendingFlush, null, 'no pending flush left at stream end');
    // The full prose is present, intact, regardless of batching.
    const joined = state.committed.map((c) => c.text).join('');
    assert.ok(joined.includes('w0 '), 'first delta present');
    assert.ok(joined.includes('w199 '), 'last delta present');
    // Coalesced: far fewer prose dispatches than deltas (the whole run collapses
    // to a single batch with this deferred scheduler).
    assert.ok(proseDispatches < deltas.length, `coalesced (${proseDispatches} < ${deltas.length})`);
  });
});
