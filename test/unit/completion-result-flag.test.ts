import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import { completionResultV1Enabled } from '../../src/interface/ui/completion-result-flag.ts';

describe('completionResultV1Enabled', () => {
  it('completion result defaults on for absent and garbage values', () => {
    for (const raw of [undefined, '', 'garbage']) {
      const env: NodeJS.ProcessEnv = {};
      if (raw !== undefined) env['MYSHELL_COMPLETION_RESULT_V1'] = raw;
      assert.equal(completionResultV1Enabled(env, undefined), true, `env=${String(raw)}`);
    }
  });

  it('explicit env/config false disables V1', () => {
    for (const raw of ['0', 'false', 'FALSE', ' off ', 'no']) {
      assert.equal(
        completionResultV1Enabled(
          { MYSHELL_COMPLETION_RESULT_V1: raw },
          { experimentalCompletionResultV1: true },
        ),
        false,
        `env=${raw}`,
      );
    }
    assert.equal(completionResultV1Enabled({}, { experimentalCompletionResultV1: false }), false);
  });

  it('explicit env or config true enables V1', () => {
    for (const raw of ['1', 'true', 'TRUE', ' on ', 'yes']) {
      assert.equal(
        completionResultV1Enabled(
          { MYSHELL_COMPLETION_RESULT_V1: raw },
          { experimentalCompletionResultV1: false },
        ),
        true,
        `env=${raw}`,
      );
    }
    assert.equal(completionResultV1Enabled({}, { experimentalCompletionResultV1: true }), true);
  });
});
