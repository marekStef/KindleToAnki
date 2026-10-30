// Thin helpers around sql.js (SQLite compiled to WebAssembly).
// Pure JS/WASM means no native rebuilds for Electron on Windows or macOS.

import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

let sqlPromise = null;

/** Lazily initialise sql.js once per process. */
export function getSql() {
  if (!sqlPromise) {
    const initSqlJs = require("sql.js");
    const wasmPath = require.resolve("sql.js/dist/sql-wasm.wasm");
    // Passing the binary directly works both from disk and from inside app.asar.
    sqlPromise = initSqlJs({ wasmBinary: fs.readFileSync(wasmPath) });
  }
  return sqlPromise;
}

/** Open a database from a Buffer/Uint8Array (or an empty one when omitted). */
export async function openDatabase(bytes) {
  const SQL = await getSql();
  return bytes ? new SQL.Database(bytes) : new SQL.Database();
}

/** Run a query and return every row as a plain object. */
export function all(db, sql, params = []) {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    return rows;
  } finally {
    stmt.free();
  }
}

/** First row of a query, or undefined. */
export function get(db, sql, params = []) {
  return all(db, sql, params)[0];
}
