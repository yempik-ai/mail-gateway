import { describe, expect, it } from 'vitest';
import { FEATURE_FLAG_DEFAULTS, loadFeatureFlags } from '../../packages/core/src/index.js';

describe('feature flags', () => {
  it('uses exactly the documented defaults', () => {
    expect(loadFeatureFlags({})).toEqual(FEATURE_FLAG_DEFAULTS);
  });

  it('allows supported flags to be disabled', () => {
    expect(loadFeatureFlags({ READ_EMAILS: 'false' }).READ_EMAILS).toBe(false);
    expect(loadFeatureFlags({ SEND_EMAILS: 'false' }).SEND_EMAILS).toBe(false);
  });

  it.each([
    'DELETE_RECEIVED_MESSAGES',
    'MOVE_MESSAGES',
    'MODIFY_RECEIVED_MESSAGES',
    'DOWNLOAD_ATTACHMENTS',
  ] as const)('rejects enabling %s', (name) => {
    expect(() => loadFeatureFlags({ [name]: 'true' })).toThrow(
      'A prohibited or unavailable capability cannot be enabled',
    );
  });
});
