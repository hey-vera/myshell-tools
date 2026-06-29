/**
 * Unit tests for src/infra/state-migration.ts
 * Hermetic — uses injected temp dirs; NEVER touches the real profile.
 */

import { afterAll, beforeAll, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { planStateMigration, runStateMigration } from '../../src/infra/state-migration.ts';
import type { AppStateLayout, StateContext } from '../../src/infra/state-layout.ts';

// ── Test helpers ────────────────────────────────────────────────────────────

function testLayout(tempDir: string): AppStateLayout {
  const configRoot = join(tempDir, 'config');
  const stateRoot = join(tempDir, 'state');
  const cacheRoot = join(tempDir, 'cache');
  return {
    kind: 'legacy-posix',
    appName: 'myshell-tools',
    configRoot,
    stateRoot,
    cacheRoot,
    legacyRoot: join(tempDir, 'old-legacy'),
    cloud: null,
    paths: {
      configFile: join(configRoot, 'config.json'),
      credentialsFile: join(stateRoot, 'credentials.json'),
      conversationsDir: join(stateRoot, 'conversations'),
      conversationArchiveDir: join(stateRoot, '.session-archive'),
      goalsDir: join(stateRoot, 'goals'),
      memoryDir: join(stateRoot, 'memory'),
      rulesDir: join(stateRoot, 'rules'),
      subscriptionsFile: join(stateRoot, 'subscriptions.json'),
      providerHomesDir: join(stateRoot, 'provider-homes'),
      updateCacheFile: join(cacheRoot, 'update-check.json'),
      migrationDir: join(stateRoot, 'migration'),
    },
  };
}

function testCtx(homeDir: string, cwd: string): StateContext {
  return {
    env: {},
    platform: process.platform as NodeJS.Platform,
    cwd,
    homeDir,
  };
}

let baseDir: string;

beforeAll(async () => {
  baseDir = await mkdtemp(join(tmpdir(), 'state-mig-test-'));
});

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('planStateMigration', () => {
  it('resolves candidate old roots (homeDir + cwd)', async () => {
    const homeDir = join(baseDir, 'home');
    const cwdDir = join(baseDir, 'cwd');
    await mkdir(homeDir, { recursive: true });
    await mkdir(cwdDir, { recursive: true });

    const layout = testLayout(join(baseDir, 'layout'));
    const ctx = testCtx(homeDir, cwdDir);

    const homeOld = join(homeDir, '.myshell-tools');
    await mkdir(homeOld, { recursive: true });
    await writeFile(join(homeOld, 'config.json'), 'test');

    const cwdOld = join(cwdDir, '.myshell-tools');
    await mkdir(cwdOld, { recursive: true });
    await writeFile(join(cwdOld, 'ledger.jsonl'), 'line1');

    const plan = await planStateMigration(layout, ctx);

    assert.equal(plan.fromRoots.length, 2);
    assert.ok(
      plan.fromRoots.some((r) =>
        r.replace(/\\/g, '/').endsWith('home/.myshell-tools'),
      ),
    );
    assert.ok(
      plan.fromRoots.some((r) =>
        r.replace(/\\/g, '/').endsWith('cwd/.myshell-tools'),
      ),
    );
    assert.ok(plan.actions.length > 0);
  });

  it('excludes old roots that equal a new root', async () => {
    const layout = testLayout(join(baseDir, 'layout2'));
    const ctx = testCtx(layout.stateRoot, layout.stateRoot);

    const plan = await planStateMigration(layout, ctx);

    for (const root of plan.fromRoots) {
      const norm = root.replace(/\\/g, '/').replace(/\/+$/, '');
      const stateNorm = layout.stateRoot.replace(/\\/g, '/').replace(/\/+$/, '');
      assert.notEqual(norm, stateNorm);
    }
  });
});

describe('runStateMigration — copy', () => {
  it('copies a missing destination file', async () => {
    const layout = testLayout(join(baseDir, 'copy-missing'));
    const homeDir = join(baseDir, 'copy-missing-home');
    await mkdir(homeDir, { recursive: true });

    const oldRoot = join(homeDir, '.myshell-tools');
    await mkdir(oldRoot, { recursive: true });
    await writeFile(join(oldRoot, 'config.json'), '{"version":1}');

    const ctx = testCtx(homeDir, join(baseDir, 'copy-missing-cwd'));
    const plan = await planStateMigration(layout, ctx);
    const report = await runStateMigration(plan);

    assert.equal(report.status, 'complete');
    assert.equal(report.copied.length, 1);
    assert.ok(report.copied.includes('config.json'));

    const destContent = await readFile(layout.paths.configFile, 'utf8');
    assert.equal(destContent, '{"version":1}');
  });

  it('copies a file from a nested subdirectory (goals/)', async () => {
    const layout = testLayout(join(baseDir, 'copy-nested'));
    const homeDir = join(baseDir, 'copy-nested-home');
    await mkdir(homeDir, { recursive: true });

    const oldRoot = join(homeDir, '.myshell-tools');
    await mkdir(join(oldRoot, 'goals'), { recursive: true });
    await writeFile(join(oldRoot, 'goals', 'goal-1.json'), JSON.stringify({ id: 1 }));

    const ctx = testCtx(homeDir, join(baseDir, 'copy-nested-cwd'));
    const plan = await planStateMigration(layout, ctx);
    const report = await runStateMigration(plan);

    assert.equal(report.status, 'complete');
    assert.equal(report.copied.length, 1);

    const destContent = await readFile(
      join(layout.paths.goalsDir, 'goal-1.json'),
      'utf8',
    );
    assert.equal(destContent, JSON.stringify({ id: 1 }));
  });
});

describe('runStateMigration — already-present', () => {
  it('marks already-present when destination exists with identical bytes', async () => {
    const layout = testLayout(join(baseDir, 'ap-identical'));
    const homeDir = join(baseDir, 'ap-identical-home');
    await mkdir(homeDir, { recursive: true });

    const oldRoot = join(homeDir, '.myshell-tools');
    await mkdir(oldRoot, { recursive: true });
    await writeFile(join(oldRoot, 'config.json'), 'identical');

    await mkdir(layout.configRoot, { recursive: true });
    await writeFile(layout.paths.configFile, 'identical');

    const ctx = testCtx(homeDir, join(baseDir, 'ap-identical-cwd'));
    const plan = await planStateMigration(layout, ctx);
    const report = await runStateMigration(plan);

    assert.equal(report.alreadyPresent.length, 1);
    assert.ok(report.alreadyPresent.includes('config.json'));
    assert.equal(report.status, 'complete');
  });
});

describe('runStateMigration — conflict', () => {
  it('preserves conflict: keeps dest unchanged, writes conflict file', async () => {
    const layout = testLayout(join(baseDir, 'conflict-diff'));
    const homeDir = join(baseDir, 'conflict-diff-home');
    await mkdir(homeDir, { recursive: true });

    const oldRoot = join(homeDir, '.myshell-tools');
    await mkdir(oldRoot, { recursive: true });
    await writeFile(join(oldRoot, 'config.json'), 'newer');

    await mkdir(layout.configRoot, { recursive: true });
    await mkdir(layout.stateRoot, { recursive: true });
    await writeFile(layout.paths.configFile, 'older');

    const ctx = testCtx(homeDir, join(baseDir, 'conflict-diff-cwd'));
    const plan = await planStateMigration(layout, ctx);
    const report = await runStateMigration(plan);

    // Destination must be unchanged
    const destContent = await readFile(layout.paths.configFile, 'utf8');
    assert.equal(destContent, 'older');

    // Conflict file must exist with source content
    assert.equal(report.conflicts.length, 1);
    assert.ok(report.conflicts.includes('config.json'));

    const conflictsDir = join(layout.paths.migrationDir, 'conflicts');
    const entries = await readdir(conflictsDir);
    assert.equal(entries.length, 1);
    const conflictContent = await readFile(join(conflictsDir, entries[0]!), 'utf8');
    assert.equal(conflictContent, 'newer');

    assert.equal(report.status, 'conflicts');
  });
});

describe('runStateMigration — JSONL merge', () => {
  it('merges JSONL by exact-line dedupe, dest-first order', async () => {
    const layout = testLayout(join(baseDir, 'jsonl-merge'));
    const cwdDir = join(baseDir, 'jsonl-merge-cwd');
    await mkdir(cwdDir, { recursive: true });

    const oldRoot = join(cwdDir, '.myshell-tools');
    await mkdir(oldRoot, { recursive: true });
    // Source has A, B, C
    await writeFile(join(oldRoot, 'ledger.jsonl'), 'A\nB\nC\n');

    const ctx = testCtx(join(baseDir, 'jsonl-merge-home'), cwdDir);

    // First migration: copies source to dest (dest doesn't exist)
    const plan1 = await planStateMigration(layout, ctx);
    const report1 = await runStateMigration(plan1);
    assert.equal(report1.copied.length, 1);

    // Now modify source: add E, keep A,B,C
    await writeFile(join(oldRoot, 'ledger.jsonl'), 'A\nB\nC\nE\n');

    // Second migration: dest exists (A,B,C), source differs (A,B,C,E) → jsonl-merge
    const plan2 = await planStateMigration(layout, ctx);
    const report2 = await runStateMigration(plan2);

    assert.equal(report2.merged.length, 1);
    assert.ok(report2.merged.includes('ledger.jsonl'));

    // Read the merged result
    const destPath = plan2.actions.find((a) => a.relativePath === 'ledger.jsonl')!
      .destPath;
    const destContent = await readFile(destPath, 'utf8');
    const lines = destContent.trim().split('\n');
    // dest-first: A, B, C then unique source: E
    assert.deepEqual(lines, ['A', 'B', 'C', 'E']);
  });

  it('jsonl merge is idempotent (no duplicate lines)', async () => {
    const layout = testLayout(join(baseDir, 'jsonl-merge-idem'));
    const cwdDir = join(baseDir, 'jsonl-merge-idem-cwd');
    await mkdir(cwdDir, { recursive: true });

    const oldRoot = join(cwdDir, '.myshell-tools');
    await mkdir(oldRoot, { recursive: true });
    await writeFile(join(oldRoot, 'ledger.jsonl'), 'X\nY\n');

    const ctx = testCtx(join(baseDir, 'jsonl-merge-idem-home'), cwdDir);

    // First run: copy
    const p1 = await planStateMigration(layout, ctx);
    await runStateMigration(p1);

    // Second run without changing source: dest=source identical → already-present
    const p2 = await planStateMigration(layout, ctx);
    const r2 = await runStateMigration(p2);
    assert.equal(r2.merged.length, 0);
    assert.equal(r2.alreadyPresent.length, 1);
  });

  it('jsonl merge keeps dest lines first, then unique source lines', async () => {
    const layout = testLayout(join(baseDir, 'jsonl-order'));
    const cwdDir = join(baseDir, 'jsonl-order-cwd');
    await mkdir(cwdDir, { recursive: true });

    const oldRoot = join(cwdDir, '.myshell-tools');
    await mkdir(oldRoot, { recursive: true });
    // Source: B, A, D
    await writeFile(join(oldRoot, 'ledger.jsonl'), 'B\nA\nD\n');

    const ctx = testCtx(join(baseDir, 'jsonl-order-home'), cwdDir);

    // First migration: copy source to dest
    const p1 = await planStateMigration(layout, ctx);
    await runStateMigration(p1);

    // Now change source to add C (A, B, C)
    await writeFile(join(oldRoot, 'ledger.jsonl'), 'A\nB\nC\n');

    // Second: dest has B,A,D; source has A,B,C → merge
    const p2 = await planStateMigration(layout, ctx);
    await runStateMigration(p2);

    const destPath = p2.actions.find((a) => a.relativePath === 'ledger.jsonl')!
      .destPath;
    const destContent = await readFile(destPath, 'utf8');
    const lines = destContent.trim().split('\n');
    // dest-first: B, A, D (from dest), then unique source: C (A and B already in dest)
    assert.deepEqual(lines, ['B', 'A', 'D', 'C']);
  });
});

describe('runStateMigration — credentials conflict never merges', () => {
  it('credentials conflict: keeps dest, writes source as conflict file', async () => {
    const layout = testLayout(join(baseDir, 'cred-conflict'));
    const homeDir = join(baseDir, 'cred-conflict-home');
    await mkdir(homeDir, { recursive: true });

    const oldRoot = join(homeDir, '.myshell-tools');
    await mkdir(oldRoot, { recursive: true });
    await writeFile(join(oldRoot, 'credentials.json'), '{"token":"old-secret"}');

    await mkdir(layout.stateRoot, { recursive: true });
    await writeFile(layout.paths.credentialsFile, '{"token":"new-secret"}');

    const ctx = testCtx(homeDir, join(baseDir, 'cred-conflict-cwd'));
    const plan = await planStateMigration(layout, ctx);
    const report = await runStateMigration(plan);

    // Destination must be unchanged
    const destContent = await readFile(layout.paths.credentialsFile, 'utf8');
    assert.equal(destContent, '{"token":"new-secret"}');

    // Must be recorded as conflict, NOT merged
    assert.equal(report.conflicts.length, 1);
    assert.ok(report.conflicts.includes('credentials.json'));
    assert.equal(report.merged.length, 0);
  });
});

describe('runStateMigration — corrupt/garbage file', () => {
  it('copies garbage bytes as-is (raw bytes, not parsed)', async () => {
    const layout = testLayout(join(baseDir, 'garbage-copy'));
    const homeDir = join(baseDir, 'garbage-copy-home');
    await mkdir(homeDir, { recursive: true });

    const oldRoot = join(homeDir, '.myshell-tools');
    await mkdir(oldRoot, { recursive: true });

    const garbage = Buffer.from([0x00, 0xff, 0xfe, 0xfd, 0x01, 0x02]);
    await writeFile(join(oldRoot, 'config.json'), garbage);

    const ctx = testCtx(homeDir, join(baseDir, 'garbage-copy-cwd'));
    const plan = await planStateMigration(layout, ctx);
    const report = await runStateMigration(plan);

    assert.equal(report.copied.length, 1);

    const destBytes = await readFile(layout.paths.configFile);
    assert.ok(destBytes.equals(garbage));
  });
});

describe('runStateMigration — idempotency', () => {
  it('re-running with same FS state produces complete with no duplicate work', async () => {
    const layout = testLayout(join(baseDir, 'idempotent'));
    const homeDir = join(baseDir, 'idempotent-home');
    await mkdir(homeDir, { recursive: true });

    const oldRoot = join(homeDir, '.myshell-tools');
    await mkdir(oldRoot, { recursive: true });
    await writeFile(join(oldRoot, 'config.json'), 'v1');
    await writeFile(join(oldRoot, 'subscriptions.json'), 'sub-data');

    const ctx = testCtx(homeDir, join(baseDir, 'idempotent-cwd'));

    const plan1 = await planStateMigration(layout, ctx);
    const report1 = await runStateMigration(plan1);
    assert.equal(report1.status, 'complete');
    assert.equal(report1.copied.length, 2);

    const plan2 = await planStateMigration(layout, ctx);
    const report2 = await runStateMigration(plan2);

    assert.equal(report2.copied.length, 0);
    assert.equal(report2.alreadyPresent.length, 2);
    assert.equal(report2.status, 'complete');
  });

  it('re-run after new file added copies only the new file', async () => {
    const layout = testLayout(join(baseDir, 'idempotent-new'));
    const homeDir = join(baseDir, 'idempotent-new-home');
    await mkdir(homeDir, { recursive: true });

    const oldRoot = join(homeDir, '.myshell-tools');
    await mkdir(oldRoot, { recursive: true });
    await writeFile(join(oldRoot, 'config.json'), 'cfg');
    await writeFile(join(oldRoot, 'subscriptions.json'), 'sub');

    const ctx = testCtx(homeDir, join(baseDir, 'idempotent-new-cwd'));

    const plan1 = await planStateMigration(layout, ctx);
    await runStateMigration(plan1);

    // Add a new file
    await writeFile(join(oldRoot, 'update-check.json'), 'cache-data');

    const plan2 = await planStateMigration(layout, ctx);
    const report2 = await runStateMigration(plan2);

    assert.equal(report2.alreadyPresent.length, 2);
    assert.equal(report2.copied.length, 1);
    assert.ok(report2.copied.includes('update-check.json'));
    assert.equal(report2.status, 'complete');
  });
});

describe('runStateMigration — mode 0o600 on credentials', () => {
  it(
    'sets 0o600 on credentials.json and subscriptions.json',
    { skip: process.platform === 'win32' },
    async () => {
      const layout = testLayout(join(baseDir, 'mode-cred'));
      const homeDir = join(baseDir, 'mode-cred-home');
      await mkdir(homeDir, { recursive: true });

      const oldRoot = join(homeDir, '.myshell-tools');
      await mkdir(oldRoot, { recursive: true });
      await writeFile(join(oldRoot, 'credentials.json'), '{"secret":1}');
      await writeFile(join(oldRoot, 'subscriptions.json'), '{"sub":2}');

      const ctx = testCtx(homeDir, join(baseDir, 'mode-cred-cwd'));
      const plan = await planStateMigration(layout, ctx);
      await runStateMigration(plan);

      const stCred = await stat(layout.paths.credentialsFile);
      assert.equal(stCred.mode & 0o777, 0o600);

      const stSub = await stat(layout.paths.subscriptionsFile);
      assert.equal(stSub.mode & 0o777, 0o600);
    },
  );
});

describe('runStateMigration — never copies .ssh sibling', () => {
  it('skips .ssh directory placed in the old root', async () => {
    const layout = testLayout(join(baseDir, 'skip-ssh'));
    const homeDir = join(baseDir, 'skip-ssh-home');
    await mkdir(homeDir, { recursive: true });

    const oldRoot = join(homeDir, '.myshell-tools');
    await mkdir(oldRoot, { recursive: true });
    await mkdir(join(oldRoot, '.ssh'), { recursive: true });
    await writeFile(join(oldRoot, '.ssh', 'id_rsa'), 'PRIVATE KEY');
    await writeFile(join(oldRoot, 'config.json'), 'cfg');

    const ctx = testCtx(homeDir, join(baseDir, 'skip-ssh-cwd'));
    const plan = await planStateMigration(layout, ctx);
    const report = await runStateMigration(plan);

    assert.equal(report.copied.length, 1);
    assert.ok(report.copied.includes('config.json'));

    const allPaths = [
      ...report.copied,
      ...report.alreadyPresent,
      ...report.conflicts,
      ...report.merged,
    ];
    const sshRefs = allPaths.filter((p) => p.includes('.ssh'));
    assert.equal(sshRefs.length, 0);
  });
});

describe('runStateMigration — manifest', () => {
  it('writes manifest with correct final status', async () => {
    const layout = testLayout(join(baseDir, 'manifest-status'));
    const homeDir = join(baseDir, 'manifest-status-home');
    await mkdir(homeDir, { recursive: true });

    const oldRoot = join(homeDir, '.myshell-tools');
    await mkdir(oldRoot, { recursive: true });
    await writeFile(join(oldRoot, 'config.json'), 'config-data');

    const ctx = testCtx(homeDir, join(baseDir, 'manifest-status-cwd'));
    const plan = await planStateMigration(layout, ctx);
    const report = await runStateMigration(plan);

    assert.ok(report.manifestPath.length > 0);
    assert.equal(report.status, 'complete');

    const manifestRaw = await readFile(report.manifestPath, 'utf8');
    const manifest = JSON.parse(manifestRaw) as {
      status: string;
      timestamp: string;
      sourceRoots: string[];
      entries: Array<{ relativePath: string; status: string }>;
    };

    assert.equal(manifest.status, 'complete');
    assert.ok(typeof manifest.timestamp === 'string');
    assert.equal(manifest.entries.length, 1);
    assert.equal(manifest.entries[0]!.relativePath, 'config.json');
  });

  it('manifest status is conflicts when conflicts exist', async () => {
    const layout = testLayout(join(baseDir, 'manifest-conflict'));
    const homeDir = join(baseDir, 'manifest-conflict-home');
    await mkdir(homeDir, { recursive: true });

    const oldRoot = join(homeDir, '.myshell-tools');
    await mkdir(oldRoot, { recursive: true });
    await writeFile(join(oldRoot, 'config.json'), 'source-version');

    await mkdir(layout.configRoot, { recursive: true });
    await mkdir(layout.stateRoot, { recursive: true });
    await writeFile(layout.paths.configFile, 'dest-version');

    const ctx = testCtx(homeDir, join(baseDir, 'manifest-conflict-cwd'));
    const plan = await planStateMigration(layout, ctx);
    const report = await runStateMigration(plan);

    assert.equal(report.status, 'conflicts');

    const manifestRaw = await readFile(report.manifestPath, 'utf8');
    const manifest = JSON.parse(manifestRaw) as { status: string };
    assert.equal(manifest.status, 'conflicts');
  });
});

describe('runStateMigration — errors reported, never throws', () => {
  it('returns report with errors when a file operation fails', async () => {
    const layout = testLayout(join(baseDir, 'error-handling'));
    const homeDir = join(baseDir, 'error-handling-home');
    await mkdir(homeDir, { recursive: true });

    const oldRoot = join(homeDir, '.myshell-tools');
    await mkdir(oldRoot, { recursive: true });
    await writeFile(join(oldRoot, 'config.json'), 'data');

    // Path where parent is a file, not a directory → mkdir will fail
    const badLayout: AppStateLayout = {
      ...layout,
      paths: {
        ...layout.paths,
        configFile: join(layout.paths.migrationDir, 'stuck', 'config.json'),
      },
    };

    const ctx = testCtx(homeDir, join(baseDir, 'error-handling-cwd'));
    await mkdir(layout.paths.migrationDir, { recursive: true });
    await writeFile(join(layout.paths.migrationDir, 'stuck'), 'block');

    const plan = await planStateMigration(badLayout, ctx);
    // runStateMigration must never throw
    const report = await runStateMigration(plan);

    assert.ok(report.errors.length > 0);
    assert.ok(report.status === 'partial' || report.status === 'conflicts');
  });
});
