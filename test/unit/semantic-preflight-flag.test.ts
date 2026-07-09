import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import { semanticPreflightV1Enabled } from '../../src/interface/ui/semantic-preflight-flag.ts';

describe('semanticPreflightV1Enabled', () => {
  it('semantic preflight defaults on for absent and garbage values', () => {
    for (const raw of [undefined, '', 'garbage']) {
      const env: NodeJS.ProcessEnv = {};
      if (raw !== undefined) env['MYSHELL_SEMANTIC_PREFLIGHT_V1'] = raw;
      assert.equal(semanticPreflightV1Enabled(env, undefined), true, `env=${String(raw)}`);
    }
  });

  it('explicit env/config false disables V1', () => {
    for (const raw of ['0', 'false', 'FALSE', ' off ', 'no']) {
      assert.equal(
        semanticPreflightV1Enabled(
          { MYSHELL_SEMANTIC_PREFLIGHT_V1: raw },
          { experimentalSemanticPreflightV1: true },
        ),
        false,
        `env=${raw}`,
      );
    }
    assert.equal(semanticPreflightV1Enabled({}, { experimentalSemanticPreflightV1: false }), false);
  });

  it('explicit env or config true enables V1', () => {
    for (const raw of ['1', 'true', 'TRUE', ' on ', 'yes']) {
      assert.equal(
        semanticPreflightV1Enabled(
          { MYSHELL_SEMANTIC_PREFLIGHT_V1: raw },
          { experimentalSemanticPreflightV1: false },
        ),
        true,
        `env=${raw}`,
      );
    }
    assert.equal(semanticPreflightV1Enabled({}, { experimentalSemanticPreflightV1: true }), true);
  });
});
