const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createEventWriter, sendEvent, sendHeartbeat } = require("../lib/http/eventStream");

class Response extends EventEmitter {
  constructor(results = []) { super(); this.results = results; this.chunks = []; this.destroyed = false; }
  write(chunk) {
    const result = this.results.shift() ?? true;
    if (result instanceof Error) throw result;
    this.chunks.push(chunk);
    return result;
  }
  destroy() { this.destroyed = true; this.emit("close"); }
}

test("backpressure accepts a large event once and queues sync and heartbeat until drain", () => {
  const response = new Response([false, true, true]);
  const payload = { widgets: [{ value: "x".repeat(256 * 1024) }] };
  assert.equal(sendEvent(response, "update", payload), true);
  assert.equal(sendEvent(response, "sync", { status: "connected" }), true);
  assert.equal(sendHeartbeat(response), true);
  assert.equal(response.destroyed, false);
  assert.equal(response.chunks.length, 1);
  response.emit("drain");
  assert.equal(response.chunks.length, 3);
  assert.equal(response.chunks[0], `event: update\ndata: ${JSON.stringify(payload)}\n\n`);
  assert.equal(response.chunks[1], 'event: sync\ndata: {"status":"connected"}\n\n');
  assert.equal(response.chunks[2], ": heartbeat\n\n");
});

test("repeated backpressure preserves order without retrying already accepted chunks", () => {
  const response = new Response([false, false, true]);
  const write = createEventWriter(response);
  for (const chunk of ["one", "two", "three"]) assert.equal(write(chunk), true);
  response.emit("drain");
  assert.deepEqual(response.chunks, ["one", "two"]);
  response.emit("drain");
  response.emit("drain");
  assert.deepEqual(response.chunks, ["one", "two", "three"]);
});

test("a stalled client is disconnected at the UTF-8 pending-byte limit", () => {
  const response = new Response([false]);
  const write = createEventWriter(response, { maxPendingBytes: 4 });
  assert.equal(write("initial"), true);
  assert.equal(write("čč"), true);
  assert.equal(write("x"), false);
  assert.equal(response.destroyed, true);
  response.emit("drain");
  assert.deepEqual(response.chunks, ["initial"]);
  assert.equal(response.listenerCount("drain"), 0);
});

test("disconnects discard pending events and subsequent writes are rejected", () => {
  const response = new Response([false]);
  const write = createEventWriter(response);
  write("initial"); write("queued");
  response.destroy();
  response.emit("drain");
  assert.equal(write("later"), false);
  assert.deepEqual(response.chunks, ["initial"]);
});

test("write and asynchronous stream failures close only their own client", () => {
  const response = new Response([false, new Error("socket failed")]);
  const write = createEventWriter(response);
  write("initial"); write("queued");
  assert.doesNotThrow(() => response.emit("drain"));
  assert.equal(response.destroyed, true);
  assert.equal(write("later"), false);
  const other = new Response();
  assert.equal(sendEvent(other, "sync", {}), true);
  assert.doesNotThrow(() => other.emit("error", new Error("connection closed")));
  assert.equal(other.destroyed, true);
});
