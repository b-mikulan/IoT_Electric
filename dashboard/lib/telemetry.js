const asArray = (value) => value == null || value === "" ? [] : Array.isArray(value) ? value : [value];

function failure(message, status = 502, code = "TELEMETRY_FAILED") {
  return Object.assign(new Error(message), { status, code });
}

function queryOptions(kind, body = {}) {
  const options = {};
  for (const key of ["historyItemId", "timeFrom", "timeTo", "moreDataRef"]) {
    if (body[key] === undefined || body[key] === "") continue;
    if (typeof body[key] !== "string" || body[key].length > 4096) {
      throw failure(`Neispravno polje: ${key}.`, 400, "INVALID_QUERY");
    }
    options[key] = body[key].trim();
  }
  if (kind === "history") {
    if (!options.historyItemId || !options.timeFrom || !options.timeTo) {
      throw failure("Odaberi trend i vremenski raspon.", 400, "INVALID_QUERY");
    }
    for (const key of ["timeFrom", "timeTo"]) {
      if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(options[key]) || !Number.isFinite(Date.parse(options[key]))) {
        throw failure("Datum mora sadržavati vremensku zonu.", 400, "INVALID_QUERY");
      }
      options[key] = new Date(options[key]).toISOString();
    }
    if (options.timeFrom >= options.timeTo) {
      throw failure("Početak mora biti prije kraja razdoblja.", 400, "INVALID_QUERY");
    }
  } else {
    delete options.historyItemId;
    delete options.timeFrom;
    delete options.timeTo;
  }
  return options;
}

function normalizeResponse(kind, payload) {
  const prefix = kind === "history" ? "GetHistory" : "GetAlarmEvents";
  const status = payload?.[`${prefix}ResponseStatus`];
  const errors = asArray(payload?.[`${prefix}ErrorResults`]?.ErrorResult);
  if (errors.length) {
    throw failure(errors.map((item) => String(item.Message || "EWS greška.")).join("; "));
  }
  if (!status || typeof status !== "object") {
    throw failure("Middleware je vratio neprepoznatljiv odgovor.");
  }
  const moreDataAvailable = status.MoreDataAvailable === true || status.MoreDataAvailable === "true";
  const moreDataRef = String(status.MoreDataRef ?? "");
  if (moreDataAvailable && !moreDataRef) throw failure("Nedostaje oznaka za nastavak dohvata.");
  const common = { moreDataAvailable, moreDataRef: moreDataAvailable ? moreDataRef : null };
  if (kind === "history") {
    const records = payload.GetHistoryHistoryRecords || {};
    return {
      ...common,
      unit: String(records.Unit || ""),
      valueItemId: String(records.ValueItemId || ""),
      rows: asArray(records.List?.HistoryRecord).map((row) => ({
        timestamp: String(row.TimeStamp ?? ""), value: row.Value ?? null, state: row.State ?? null,
      })),
    };
  }
  return {
    ...common,
    needsRefresh: status.NeedsRefresh === true || status.NeedsRefresh === "true",
    rows: asArray(payload.GetAlarmEventsAlarmEvents?.AlarmEvent).map((row) => ({
      id: String(row.ID ?? ""), sourceId: String(row.SourceID ?? ""),
      source: String(row.SourceName ?? ""), message: String(row.Message ?? ""),
      occurredAt: String(row.TimeStampOccurrence ?? ""), timestamp: String(row.TimeStampTransition ?? ""),
      priority: row.Priority ?? null, state: row.State ?? null, type: String(row.Type ?? ""),
    })),
  };
}

class TelemetryClient {
  constructor(config, fetchImpl = globalThis.fetch) {
    this.config = config;
    this.fetch = fetchImpl;
  }

  async request(endpoint, body) {
    const { middlewareUrl, username, password, timeoutMs } = this.config;
    try {
      const response = await this.fetch(`${middlewareUrl.replace(/\/+$/, "")}${endpoint}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Accept: "application/json", "Content-Type": "application/json",
          Authorization: `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs || 10000),
      });
      const payload = await response.json();
      // Also recognize faults from older middleware deployments that returned HTTP 200.
      if (payload?.soapFault) {
        const reason = String(payload.soapFault.reason || "EWS greška.");
        throw failure(`Kontroler je odbio zahtjev: ${reason}`);
      }
      if (!response.ok) throw failure(`Middleware je odbio dohvat (${response.status}).`);
      if (payload?.error) throw failure("Middleware je prijavio grešku pri dohvatu.");
      return payload;
    } catch (error) {
      if (error.code === "TELEMETRY_FAILED") throw error;
      if (error.name === "TimeoutError" || error.name === "AbortError") {
        throw failure("Isteklo je vrijeme za dohvat. Pokušaj ponovno.", 504, "TELEMETRY_TIMEOUT");
      }
      throw failure("Dohvat preko middlewarea nije uspio.");
    }
  }

  async browse(containerId = "") {
    if (typeof containerId !== "string" || containerId.length > 4096) {
      throw failure("Neispravan ID mape.", 400, "INVALID_QUERY");
    }
    if (this.config.demoMode) return { items: [{ id: "demo-history", name: "Demo temperatura", kind: "history", unit: "°C" }], errors: [] };
    const payload = await this.request(`/api/containers?id=${encodeURIComponent(containerId.trim())}`);
    const items = [];
    for (const container of asArray(payload.containers)) {
      for (const child of asArray(container.containerItems)) {
        items.push({ id: child.id, name: child.name || child.id, kind: "container", unit: "" });
      }
      for (const item of asArray(container.historyItems)) {
        items.push({ id: String(item.Id), name: String(item.Name || item.Id), kind: "history", unit: String(item.Unit || "") });
      }
    }
    return { items, errors: asArray(payload.errors) };
  }

  async query(kind, body) {
    const options = queryOptions(kind, body);
    if (this.config.demoMode) {
      if (kind === "history") {
        const from = Date.parse(options.timeFrom), to = Date.parse(options.timeTo);
        return { moreDataAvailable: false, moreDataRef: null, unit: "°C", rows: Array.from({ length: 49 }, (_, i) => ({
          timestamp: new Date(from + (to - from) * i / 48).toISOString(),
          value: Math.round((22 + 2 * Math.sin(i / 5)) * 10) / 10, state: 0,
        })) };
      }
      return { moreDataAvailable: false, moreDataRef: null, rows: [{
        id: "demo-alarm", sourceId: "demo-room-temperature", source: "Demo temperatura",
        message: "Demo: temperatura iznad granice", timestamp: new Date().toISOString(),
        occurredAt: new Date().toISOString(), priority: 100, state: 1, type: "Demo",
      }] };
    }
    return normalizeResponse(kind, await this.request(`/api/${kind === "history" ? "history" : "alarms"}/query`, options));
  }
}

module.exports = { TelemetryClient, normalizeResponse, queryOptions };
