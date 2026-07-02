import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import { semanticPreflightV1Enabled } from '../../src/interface/ui/semantic-preflight-flag.ts';

describe('semanticPreflightV1Enabled', () => {
  it('semantic preflight flag defaults false for absent false zero and garbage', () => {
    for (const raw of [undefined, '', '0', 'false', 'off', 'no', 'garbage']) {
      const env: NodeJS.ProcessEnv = {};
      if (raw !== undefined) env['MYSHELL_SEMANTIC_PREFLIGHT_V1'] = raw;
      assert.equal(semanticPreflightV1Enabled(env, undefined), false, `env=${String(raw)}`);
    }
    assert.equal(
      semanticPreflightV1Enabled({}, { experimentalSemanticPreflightV1: false }),
      false,
    );
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
