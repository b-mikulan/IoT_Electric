// The one way the dashboard backend calls the middleware: Basic credentials,
// a time limit that covers the whole reply, JSON in and out.
async function middlewareRequest({ fetchImpl = globalThis.fetch, middlewareUrl, username, password, timeoutMs }, endpoint, body) {
  const controller = new AbortController();
  // A referenced timer (unlike AbortSignal.timeout): it fires even when nothing else is pending.
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${middlewareUrl}${endpoint}`, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    const ok = Boolean(response?.ok);
    // A successful reply must be JSON; an error reply may carry none.
    const payload = ok ? await response.json() : await Promise.resolve().then(() => response.json()).catch(() => null);
    return { ok, status: response?.status, payload };
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { timedOut: controller.signal.aborted });
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { middlewareRequest };
