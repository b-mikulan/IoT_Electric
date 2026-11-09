const MAX_PENDING_BYTES = 8 * 1024 * 1024;
const writers = new WeakMap();

function createEventWriter(response, { maxPendingBytes = MAX_PENDING_BYTES } = {}) {
  let blocked = false;
  let closed = false;
  let pendingBytes = 0;
  const pending = [];

  function cleanup() {
    closed = true;
    pending.length = 0;
    pendingBytes = 0;
    response.off("drain", drain);
  }

  function fail() {
    cleanup();
    response.destroy();
    return false;
  }

  function write(chunk) {
    if (closed || response.destroyed || response.writableEnded) return false;
    if (blocked) {
      const bytes = Buffer.byteLength(chunk, "utf8");
      if (pendingBytes + bytes > maxPendingBytes) return fail();
      pending.push({ chunk, bytes });
      pendingBytes += bytes;
      return true;
    }
    try {
      // false means this chunk was accepted, but later chunks must wait.
      blocked = !response.write(chunk);
      return true;
    } catch {
      return fail();
    }
  }

  function drain() {
    if (closed) return;
    blocked = false;
    while (pending.length && !blocked && !closed) {
      const next = pending.shift();
      pendingBytes -= next.bytes;
      write(next.chunk);
    }
  }

  response.on("drain", drain);
  response.once("close", cleanup);
  response.once("error", fail);
  return write;
}

function writeChunk(response, chunk) {
  if (!writers.has(response)) writers.set(response, createEventWriter(response));
  return writers.get(response)(chunk);
}

function sendEvent(response, event, payload) {
  return writeChunk(response, `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function sendHeartbeat(response) {
  return writeChunk(response, ": heartbeat\n\n");
}

module.exports = { createEventWriter, sendEvent, sendHeartbeat };
