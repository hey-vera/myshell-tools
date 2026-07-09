/**
 * Pure mouse helpers (P1.3) — parse SGR reports + hit-test legend/tabs/footer.
 * No TTY required; enable/disable is fail-soft against mock streams.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { render } from 'ink-testing-library';
import {
  buildLegendHitZones,
  buildPanelFooterHitZones,
  buildPanelTabHitZones,
  disableMouseTracking,
  enableMouseTracking,
  hitTestLegend,
  hitTestPanelChromeRow,
  hitTestPanelFooter,
  hitTestPanelTabs,
  isLegendRow,
  isMouseInput,
  isPrimaryClick,
  parseMouseInput,
} from '../../src/interface/ui/mouse.js';
import { ControlPanel } from '../../src/interface/ui/ControlPanel.js';
import { BottomLegend } from '../../src/interface/ui/BottomLegend.js';
import type { UiState } from '../../src/interface/ui/state.js';
import { initialStreamView } from '../../src/interface/ui/state.js';

const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// parse / classify
// ---------------------------------------------------------------------------

test('parseMouseInput: SGR left press (raw CSI with ESC)', () => {
  const ev = parseMouseInput('\x1b[<0;5;12M');
  assert.ok(ev);
  assert.equal(ev.col, 4);
  assert.equal(ev.row, 11);
  assert.equal(ev.button, 'left');
  assert.equal(ev.action, 'press');
  assert.equal(isPrimaryClick(ev), true);
});

test('parseMouseInput: Ink useInput form (ESC already stripped)', () => {
  const ev = parseMouseInput('[<0;10;24M');
  assert.ok(ev);
  assert.equal(ev.col, 9);
  assert.equal(ev.row, 23);
  assert.equal(ev.button, 'left');
  assert.equal(ev.action, 'press');
});

test('parseMouseInput: release is not a primary click', () => {
  const ev = parseMouseInput('[<0;3;3m');
  assert.ok(ev);
  assert.equal(ev.action, 'release');
  assert.equal(isPrimaryClick(ev), false);
});

test('parseMouseInput: wheel up', () => {
  const ev = parseMouseInput('[<64;1;1M');
  assert.ok(ev);
  assert.equal(ev.button, 'wheelUp');
  assert.equal(isPrimaryClick(ev), false);
});

test('parseMouseInput: non-mouse strings return null', () => {
  assert.equal(parseMouseInput('a'), null);
  assert.equal(parseMouseInput('\x1b[A'), null);
  assert.equal(parseMouseInput(''), null);
  assert.equal(isMouseInput('a'), false);
  assert.equal(isMouseInput('[<0;1;1M'), true);
});

// ---------------------------------------------------------------------------
// enable / disable fail-soft
// ---------------------------------------------------------------------------

test('enableMouseTracking: refuses non-TTY and missing write', () => {
  assert.equal(enableMouseTracking(null), false);
  assert.equal(enableMouseTracking({ isTTY: false, write: () => true }), false);
  assert.equal(enableMouseTracking({ isTTY: true }), false);
});

test('enableMouseTracking / disableMouseTracking: write escape sequences on TTY', () => {
  const writes: string[] = [];
  const stream = {
    isTTY: true,
    write(s: string): boolean {
      writes.push(s);
      return true;
    },
  };
  assert.equal(enableMouseTracking(stream), true);
  assert.equal(disableMouseTracking(stream), true);
  assert.ok(writes.some((w) => w.includes('1000h') && w.includes('1006h')));
  assert.ok(writes.some((w) => w.includes('1000l') && w.includes('1006l')));
});

test('disableMouseTracking: no-op on non-TTY (keeps golden frames clean)', () => {
  const writes: string[] = [];
  assert.equal(
    disableMouseTracking({
      isTTY: false,
      write(s: string): boolean {
        writes.push(s);
        return true;
      },
    }),
    false,
  );
  assert.deepEqual(writes, []);
});

// ---------------------------------------------------------------------------
// legend hit zones
// ---------------------------------------------------------------------------

test('hitTestLegend: full legend maps menu / mode / panel / interrupt', () => {
  const columns = 80;
  const zones = buildLegendHitZones(columns);
  assert.deepEqual(
    zones.map((z) => z.id),
    ['menu', 'mode', 'panel', 'interrupt'],
  );
  // First char of "← menu"
  assert.equal(hitTestLegend(0, columns), 'menu');
  // Middot gap is a miss
  const menuEnd = zones[0]!.end;
  assert.equal(hitTestLegend(menuEnd, columns), null);
  // "→ panel" segment
  const panel = zones.find((z) => z.id === 'panel')!;
  assert.equal(hitTestLegend(panel.start, columns), 'panel');
  assert.equal(hitTestLegend(panel.end - 1, columns), 'panel');
});

test('hitTestLegend: narrow legend keeps menu + panel only', () => {
  const columns = 50;
  const zones = buildLegendHitZones(columns);
  assert.deepEqual(
    zones.map((z) => z.id),
    ['menu', 'panel'],
  );
  assert.equal(hitTestLegend(0, columns), 'menu');
  assert.equal(hitTestLegend(zones[1]!.start, columns), 'panel');
});

test('isLegendRow: only the bottom terminal row', () => {
  assert.equal(isLegendRow(23, 24), true);
  assert.equal(isLegendRow(22, 24), false);
  assert.equal(isLegendRow(0, 1), true);
  assert.equal(isLegendRow(0, 0), false);
});

// ---------------------------------------------------------------------------
// panel tabs + footer
// ---------------------------------------------------------------------------

test('hitTestPanelTabs: Status / Goals / Settings columns', () => {
  const zones = buildPanelTabHitZones();
  assert.equal(zones.length, 3);
  assert.equal(hitTestPanelTabs(0), null); // indent
  assert.equal(hitTestPanelTabs(zones[0]!.start), 'status');
  assert.equal(hitTestPanelTabs(zones[1]!.start), 'goals');
  assert.equal(hitTestPanelTabs(zones[2]!.start), 'settings');
  assert.equal(hitTestPanelTabs(zones[2]!.end), null);
});

test('hitTestPanelFooter: ← chat and Esc close both close', () => {
  const wide = buildPanelFooterHitZones(80);
  assert.ok(wide.length >= 2);
  assert.equal(hitTestPanelFooter(wide[0]!.start, 80), 'close');
  assert.equal(hitTestPanelFooter(wide[1]!.start, 80), 'close');
  // Middot / Tab region is not close
  assert.equal(hitTestPanelFooter(wide[0]!.end + 2, 80), null);
});

test('hitTestPanelChromeRow: tabs near top, footer near bottom', () => {
  // With summary: title=0, summary=1, tabs=2
  assert.equal(hitTestPanelChromeRow(2, 24, true), 'tabs');
  assert.equal(hitTestPanelChromeRow(1, 24, false), 'tabs');
  assert.equal(hitTestPanelChromeRow(23, 24, true), 'footer');
  assert.equal(hitTestPanelChromeRow(22, 24, true), 'footer'); // blank InputBox row
  assert.equal(hitTestPanelChromeRow(10, 24, true), null);
});

// ---------------------------------------------------------------------------
// component wiring (stdin mouse sequences)
// ---------------------------------------------------------------------------

function baseCpState(over: Partial<UiState> = {}): UiState {
  return {
    committed: [],
    chrome: [],
    goals: [],
    stream: { ...initialStreamView },
    turnActive: false,
    tokens: { turn: 0, session: 0 },
    board: [],
    boardEnabled: false,
    goalsPanel: {},
    controlPanel: {
      open: true,
      activeSection: 'goals',
      statusScroll: 0,
      goalsListScroll: 0,
      goalsDetailScroll: 0,
      settingsScroll: 0,
    },
    ...over,
  };
}

test('ControlPanel mouse: click Settings tab switches section', async () => {
  const sections: string[] = [];
  const state = baseCpState();
  const { stdin } = render(
    <ControlPanel
      state={state}
      rows={24}
      columns={80}
      onSetSection={(s) => {
        sections.push(s);
      }}
      onHighlightGoal={() => {}}
      onScroll={() => {}}
      onClose={() => {}}
      active={true}
    />,
  );
  await tick();
  // Tabs row with summary = row 2 (0-based) → SGR row 3. Settings zone start.
  const settingsStart = buildPanelTabHitZones()[2]!.start;
  const col1 = settingsStart + 1; // 1-based for SGR
  const row1 = 3;
  await act(async () => {
    stdin.write(`\x1b[<0;${col1};${row1}M`);
    await tick();
  });
  assert.ok(sections.includes('settings'), `expected settings click, got ${JSON.stringify(sections)}`);
});

test('ControlPanel mouse: click Esc close on footer closes', async () => {
  let closed = 0;
  const state = baseCpState();
  const { stdin } = render(
    <ControlPanel
      state={state}
      rows={24}
      columns={80}
      onSetSection={() => {}}
      onHighlightGoal={() => {}}
      onScroll={() => {}}
      onClose={() => {
        closed += 1;
      }}
      active={true}
    />,
  );
  await tick();
  const zones = buildPanelFooterHitZones(80);
  const esc = zones.find((z) => z.start > 0) ?? zones[0]!;
  const col1 = esc.start + 1;
  const row1 = 24; // bottom row
  await act(async () => {
    stdin.write(`\x1b[<0;${col1};${row1}M`);
    await tick();
  });
  assert.equal(closed, 1, 'footer Esc close should invoke onClose');
});

test('BottomLegend mouse: click → panel fires panel action', async () => {
  const actions: string[] = [];
  const columns = 80;
  const rows = 24;
  const panel = buildLegendHitZones(columns).find((z) => z.id === 'panel')!;
  const { stdin } = render(
    <BottomLegend
      color={false}
      columns={columns}
      rows={rows}
      active={true}
      onLegendClick={(a) => {
        actions.push(a);
      }}
    />,
  );
  await tick();
  const col1 = panel.start + 1;
  const row1 = rows; // bottom row, 1-based
  await act(async () => {
    stdin.write(`\x1b[<0;${col1};${row1}M`);
    await tick();
  });
  assert.deepEqual(actions, ['panel']);
});

test('BottomLegend mouse: wrong row is ignored', async () => {
  const actions: string[] = [];
  const columns = 80;
  const { stdin } = render(
    <BottomLegend
      color={false}
      columns={columns}
      rows={24}
      active={true}
      onLegendClick={(a) => {
        actions.push(a);
      }}
    />,
  );
  await tick();
  await act(async () => {
    stdin.write('\x1b[<0;1;5M'); // top-ish row
    await tick();
  });
  assert.deepEqual(actions, []);
});
