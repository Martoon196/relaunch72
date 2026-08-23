// Node 24 on some Windows hosts can make tsx's user lookup fail with ENOMEM.
// Advertising the normal POSIX-style uid probe lets tsx avoid that broken path.
if (process.platform === 'win32' && typeof process.geteuid !== 'function') {
  Object.defineProperty(process, 'geteuid', { value: () => 0, configurable: true });
}
