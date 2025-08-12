import type { AnalyticsEvent } from './eventTypes';

const QUEUE_CAP = 1000; // safety cap
const FLUSH_INTERVAL_MS = 1000;
let queue: AnalyticsEvent[] = [];
let dropped = 0;
let flushing = false;

export function track(event: AnalyticsEvent) {
  if (queue.length >= QUEUE_CAP) { dropped++; return; }
  queue.push(event);
}

export function drain(): AnalyticsEvent[] { const out = queue; queue = []; return out; }

async function flush() {
  if (flushing) return;
  flushing = true;
  try {
    if (queue.length === 0) return;
    const batch = drain();
    // Phase 0: just log; Phase 1 will persist to DB
    try { console.log('[analytics] batch', { size: batch.length, dropped }); } catch {}
    // placeholder sink wiring will be added in Phase 1
  } finally {
    flushing = false;
  }
}

setInterval(flush, FLUSH_INTERVAL_MS).unref?.();


