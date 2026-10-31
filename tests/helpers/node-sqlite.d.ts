// Minimal ambient types for Node's built-in SQLite module.
//
// The project deliberately has no @types/node dependency, but tsconfig
// type-checks tests. This declares only the surface the test driver uses;
// it is test-only and must never be imported by product code.
declare module 'node:sqlite' {
  export type SQLInputValue = string | number | bigint | null | Uint8Array;

  export interface StatementSync {
    all(...params: SQLInputValue[]): unknown[];
    get(...params: SQLInputValue[]): unknown;
    run(...params: SQLInputValue[]): { changes: number; lastInsertRowid: number | bigint };
  }

  export class DatabaseSync {
    constructor(location: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
