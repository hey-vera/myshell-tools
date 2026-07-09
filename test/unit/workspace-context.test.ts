/**
 * test/unit/workspace-context.test.ts — P0.19 forge detector + P0.20 vocabulary.
 *
 * Pure classification/formatting fixtures (github.com, gitlab.com, other, no git)
 * plus impure detectWorkspaceContext over an injected port (no real git/PATH).
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import {
  parseGitRemoteV,
  extractRemoteHost,
  classifyRemoteUrl,
  classifyHostName,
  classifyForgeFromRemotes,
  buildWorkspaceContext,
  partnerForgeVocabulary,
  formatPartnerForgeBlock,
  formatForgeOrientationLine,
  mergeEnvironmentWithForge,
  forgeHostLabel,
  FORGE_BLOCK_CHAR_CAP,
  type WorkspaceContext,
} from '../../src/core/workspace-context.ts';
import {
  detectWorkspaceContext,
  type WorkspaceContextPort,
} from '../../src/infra/workspace-context.ts';

// ---------------------------------------------------------------------------
// parseGitRemoteV
// ---------------------------------------------------------------------------

describe('parseGitRemoteV', () => {
  it('parses fetch/push lines and ignores blanks', () => {
    const remotes = parseGitRemoteV(
      [
        'origin\tgit@github.com:acme/app.git (fetch)',
        'origin\tgit@github.com:acme/app.git (push)',
        '',
        'upstream  https://gitlab.com/acme/app.git (fetch)',
      ].join('\n'),
    );
    assert.equal(remotes.length, 3);
    assert.deepEqual(remotes[0], {
      name: 'origin',
      url: 'git@github.com:acme/app.git',
      purpose: 'fetch',
    });
    assert.equal(remotes[2]?.name, 'upstream');
    assert.equal(remotes[2]?.purpose, 'fetch');
  });

  it('returns [] for empty / garbage', () => {
    assert.deepEqual(parseGitRemoteV(''), []);
    assert.deepEqual(parseGitRemoteV('not a remote line'), []);
  });
});

// ---------------------------------------------------------------------------
// host classification
// ---------------------------------------------------------------------------

describe('extractRemoteHost + classifyRemoteUrl', () => {
  it('classifies github scp, https, and ssh URLs', () => {
    assert.equal(extractRemoteHost('git@github.com:acme/app.git'), 'github.com');
    assert.equal(classifyRemoteUrl('git@github.com:acme/app.git'), 'github');
    assert.equal(
      classifyRemoteUrl('https://github.com/acme/app.git'),
      'github',
    );
    assert.equal(
      classifyRemoteUrl('ssh://git@github.com/acme/app.git'),
      'github',
    );
    assert.equal(classifyHostName('github.mycorp.com'), 'github');
  });

  it('classifies gitlab.com and self-managed gitlab hosts', () => {
    assert.equal(classifyRemoteUrl('git@gitlab.com:group/proj.git'), 'gitlab');
    assert.equal(
      classifyRemoteUrl('https://gitlab.com/group/proj.git'),
      'gitlab',
    );
    assert.equal(classifyHostName('gitlab.example.com'), 'gitlab');
  });

  it('classifies bitbucket / codeberg / unknown as other', () => {
    assert.equal(
      classifyRemoteUrl('https://bitbucket.org/acme/app.git'),
      'other',
    );
    assert.equal(
      classifyRemoteUrl('git@codeberg.org:acme/app.git'),
      'other',
    );
    assert.equal(classifyHostName('git.internal.corp'), 'other');
  });
});

describe('classifyForgeFromRemotes', () => {
  it('prefers origin fetch over other remotes', () => {
    const remotes = parseGitRemoteV(
      [
        'upstream\tgit@gitlab.com:acme/app.git (fetch)',
        'origin\tgit@github.com:acme/app.git (fetch)',
      ].join('\n'),
    );
    const r = classifyForgeFromRemotes(remotes);
    assert.equal(r.hostClass, 'github');
    assert.match(r.primaryRemoteUrl ?? '', /github\.com/);
  });

  it('returns none when there are no remotes', () => {
    assert.deepEqual(classifyForgeFromRemotes([]), {
      hostClass: 'none',
      primaryRemoteUrl: null,
    });
  });
});

// ---------------------------------------------------------------------------
// buildWorkspaceContext + vocabulary + formatters
// ---------------------------------------------------------------------------

function ctx(over: Partial<WorkspaceContext> = {}): WorkspaceContext {
  return {
    cwd: '/work',
    gitRoot: '/work',
    remotes: [],
    hostClass: 'none',
    primaryRemoteUrl: null,
    tools: { gh: false, glab: false },
    ...over,
  };
}

describe('buildWorkspaceContext', () => {
  it('github.com remote → github', () => {
    const remotes = parseGitRemoteV(
      'origin\tgit@github.com:acme/app.git (fetch)\n',
    );
    const w = buildWorkspaceContext({
      cwd: '/work',
      gitRoot: '/work',
      remotes,
      tools: { gh: true, glab: false },
    });
    assert.equal(w.hostClass, 'github');
    assert.equal(w.tools.gh, true);
  });

  it('gitlab.com remote → gitlab', () => {
    const remotes = parseGitRemoteV(
      'origin\thttps://gitlab.com/g/p.git (fetch)\n',
    );
    const w = buildWorkspaceContext({
      cwd: '/work',
      gitRoot: '/work',
      remotes,
      tools: { gh: false, glab: true },
    });
    assert.equal(w.hostClass, 'gitlab');
  });

  it('other remote → other', () => {
    const remotes = parseGitRemoteV(
      'origin\thttps://bitbucket.org/acme/app.git (fetch)\n',
    );
    const w = buildWorkspaceContext({
      cwd: '/work',
      gitRoot: '/work',
      remotes,
      tools: { gh: false, glab: false },
    });
    assert.equal(w.hostClass, 'other');
  });

  it('no git root → none and drops remotes', () => {
    const remotes = parseGitRemoteV(
      'origin\tgit@github.com:acme/app.git (fetch)\n',
    );
    const w = buildWorkspaceContext({
      cwd: '/tmp',
      gitRoot: null,
      remotes,
      tools: { gh: true, glab: false },
    });
    assert.equal(w.hostClass, 'none');
    assert.equal(w.remotes.length, 0);
    assert.equal(w.primaryRemoteUrl, null);
  });

  it('git root but no remotes → none (local-only)', () => {
    const w = buildWorkspaceContext({
      cwd: '/work',
      gitRoot: '/work',
      remotes: [],
      tools: { gh: false, glab: false },
    });
    assert.equal(w.hostClass, 'none');
  });
});

describe('partnerForgeVocabulary', () => {
  it('github → PR / checks', () => {
    const v = partnerForgeVocabulary(ctx({ hostClass: 'github', tools: { gh: true, glab: false } }));
    assert.equal(v.changeRequest, 'PR');
    assert.equal(v.ciLabel, 'checks');
    assert.equal(v.localOnly, false);
    assert.match(v.cliHint ?? '', /gh is on PATH/);
  });

  it('gitlab → MR / pipelines', () => {
    const v = partnerForgeVocabulary(
      ctx({ hostClass: 'gitlab', tools: { gh: false, glab: true } }),
    );
    assert.equal(v.changeRequest, 'MR');
    assert.equal(v.ciLabel, 'pipelines');
    assert.match(v.cliHint ?? '', /glab is on PATH/);
  });

  it('none → local-only honesty', () => {
    const v = partnerForgeVocabulary(ctx({ hostClass: 'none' }));
    assert.equal(v.localOnly, true);
    assert.equal(v.cliHint, null);
  });
});

describe('formatPartnerForgeBlock', () => {
  it('renders github vocabulary and tools', () => {
    const block = formatPartnerForgeBlock(
      ctx({
        hostClass: 'github',
        primaryRemoteUrl: 'git@github.com:acme/app.git',
        tools: { gh: true, glab: false },
      }),
    );
    assert.match(block, /WORKSPACE FORGE/);
    assert.match(block, /pull request \(PR\)/i);
    assert.match(block, /checks/i);
    assert.match(block, /gh on PATH/);
    assert.ok(block.length <= FORGE_BLOCK_CHAR_CAP);
  });

  it('renders gitlab MR / pipelines language', () => {
    const block = formatPartnerForgeBlock(
      ctx({
        hostClass: 'gitlab',
        primaryRemoteUrl: 'https://gitlab.com/g/p.git',
        tools: { gh: false, glab: false },
      }),
    );
    assert.match(block, /merge request \(MR\)/i);
    assert.match(block, /pipelines/i);
    assert.match(block, /do not assume gh/i);
  });

  it('renders local-only honesty without PR theater', () => {
    const block = formatPartnerForgeBlock(
      ctx({ hostClass: 'none', gitRoot: null }),
    );
    assert.match(block, /local-only/i);
    assert.match(block, /no PR\/MR theater/i);
    assert.doesNotMatch(block, /prefer gh for PRs/);
  });

  it('is deterministic', () => {
    const c = ctx({
      hostClass: 'other',
      primaryRemoteUrl: 'https://codeberg.org/a/b.git',
    });
    assert.equal(formatPartnerForgeBlock(c), formatPartnerForgeBlock(c));
  });
});

describe('formatForgeOrientationLine', () => {
  it('returns null for github (default — no spam)', () => {
    assert.equal(
      formatForgeOrientationLine(
        ctx({
          hostClass: 'github',
          primaryRemoteUrl: 'git@github.com:a/b.git',
        }),
      ),
      null,
    );
  });

  it('surfaces gitlab MR language', () => {
    const line = formatForgeOrientationLine(
      ctx({ hostClass: 'gitlab', tools: { gh: false, glab: true } }),
    );
    assert.match(line ?? '', /GitLab/);
    assert.match(line ?? '', /MR/);
    assert.match(line ?? '', /glab ready/);
  });

  it('surfaces other forge without gh assumptions', () => {
    const line = formatForgeOrientationLine(
      ctx({
        hostClass: 'other',
        primaryRemoteUrl: 'https://bitbucket.org/a/b.git',
      }),
    );
    assert.match(line ?? '', /bitbucket\.org/);
    assert.match(line ?? '', /no gh assumptions/);
  });

  it('surfaces local-only', () => {
    assert.match(
      formatForgeOrientationLine(ctx({ hostClass: 'none', gitRoot: '/work' })) ??
        '',
      /Local-only/,
    );
    assert.match(
      formatForgeOrientationLine(ctx({ hostClass: 'none', gitRoot: null })) ?? '',
      /No git repo/,
    );
  });
});

describe('mergeEnvironmentWithForge', () => {
  it('appends forge under environment', () => {
    const merged = mergeEnvironmentWithForge(
      'ENVIRONMENT\n  cwd: /work',
      ctx({ hostClass: 'gitlab', primaryRemoteUrl: 'https://gitlab.com/g/p.git' }),
    );
    assert.match(merged, /^ENVIRONMENT/);
    assert.match(merged, /WORKSPACE FORGE/);
    assert.match(merged, /merge request/i);
  });

  it('returns forge alone when env empty', () => {
    const merged = mergeEnvironmentWithForge(
      '',
      ctx({ hostClass: 'none', gitRoot: null }),
    );
    assert.match(merged, /WORKSPACE FORGE/);
  });
});

describe('forgeHostLabel', () => {
  it('includes host when known', () => {
    assert.match(
      forgeHostLabel(
        ctx({
          hostClass: 'github',
          primaryRemoteUrl: 'https://github.com/a/b.git',
        }),
      ),
      /GitHub \(github\.com\)/,
    );
  });
});

// ---------------------------------------------------------------------------
// detectWorkspaceContext (injected port)
// ---------------------------------------------------------------------------

function fakePort(over: Partial<WorkspaceContextPort> = {}): WorkspaceContextPort {
  return {
    gitToplevel: async () => null,
    gitRemoteV: async () => '',
    toolOnPath: async () => false,
    ...over,
  };
}

describe('detectWorkspaceContext (injected port)', () => {
  it('github remote + gh on PATH', async () => {
    const w = await detectWorkspaceContext('/repo', fakePort({
      gitToplevel: async () => '/repo',
      gitRemoteV: async () =>
        'origin\tgit@github.com:acme/app.git (fetch)\norigin\tgit@github.com:acme/app.git (push)\n',
      toolOnPath: async (n) => n === 'gh',
    }));
    assert.equal(w.hostClass, 'github');
    assert.equal(w.tools.gh, true);
    assert.equal(w.tools.glab, false);
    assert.match(formatPartnerForgeBlock(w), /pull request/i);
  });

  it('gitlab remote + glab on PATH', async () => {
    const w = await detectWorkspaceContext('/repo', fakePort({
      gitToplevel: async () => '/repo',
      gitRemoteV: async () =>
        'origin\thttps://gitlab.com/group/proj.git (fetch)\n',
      toolOnPath: async (n) => n === 'glab',
    }));
    assert.equal(w.hostClass, 'gitlab');
    assert.equal(w.tools.glab, true);
    assert.match(formatPartnerForgeBlock(w), /merge request/i);
  });

  it('other remote', async () => {
    const w = await detectWorkspaceContext('/repo', fakePort({
      gitToplevel: async () => '/repo',
      gitRemoteV: async () =>
        'origin\thttps://git.example.com/a/b.git (fetch)\n',
    }));
    assert.equal(w.hostClass, 'other');
  });

  it('no git → none', async () => {
    const w = await detectWorkspaceContext('/tmp/not-a-repo', fakePort());
    assert.equal(w.hostClass, 'none');
    assert.equal(w.gitRoot, null);
  });

  it('fail-soft when port throws', async () => {
    const w = await detectWorkspaceContext('/x', fakePort({
      gitToplevel: async () => {
        throw new Error('boom');
      },
    }));
    assert.equal(w.hostClass, 'none');
  });
});
