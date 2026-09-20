/**
 * The package ships an `index.d.ts` but its `package.json` "exports" map does not point at it, so
 * NodeNext resolution cannot find it. Rather than loosening module resolution for the whole
 * project, the module is declared opaque here: `src/core/data/driver.ts` defines the narrow shape
 * it actually uses and casts once, at the single dynamic import.
 */
declare module "better-sqlite3-multiple-ciphers" {
  const Database: unknown;
  export default Database;
}
