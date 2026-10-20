const MAX_IDS = 2_000;
const BATCH_SIZE = 32;
const MAX_ENUMS = 16;
const MAX_ZONES = 32;
const CACHE_TTL_MS = 60_000;
const asArray = (value) => value == null || value === "" ? [] : Array.isArray(value) ? value : [value];
const scalar = (value) => ["string", "number", "boolean"].includes(typeof value) ? String(value) : "";
const flag = (value) => value === true || value === 1 || value === "1" || value === "true";

function zonePath(id) {
  if (!/^(?:01|11)\//.test(id)) return "";
  const parts = id.slice(3).split("/");
  const index = parts.indexOf("Zones");
  if (index < 0 || !parts[index + 1]) return "";
  return parts.slice(0, index + 2).join("/");
}

function roomDescription(container) {
  const description = scalar(container?.description).trim();
  if (!description || /^(?:placeholder\b|undefined$|null$|n\/?a$|[-–—]$|folder$|zone$|zones$|value$|plc vrijednost$)/i.test(description)) return "";
  if (description === scalar(container?.name).trim() && /^Z\d+$/i.test(description)) return "";
  return description;
}

async function inGroups(values, concurrency, callback) {
  for (let index = 0; index < values.length; index += concurrency) {
    await Promise.all(values.slice(index, index + concurrency).map(callback));
  }
}

class DeviceMetadataClient {
  #middlewareUrl;
  #authorization;
  #timeoutMs;
  #fetch;
  #demoMode;
  #cache = new Map();
  #inFlight = new Map();

  constructor(config, { fetchImpl = globalThis.fetch } = {}) {
    this.#demoMode = config.demoMode === true;
    if (!this.#demoMode && typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
    this.#fetch = fetchImpl;
    this.#middlewareUrl = String(config.middlewareUrl || "").replace(/\/+$/, "");
    this.#authorization = `Basic ${Buffer.from(`${config.username || ""}:${config.password || ""}`, "utf8").toString("base64")}`;
    this.#timeoutMs = Number.isFinite(config.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : 10_000;
  }

  async read(widgets) {
    if (this.#demoMode) return { metadataById: {}, roomByZone: {}, warnings: [] };
    const configured = [...new Set(asArray(widgets).map((widget) => typeof widget === "string" ? widget.trim() : scalar(widget?.id).trim()).filter(Boolean))].sort();
    const ids = configured.slice(0, MAX_IDS);
    const truncated = configured.length > MAX_IDS;
    const key = JSON.stringify([ids, truncated]);
    const cached = this.#cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return structuredClone(cached.result);
    if (this.#inFlight.has(key)) return structuredClone(await this.#inFlight.get(key));
    const operation = this.#read(ids, cached?.result, truncated);
    this.#inFlight.set(key, operation);
    try {
      const result = await operation;
      this.#cache.delete(key);
      this.#cache.set(key, { result, expiresAt: Date.now() + CACHE_TTL_MS });
      while (this.#cache.size > 4) this.#cache.delete(this.#cache.keys().next().value);
      return structuredClone(result);
    } finally {
      this.#inFlight.delete(key);
    }
  }

  // Command checks must not use the display cache or fall back to old permissions.
  // GetItems supplies capability and current state in the same controller response.
  async readFreshPoint(id) {
    if (this.#demoMode) throw new Error("Fresh device reads are unavailable in demo mode");
    const payload = await this.#request("/api/items/read", { ids: [id], metadata: true });
    if (asArray(payload.GetItemsErrorResults?.ErrorResult).length) throw new Error("Point read failed");
    const items = asArray(payload.GetItemsItems?.ValueItems?.ValueItem).filter((item) => scalar(item?.Id) === id);
    if (items.length !== 1) throw new Error("Point identity missing or ambiguous");
    const item = items[0];
    const metadata = {
      id, name: scalar(item.Name), description: scalar(item.Description), type: scalar(item.Type),
      unit: scalar(item.Unit), writeable: flag(item.Writeable), forceable: flag(item.Forceable),
      enumId: scalar(item.EnumId), enumValues: [],
    };
    if (metadata.enumId) {
      const enumsPayload = await this.#request("/api/enums/read", { ids: [metadata.enumId] });
      if (asArray(enumsPayload.GetEnumsErrorResults?.ErrorResult).length) throw new Error("Enum read failed");
      const enums = asArray(enumsPayload.GetEnumsEnums?.Enum);
      const entry = enums.find((value) => scalar(value.Id) === metadata.enumId)
        || (enums.length === 1 && !scalar(enums[0].Id) ? enums[0] : null);
      if (!entry) throw new Error("Enum identity missing");
      metadata.enumValues = asArray(entry.EnumValues?.EnumValue)
        .filter((value) => Object.hasOwn(value || {}, "Value") && ["string", "number", "boolean"].includes(typeof value.Value) && scalar(value.Text))
        .map((value) => ({ value: value.Value, label: scalar(value.Text) }));
      if (!metadata.enumValues.length) throw new Error("Enum values missing");
    }
    return {
      widget: { id, value: item.Value, state: item.State, error: null },
      metadata,
    };
  }

  async #request(endpoint, body) {
    const response = await this.#fetch(`${this.#middlewareUrl}${endpoint}`, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      headers: {
        Accept: "application/json",
        Authorization: this.#authorization,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!response?.ok) throw new Error("Metadata request failed");
    const payload = await response.json();
    if (!payload || typeof payload !== "object" || payload.soapFault || payload.error) throw new Error("Invalid metadata response");
    return payload;
  }

  async #read(ids, previous, truncated) {
    const metadataById = Object.create(null);
    const roomByZone = Object.create(null);
    const warnings = new Set();
    if (truncated) warnings.add("Opisi uređaja ograničeni su na prvih 2000 konfiguriranih vrijednosti.");
    const configured = new Set(ids);
    for (const id of ids) {
      if (previous?.metadataById?.[id]) metadataById[id] = structuredClone(previous.metadataById[id]);
    }
    const batches = [];
    for (let index = 0; index < ids.length; index += BATCH_SIZE) batches.push(ids.slice(index, index + BATCH_SIZE));
    await inGroups(batches, 4, async (batch) => {
      try {
        const payload = await this.#request("/api/items/read", { ids: batch, metadata: true });
        const errors = asArray(payload.GetItemsErrorResults?.ErrorResult);
        if (errors.length) warnings.add("Kontroler nije vratio sve tražene opise vrijednosti.");
        const returned = new Set();
        for (const item of asArray(payload.GetItemsItems?.ValueItems?.ValueItem)) {
          const id = scalar(item?.Id);
          if (!configured.has(id) || !batch.includes(id)) continue;
          returned.add(id);
          const enumId = scalar(item.EnumId);
          metadataById[id] = {
            id, name: scalar(item.Name), description: scalar(item.Description), type: scalar(item.Type),
            unit: scalar(item.Unit), writeable: flag(item.Writeable), forceable: flag(item.Forceable), enumId,
            enumValues: previous?.metadataById?.[id]?.enumId === enumId
              ? structuredClone(previous.metadataById[id].enumValues || []) : [],
          };
        }
        if (returned.size !== batch.length) warnings.add("Za dio vrijednosti nedostaje opis; kartice mogu imati manje dostupnih funkcija.");
      } catch {
        warnings.add("Dohvat opisa vrijednosti nije uspio; prethodno dohvaćeni opisi su sačuvani.");
      }
    });

    const enumIds = [...new Set(Object.values(metadataById).map((item) => item.enumId).filter(Boolean))].sort();
    if (enumIds.length > MAX_ENUMS) warnings.add("Broj dohvaćenih popisa opcija ograničen je na 16.");
    await inGroups(enumIds.slice(0, MAX_ENUMS), 4, async (enumId) => {
      try {
        // EBO can omit the response Enum.Id; a single requested ID keeps the association unambiguous.
        const payload = await this.#request("/api/enums/read", { ids: [enumId] });
        if (asArray(payload.GetEnumsErrorResults?.ErrorResult).length) throw new Error("Enum read failed");
        const enums = asArray(payload.GetEnumsEnums?.Enum);
        const item = enums.find((entry) => scalar(entry.Id) === enumId) || (enums.length === 1 && !scalar(enums[0].Id) ? enums[0] : null);
        if (!item) throw new Error("Enum identity missing");
        const enumValues = asArray(item.EnumValues?.EnumValue)
          .filter((entry) => Object.hasOwn(entry || {}, "Value") && ["string", "number", "boolean"].includes(typeof entry.Value) && scalar(entry.Text))
          .map((entry) => ({ value: entry.Value, label: scalar(entry.Text) }));
        if (!enumValues.length) throw new Error("Enum values missing");
        for (const descriptor of Object.values(metadataById)) {
          if (descriptor.enumId === enumId) descriptor.enumValues = structuredClone(enumValues);
        }
      } catch {
        warnings.add("Dio popisa opcija nije dostupan; nepoznate opcije neće se nuditi za upravljanje.");
      }
    });

    const zones = [...new Set(ids.map(zonePath).filter(Boolean))].sort();
    if (zones.length > MAX_ZONES) warnings.add("Dohvat naziva prostorija ograničen je na prvih 32 zone.");
    await inGroups(zones.slice(0, MAX_ZONES), 4, async (zone) => {
      if (previous?.roomByZone?.[zone]) roomByZone[zone] = previous.roomByZone[zone];
      try {
        const containerId = `00/${zone}`;
        const payload = await this.#request(`/api/containers?id=${encodeURIComponent(containerId)}&metadata=true&allPages=false`);
        const container = asArray(payload.containers).find((item) => scalar(item?.id) === containerId);
        if (asArray(payload.errors).length) warnings.add("Dohvat opisa nekih prostorija bio je nepotpun.");
        if (!container) throw new Error("Zone missing");
        const label = roomDescription(container);
        if (label) roomByZone[zone] = label;
        else {
          delete roomByZone[zone];
          warnings.add("Neke zone nemaju opis prostorije; njihove uređaje treba ručno smjestiti.");
        }
      } catch {
        warnings.add("Dohvat opisa prostorija nije uspio; prethodno poznate prostorije su sačuvane.");
      }
    });
    return { metadataById, roomByZone, warnings: [...warnings] };
  }
}

module.exports = { DeviceMetadataClient };
