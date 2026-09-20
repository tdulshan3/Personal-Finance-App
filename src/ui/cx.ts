/**
 * Joins class names, skipping anything falsy.
 *
 * Returns `undefined` rather than an empty string so React omits the attribute, and so the result
 * satisfies `exactOptionalPropertyTypes` when it is passed straight to `className`.
 */
export function cx(...parts: readonly (string | false | null | undefined)[]): string | undefined {
  const joined = parts.filter((part): part is string => Boolean(part)).join(" ");
  return joined.length > 0 ? joined : undefined;
}
