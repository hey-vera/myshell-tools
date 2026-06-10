/**
 * test/unit/rules.test.ts — the PURE STANDING-RULES core (Phase 4): the matcher
 * (pause/block/prefer by category/path/keyword; no match → []), the deterministic
 * /rule text parser, the rulesContext render (present → block, absent → ''),
 * classifyCategory, and capRule's defensive shaping.
 *
 * Honesty Contract: no Math.random, no fabricated AI output, no digit-% literals.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseRule,
  matchRules,
  ruleMatches,
  classifyCategory,
  capRule,
  formatRulesForContext,
  selectRulesForScope,
  type Rule,
} from '../../src/core/rules.ts';

function mkRule(partial: Partial<Rule>): Rule {
  return capRule({
    version: 1,
    id: 'rule_x',
    kind: 'pause',
    trigger: {},
    text: 'a rule',
    scope: 'global',
    projectKey: null,
    createdAt: '2026-06-10T00:00:00.000Z',
    ...partial,
  } as Rule);
}

describe('classifyCategory — deterministic category keying', () => {
  it('classifies by keyword, general when nothing matches', () => {
    assert.equal(classifyCategory('pause before any security goal'), 'security');
    assert.equal(classifyCategory('always run the release/publish pipeline'), 'release');
    assert.equal(classifyCategory('touch the CI workflow'), 'infra');
    assert.equal(classifyCategory('add a database migration'), 'data');
    assert.equal(classifyCategory('write more tests'), 'test');
    assert.equal(classifyCategory('update the README docs'), 'docs');
    assert.equal(classifyCategory('rename the helper'), 'refactor');
    assert.equal(classifyCategory('build the landing page'), 'general');
    assert.equal(classifyCategory(''), 'general');
  });
});

describe('parseRule — the deterministic /rule add parser (no model call)', () => {
  it('parses "always use automerge" → prefer', () => {
    const r = parseRule('always use automerge');
    assert.notEqual(r, null);
    assert.equal(r?.kind, 'prefer');
    assert.equal(r?.text, 'always use automerge');
    // no path / no category keyword → keyword fallback (a salient word)
    assert.equal(r?.trigger.keyword, 'automerge');
  });

  it('parses "never touch package-lock.json" → block with a pathGlob', () => {
    const r = parseRule('never touch package-lock.json');
    assert.equal(r?.kind, 'block');
    assert.equal(r?.trigger.pathGlob, 'package-lock.json');
  });

  it('parses "pause before any security goal" → pause with a security category', () => {
    const r = parseRule('pause before any security goal');
    assert.equal(r?.kind, 'pause');
    assert.equal(r?.trigger.category, 'security');
  });

  it('defaults an unclassified imperative to pause (never silently blocks)', () => {
    const r = parseRule('check with someone first');
    assert.equal(r?.kind, 'pause');
  });

  it('returns null only on empty text', () => {
    assert.equal(parseRule(''), null);
    assert.equal(parseRule('   '), null);
  });

  it('extracts a glob path', () => {
    const r = parseRule('never edit src/**/*.gen.ts');
    assert.equal(r?.kind, 'block');
    assert.equal(r?.trigger.pathGlob, 'src/**/*.gen.ts');
  });
});

describe('ruleMatches / matchRules — the pure gate predicate', () => {
  it('matches by category', () => {
    const rule = mkRule({ kind: 'pause', trigger: { category: 'security' } });
    assert.equal(ruleMatches(rule, { category: 'security' }), true);
    assert.equal(ruleMatches(rule, { category: 'infra' }), false);
    assert.equal(ruleMatches(rule, {}), false);
  });

  it('matches by pathGlob (glob + bare-substring)', () => {
    const glob = mkRule({ kind: 'block', trigger: { pathGlob: 'src/**/*.lock' } });
    assert.equal(ruleMatches(glob, { paths: ['src/a/b.lock'] }), true);
    assert.equal(ruleMatches(glob, { paths: ['other/b.lock'] }), false);
    const bare = mkRule({ kind: 'block', trigger: { pathGlob: 'package-lock.json' } });
    assert.equal(ruleMatches(bare, { paths: ['a/b/package-lock.json'] }), true);
    assert.equal(ruleMatches(bare, { paths: ['a/b/yarn.lock'] }), false);
  });

  it('matches by keyword (case-insensitive substring of the action text)', () => {
    const kw = mkRule({ kind: 'prefer', trigger: { keyword: 'automerge' } });
    assert.equal(ruleMatches(kw, { text: 'enable AutoMerge on the PR' }), true);
    assert.equal(ruleMatches(kw, { text: 'merge manually' }), false);
  });

  it('ANDs multiple trigger fields', () => {
    const both = mkRule({ kind: 'pause', trigger: { category: 'security', pathGlob: 'auth.ts' } });
    assert.equal(ruleMatches(both, { category: 'security', paths: ['src/auth.ts'] }), true);
    assert.equal(ruleMatches(both, { category: 'security', paths: ['src/ui.ts'] }), false);
    assert.equal(ruleMatches(both, { category: 'infra', paths: ['src/auth.ts'] }), false);
  });

  it('an empty trigger never matches (inert rule)', () => {
    const inert = mkRule({ trigger: {} });
    assert.equal(ruleMatches(inert, { category: 'security', paths: ['x'], text: 'y' }), false);
  });

  it('matchRules returns [] when nothing matches', () => {
    const rules = [mkRule({ trigger: { category: 'security' } })];
    assert.deepEqual(matchRules(rules, { category: 'infra' }), []);
    assert.deepEqual(matchRules([], { category: 'security' }), []);
  });

  it('matchRules orders block → pause → prefer (strongest first)', () => {
    const rules = [
      mkRule({ id: 'rule_p', kind: 'prefer', trigger: { category: 'security' } }),
      mkRule({ id: 'rule_pa', kind: 'pause', trigger: { category: 'security' } }),
      mkRule({ id: 'rule_b', kind: 'block', trigger: { category: 'security' } }),
    ];
    const fired = matchRules(rules, { category: 'security' });
    assert.deepEqual(fired.map((r) => r.kind), ['block', 'pause', 'prefer']);
  });
});

describe('formatRulesForContext — the rulesContext render', () => {
  it('absent / empty → "" (byte-identical prompt)', () => {
    assert.equal(formatRulesForContext([]), '');
    // @ts-expect-error — defensive: non-array input still yields ''
    assert.equal(formatRulesForContext(undefined), '');
  });

  it('present → a STANDING RULES block naming each rule', () => {
    const block = formatRulesForContext([
      mkRule({ kind: 'block', trigger: { pathGlob: 'package-lock.json' }, text: 'never touch package-lock.json' }),
      mkRule({ kind: 'prefer', trigger: { keyword: 'automerge' }, text: 'always use automerge' }),
    ]);
    assert.match(block, /STANDING RULES/);
    assert.match(block, /NEVER/);
    assert.match(block, /PREFER/);
    assert.match(block, /never touch package-lock\.json/);
    assert.match(block, /always use automerge/);
  });
});

describe('selectRulesForScope — the two-scope filter', () => {
  it('keeps globals + matching-project rules', () => {
    const rules = [
      mkRule({ id: 'rule_g', scope: 'global', projectKey: null }),
      mkRule({ id: 'rule_a', scope: 'project', projectKey: 'app#aaa' }),
      mkRule({ id: 'rule_b', scope: 'project', projectKey: 'other#bbb' }),
    ];
    const got = selectRulesForScope(rules, 'app#aaa').map((r) => r.id);
    assert.deepEqual(got.sort(), ['rule_a', 'rule_g']);
  });
});

describe('capRule — defensive shaping', () => {
  it('defaults a malformed kind/scope, drops an invalid category, caps text', () => {
    const r = capRule({
      version: 1,
      id: 'rule_z',
      kind: 'nonsense',
      trigger: { category: 'not-a-category', pathGlob: '', keyword: 'k' },
      text: 'x'.repeat(1000),
      scope: 'weird',
      projectKey: 'p#1',
      createdAt: '2026-06-10T00:00:00.000Z',
    } as unknown as Rule);
    assert.equal(r.kind, 'pause'); // safe default
    assert.equal(r.scope, 'project'); // safe default
    assert.equal(r.trigger.category, undefined); // invalid category dropped
    assert.equal(r.trigger.pathGlob, undefined); // empty dropped
    assert.equal(r.trigger.keyword, 'k');
    assert.equal(r.text.length, 400); // capped
    // a project rule keeps its projectKey
    assert.equal(r.projectKey, 'p#1');
  });

  it('a global rule never carries a projectKey', () => {
    const r = capRule(mkRule({ scope: 'global', projectKey: 'leak#1' }));
    assert.equal(r.projectKey, null);
  });
});
