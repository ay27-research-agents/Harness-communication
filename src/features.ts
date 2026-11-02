export interface Features { directMessages: boolean; sharedSubjects: boolean; helpers: boolean; newIntelligence: boolean }
export const defaultFeatures: Features = { directMessages: true, sharedSubjects: true, helpers: true, newIntelligence: true };
export function features(value: unknown = {}): Features {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Features must be an object');
  for (const [key, enabled] of Object.entries(value)) {
    if (!Object.hasOwn(defaultFeatures, key) || typeof enabled !== 'boolean') throw new Error('Unknown feature or non-boolean setting: ' + key);
  }
  return Object.freeze({ ...defaultFeatures, ...value });
}
