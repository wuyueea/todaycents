'use strict';

// DSH's Windows sandbox blocks child processes that use piped stdio. Vite 8
// probes mapped network drives with `exec("net use")` on first realpath
// resolution, which then fails with spawn EPERM even when every cache is
// writable. This preload only runs inside a DSH session and only intercepts
// that one probe; Vite then falls back to fs.realpathSync. Outside DSH the
// module is a no-op, so normal development and public CI are unaffected.

if (process.platform === 'win32' && process.env.DSH_SESSION_ID) {
  const childProcess = require('node:child_process');
  const realExec = childProcess.exec;

  childProcess.exec = function exec(command, options, callback) {
    const cb = typeof options === 'function' ? options : callback;
    if (typeof command === 'string' && /^\s*net\s+use(?:\s|$)/i.test(command)) {
      if (typeof cb === 'function') {
        process.nextTick(() => cb(new Error('net use skipped by dsh-vite-shim')));
      }
      // Vite ignores the returned ChildProcess; a minimal stub keeps the API.
      return { on() { return this; }, once() { return this; }, kill() { return this; } };
    }
    return realExec.apply(this, arguments);
  };
}
