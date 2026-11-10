// Stand-in for the `fs-xattr` package inside the bundled Storage API (supabase/storage). Its file
// backend keeps each object's content type, cache control and etag in extended attributes.
// - Windows has no xattrs and fs-xattr refuses to install there, so the values live in NTFS
//   alternate data streams (`<file>:<attribute>`), which move, copy and delete with the file.
// - macOS and Linux load fs-xattr's own N-API addon (built per platform by
//   scripts/desktop/fetch-backend.mjs) from MONEO_FS_XATTR_ADDON, so the on-disk format there is
//   exactly upstream's.
// Only the functions fs-xattr 0.4.0 exports are provided; listing attributes is not possible with
// Node's fs on Windows and Storage does not use it.
"use strict";
/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS on purpose: Storage's CommonJS build require()s it */
const fs = require("node:fs");

function argument(key, value) {
  if (key === "value") {
    if (typeof value === "string") return Buffer.from(value);
    if (Buffer.isBuffer(value)) return value;
    throw new TypeError("`value` must be a string or buffer");
  }
  if (typeof value === "string") return value;
  throw new TypeError(`\`${key}\` must be a string`);
}

function missingAttribute(path, attr) {
  const error = new Error(`No data available: ${path} (${attr})`);
  error.code = "ENODATA";
  error.errno = 61;
  return error;
}

function streamPath(path, attr) {
  if (/[:\\/]/.test(attr)) throw new TypeError("`attr` cannot contain ':', '/' or '\\' on Windows");
  fs.statSync(path); // ENOENT for a missing file instead of creating one through its stream
  return `${path}:${attr}`;
}

const windows = {
  get(path, attr) {
    const stream = streamPath(path, attr);
    try { return fs.readFileSync(stream); }
    catch (error) { throw error.code === "ENOENT" ? missingAttribute(path, attr) : error; }
  },
  set(path, attr, value) { fs.writeFileSync(streamPath(path, attr), value); },
  list() { throw Object.assign(new Error("Listing extended attributes is not supported on Windows"), { code: "ENOTSUP" }); },
  remove(path, attr) {
    const stream = streamPath(path, attr);
    try { fs.unlinkSync(stream); }
    catch (error) { throw error.code === "ENOENT" ? missingAttribute(path, attr) : error; }
  },
};

let addon;
function native() {
  if (!addon) {
    if (!process.env.MONEO_FS_XATTR_ADDON) throw new Error("MONEO_FS_XATTR_ADDON is not set");
    addon = require(process.env.MONEO_FS_XATTR_ADDON);
  }
  return addon;
}

const sync = process.platform === "win32" ? windows : {
  get: (path, attr) => native().getSync(path, attr),
  set: (path, attr, value) => native().setSync(path, attr, value),
  list: path => native().listSync(path),
  remove: (path, attr) => native().removeSync(path, attr),
};
const async = process.platform === "win32"
  ? Object.fromEntries(Object.entries(windows).map(([name, run]) => [name, (...args) => new Promise(resolve => resolve(run(...args)))]))
  : { get: (...args) => native().get(...args), set: (...args) => native().set(...args), list: (...args) => native().list(...args), remove: (...args) => native().remove(...args) };

exports.getAttribute = (path, attr) => async.get(argument("path", path), argument("attr", attr));
exports.setAttribute = (path, attr, value) => async.set(argument("path", path), argument("attr", attr), argument("value", value));
exports.listAttributes = path => async.list(argument("path", path));
exports.removeAttribute = (path, attr) => async.remove(argument("path", path), argument("attr", attr));
exports.getAttributeSync = (path, attr) => sync.get(argument("path", path), argument("attr", attr));
exports.setAttributeSync = (path, attr, value) => sync.set(argument("path", path), argument("attr", attr), argument("value", value));
exports.listAttributesSync = path => sync.list(argument("path", path));
exports.removeAttributeSync = (path, attr) => sync.remove(argument("path", path), argument("attr", attr));
