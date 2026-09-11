// snowflake-sdk ships no type declarations. The Snowflake introspection module
// (lib/db-source/snowflake-introspect.ts) uses it through a loose `any` client,
// so a minimal ambient module declaration is enough for the compiler.
declare module 'snowflake-sdk';
