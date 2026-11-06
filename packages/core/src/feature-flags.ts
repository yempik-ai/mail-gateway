import { z } from 'zod';

export const FEATURE_FLAG_DEFAULTS = {
  READ_EMAILS: true,
  SEARCH_EMAILS: true,
  READ_THREADS: true,
  CREATE_DRAFTS: true,
  CREATE_REPLY_DRAFTS: true,
  UPDATE_DRAFTS: true,
  DELETE_GATEWAY_DRAFTS: true,
  SEND_EMAILS: true,
  DELETE_RECEIVED_MESSAGES: false,
  MOVE_MESSAGES: false,
  MODIFY_RECEIVED_MESSAGES: false,
  DOWNLOAD_ATTACHMENTS: false,
} as const;

export type FeatureFlagName = keyof typeof FEATURE_FLAG_DEFAULTS;
export type FeatureFlags = { readonly [K in FeatureFlagName]: boolean };

const booleanEnvironmentValue = z.enum(['true', 'false']).transform((value) => value === 'true');

const featureFlagEnvironmentSchema = z
  .object(
    Object.fromEntries(
      Object.keys(FEATURE_FLAG_DEFAULTS).map((key) => [key, booleanEnvironmentValue.optional()]),
    ) as Record<FeatureFlagName, z.ZodOptional<typeof booleanEnvironmentValue>>,
  )
  .passthrough();

export function loadFeatureFlags(environment: NodeJS.ProcessEnv = process.env): FeatureFlags {
  const configured = featureFlagEnvironmentSchema.parse(environment);
  const flags = Object.fromEntries(
    Object.entries(FEATURE_FLAG_DEFAULTS).map(([name, fallback]) => [
      name,
      configured[name as FeatureFlagName] ?? fallback,
    ]),
  ) as FeatureFlags;

  if (
    flags.DELETE_RECEIVED_MESSAGES ||
    flags.MOVE_MESSAGES ||
    flags.MODIFY_RECEIVED_MESSAGES ||
    flags.DOWNLOAD_ATTACHMENTS
  ) {
    throw new Error('A prohibited or unavailable capability cannot be enabled');
  }

  return Object.freeze(flags);
}
