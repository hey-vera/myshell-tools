/**
 * test/unit/commands-rules.test.ts — the /rule command (Phase 4): the pure
 * parseRuleCommand dispatch and the runRuleAdd / runRulesList / runRuleRemove
 * handlers against an in-memory rules store (no TTY, no model call).
 *
 * Honesty Contract: no Math.random, no fabricated AI output, no digit-% literals.
 */

import { beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';

import {
  parseRuleCommand,
  runRuleAdd,
  runRulesList,
  runRuleRemove,
} from '../../src/commands/rules.ts';
import type { RulesStore, CreateRuleInput } from '../../src/infra/rules-store.ts';
import { capRule, type Rule } from '../../src/core/rules.ts';
import type { OutputSink } from '../../src/interface/render.ts';

// A tiny in-memory RulesStore — exercises the handlers without fs/Clock.
function makeMemoryStore(): RulesStore & { rules: Rule[] } {
  const rules: Rule[] = [];
  let counter = 0;
  return {
    rules,
    async list(filter) {
      return rules.filter((r) => {
        if (filter?.scope !== undefined && r.scope !== filter.scope) return false;
        if (filter?.projectKey !== undefined && r.projectKey !== filter.projectKey) return false;
        return true;
      });
    },
    async get(id) {
      return rules.find((r) => r.id === id) ?? null;
    },
    async create(input: CreateRuleInput) {
      counter += 1;
      const rule = capRule({
        version: 1,
        id: `rule_m${counter}`,
        kind: input.kind,
        trigger: input.trigger,
        text: input.text,
        scope: input.scope ?? 'project',
        projectKey: (input.scope ?? 'project') === 'project' ? (input.projectKey ?? null) : null,
        createdAt: '2026-06-10T00:00:00.000Z',
      } as Rule);
      rules.unshift(rule); // newest-first
      return rule;
    },
    async remove(id) {
      const i = rules.findIndex((r) => r.id === id);
      if (i < 0) return false;
      rules.splice(i, 1);
      return true;
    },
  };
}

function makeSink(): OutputSink & { text: string } {
  const sink = {
    text: '',
    color: false,
    isTty: false,
    write(s: string) {
      (sink as { text: string }).text += s;
    },
  } as OutputSink & { text: string };
  return sink;
}

describe('parseRuleCommand — dispatch', () => {
  it('bare / list / ls → list', () => {
    assert.deepEqual(parseRuleCommand(''), { kind: 'list' });
    assert.deepEqual(parseRuleCommand('list'), { kind: 'list' });
    assert.deepEqual(parseRuleCommand('ls'), { kind: 'list' });
  });
  it('add <text> → add', () => {
    assert.deepEqual(parseRuleCommand('add always use automerge'), {
      kind: 'add',
      text: 'always use automerge',
    });
  });
  it('rm/remove/delete <n> → rm', () => {
    assert.deepEqual(parseRuleCommand('rm 2'), { kind: 'rm', n: 2 });
    assert.deepEqual(parseRuleCommand('remove 1'), { kind: 'rm', n: 1 });
    assert.deepEqual(parseRuleCommand('delete 3'), { kind: 'rm', n: 3 });
  });
  it('garbage → usage', () => {
    assert.deepEqual(parseRuleCommand('add'), { kind: 'usage' });
    assert.deepEqual(parseRuleCommand('rm x'), { kind: 'usage' });
    assert.deepEqual(parseRuleCommand('frobnicate'), { kind: 'usage' });
  });
});

describe('/rule handlers', () => {
  let store: ReturnType<typeof makeMemoryStore>;
  beforeEach(() => {
    store = makeMemoryStore();
  });

  it('runRuleAdd parses + persists a rule', async () => {
    const out = makeSink();
    await runRuleAdd({ store, out, text: 'never touch package-lock.json', projectKey: null });
    assert.equal(store.rules.length, 1);
    assert.equal(store.rules[0]?.kind, 'block');
    assert.equal(store.rules[0]?.trigger.pathGlob, 'package-lock.json');
    assert.match(out.text, /Rule saved/);
  });

  it('runRulesList shows the saved rules (and a no-rules note when empty)', async () => {
    const empty = makeSink();
    await runRulesList({ store, out: empty });
    assert.match(empty.text, /No standing rules yet/);

    await runRuleAdd({ store, out: makeSink(), text: 'always use automerge', projectKey: null });
    const listed = makeSink();
    await runRulesList({ store, out: listed });
    assert.match(listed.text, /Standing rules \(1\)/);
    assert.match(listed.text, /always use automerge/);
  });

  it('runRuleRemove removes by 1-based index (and reports an unknown index)', async () => {
    await runRuleAdd({ store, out: makeSink(), text: 'always use automerge', projectKey: null });
    const miss = makeSink();
    await runRuleRemove({ store, out: miss, n: 9 });
    assert.match(miss.text, /No rule #9/);
    assert.equal(store.rules.length, 1);

    const hit = makeSink();
    await runRuleRemove({ store, out: hit, n: 1 });
    assert.match(hit.text, /Removed rule/);
    assert.equal(store.rules.length, 0);
  });
});
