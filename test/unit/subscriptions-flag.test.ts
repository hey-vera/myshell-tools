import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import { subscriptionsEnabled } from '../../src/interface/ui/subscriptions-flag.ts';

describe('subscriptionsEnabled', () => {
  it('default off: no config, no env → false', () => {
    assert.equal(subscriptionsEnabled(undefined, undefined), false);
  });

  it('default off: empty config, no env → false', () => {
    assert.equal(subscriptionsEnabled(undefined, {}), false);
  });

  it('default off: config.experimentalSubscriptions false → false', () => {
    assert.equal(
      subscriptionsEnabled(undefined, { experimentalSubscriptions: false }),
      false,
    );
  });

  it('default off: config without experimentalSubscriptions → false', () => {
    assert.equal(
      subscriptionsEnabled(undefined, {}),
      false,
    );
  });

  it('config.experimentalSubscriptions true → true', () => {
    assert.equal(
      subscriptionsEnabled(undefined, { experimentalSubscriptions: true }),
      true,
    );
  });

  it('env MYSHELL_SUBSCRIPTIONS=1 → true', () => {
    assert.equal(
      subscriptionsEnabled({ MYSHELL_SUBSCRIPTIONS: '1' }, undefined),
      true,
    );
  });

  it('env MYSHELL_SUBSCRIPTIONS=true → true', () => {
    assert.equal(
      subscriptionsEnabled({ MYSHELL_SUBSCRIPTIONS: 'true' }, undefined),
      true,
    );
  });

  it('env MYSHELL_SUBSCRIPTIONS=on → true', () => {
    assert.equal(
      subscriptionsEnabled({ MYSHELL_SUBSCRIPTIONS: 'on' }, undefined),
      true,
    );
  });

  it('env MYSHELL_SUBSCRIPTIONS=yes → true', () => {
    assert.equal(
      subscriptionsEnabled({ MYSHELL_SUBSCRIPTIONS: 'yes' }, undefined),
      true,
    );
  });

  it('env MYSHELL_SUBSCRIPTIONS=TRUE (case insensitive) → true', () => {
    assert.equal(
      subscriptionsEnabled({ MYSHELL_SUBSCRIPTIONS: 'TRUE' }, undefined),
      true,
    );
  });

  it('env MYSHELL_SUBSCRIPTIONS with whitespace → true', () => {
    assert.equal(
      subscriptionsEnabled({ MYSHELL_SUBSCRIPTIONS: '  1  ' }, undefined),
      true,
    );
  });

  it('env MYSHELL_SUBSCRIPTIONS=0 → false', () => {
    assert.equal(
      subscriptionsEnabled({ MYSHELL_SUBSCRIPTIONS: '0' }, undefined),
      false,
    );
  });

  it('env MYSHELL_SUBSCRIPTIONS=false → false', () => {
    assert.equal(
      subscriptionsEnabled({ MYSHELL_SUBSCRIPTIONS: 'false' }, undefined),
      false,
    );
  });

  it('env MYSHELL_SUBSCRIPTIONS=off → false', () => {
    assert.equal(
      subscriptionsEnabled({ MYSHELL_SUBSCRIPTIONS: 'off' }, undefined),
      false,
    );
  });

  it('env truthy enables even when config is false', () => {
    // config is checked first with === true; if config is false, we check env
    assert.equal(
      subscriptionsEnabled(
        { MYSHELL_SUBSCRIPTIONS: '1' },
        { experimentalSubscriptions: false },
      ),
      true,
    );
  });

  it('env MYSHELL_SUBSCRIPTIONS empty string → false', () => {
    assert.equal(
      subscriptionsEnabled({ MYSHELL_SUBSCRIPTIONS: '' }, undefined),
      false,
    );
  });
});
