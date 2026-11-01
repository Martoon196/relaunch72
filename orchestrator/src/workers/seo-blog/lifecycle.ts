/** Keep a deliberately disabled Render worker alive without loading a pool. */
export function idleUntilShutdown(): Promise<void> {
  return new Promise((resolve) => {
    // Signal listeners alone do not keep Node's event loop alive.
    const keepAlive = setInterval(() => {}, 60_000);
    const stop = () => {
      clearInterval(keepAlive);
      process.off('SIGTERM', stop);
      process.off('SIGINT', stop);
      resolve();
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  });
}
