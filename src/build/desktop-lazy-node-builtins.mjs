import { builtinModules } from 'node:module';
const allowed = new Set(builtinModules.flatMap(name => [name, name.startsWith('node:') ? name : 'node:' + name]));
/** Electron renderer import() is a browser module fetch, even in a CJS plugin.
 * Bundle a lazy CJS bridge for Node builtins only. It runs only after the desktop
 * call-site guard, never evaluates arbitrary paths, and leaves static imports alone. */
export const desktopLazyNodeBuiltins = {
  name: 'lifeos-desktop-lazy-node-builtins',
  setup(build) {
    build.onResolve({ filter: /^[a-z][a-z0-9_:/.-]*$/ }, args => {
      if (args.kind !== 'dynamic-import' || !allowed.has(args.path)) return;
      return { path: args.path, namespace: 'lifeos-lazy-node-builtin' };
    });
    build.onLoad({ filter: /.*/, namespace: 'lifeos-lazy-node-builtin' }, args => ({
      contents: 'module.exports = require(' + JSON.stringify(args.path) + ');', loader: 'js'
    }));
  }
};
