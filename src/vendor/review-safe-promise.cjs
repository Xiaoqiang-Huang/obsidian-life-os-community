"use strict";

// Obsidian's supported Electron runtime has native Promise. JSZip's fallback
// branch may be bundled statically, but it must not pull in `lie`/`immediate`.
if (typeof Promise !== "function") throw new Error("Native Promise is required by this plugin");
module.exports = Promise;
