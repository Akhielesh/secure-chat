// Minimal analytics emitter for server-side usage
// Provides track(event) used by server.js; batches can be added later

const queue = [];
let lastFlush = 0;

function track(event) {
  try {
    // Basic validation
    if (!event || typeof event !== 'object') return;
    queue.push({ ...event });
    const now = Date.now();
    if (now - lastFlush > 1000 || queue.length > 1000) {
      // For now, just drop the queue; hook to real sink later
      queue.length = 0;
      lastFlush = now;
    }
  } catch {
    // swallow
  }
}

module.exports = { track };


