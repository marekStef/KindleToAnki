export function env(name, fallback = undefined) {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

export function toInt(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

export function assert(condition, msg, status = 400) {
  if (!condition) {
    const err = new Error(msg || "Invalid request");
    err.status = status;
    throw err;
  }
}