"use strict";

// JSZip uses setImmediate only to yield between chunks. A timer preserves that
// macrotask boundary without the legacy polyfill's script/iframe/eval paths.
if (typeof globalThis.setImmediate !== "function") {
  const timers = new Map();
  let nextId = 1;
  globalThis.setImmediate = (callback, ...args) => {
    if (typeof callback !== "function") throw new TypeError("setImmediate callback must be a function");
    const id = nextId++;
    timers.set(id, setTimeout(() => {
      timers.delete(id);
      callback(...args);
    }, 0));
    return id;
  };
  globalThis.clearImmediate = (id) => {
    const timer = timers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    timers.delete(id);
  };
}
