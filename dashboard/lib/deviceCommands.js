const model = require("../public/deviceModel");
const { deriveWidgetGrouping } = require("../public/widgetGrouping");

class DeviceCommandError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = "DeviceCommandError";
    this.status = status;
    this.code = code;
  }
}

const transmissionErrors = {
  POINT_NOT_WRITABLE: [403, "Pisanje ove vrijednosti nije omogućeno u dashboardu."],
  POINT_UNAVAILABLE: [409, "Vrijednost trenutačno nije dostupna za upravljanje."],
  WRITE_IN_PROGRESS: [409, "Slanje naredbe za ovu vrijednost već je u tijeku."],
  WRITE_TIMEOUT: [504, "Slanje je isteklo. Provjeri stvarno stanje prije ponovnog pokušaja."],
  CONTROLLER_REJECTED: [422, "Kontroler je odbio naredbu."],
};

class DeviceCommandService {
  #poller;
  #config;
  #metadata;
  #inFlight = new Set();

  constructor({ poller, config, deviceMetadata }) {
    this.#poller = poller;
    this.#config = config;
    this.#metadata = deviceMetadata;
  }

  isDeviceCommand(id) {
    const widget = this.#config.widgets.find((entry) => entry.id === String(id || "").trim());
    return model.classifyPoint(widget || { id }).command;
  }

  #configured(id) {
    const matches = this.#config.widgets.filter((entry) => entry.id === id);
    const widget = matches.length === 1 ? matches[0] : null;
    if (!widget || widget.visible === false || widget.writable !== true) {
      throw new DeviceCommandError("Pisanje ove vidljive vrijednosti nije omogućeno u dashboardu.", 403, "DEVICE_POINT_NOT_ENABLED");
    }
    if (!id.startsWith("01/") || !model.classifyPoint(widget).command) {
      throw new DeviceCommandError("Ova točka nije potvrđena izvorna naredba uređaja.", 403, "DEVICE_COMMAND_UNKNOWN");
    }
    const owner = deriveWidgetGrouping(id).key;
    const role = model.classifyPoint(widget).role;
    const competing = this.#config.widgets.filter((entry) => entry.visible !== false && entry.id.startsWith("01/")
      && deriveWidgetGrouping(entry.id).key === owner && model.classifyPoint(entry).role === role);
    if (competing.length !== 1) {
      throw new DeviceCommandError("Više točaka ima istu naredbenu ulogu na uređaju; potrebno je potvrditi vezu.", 409, "DEVICE_COMMAND_AMBIGUOUS");
    }
    return widget;
  }

  async write(id, value) {
    if (this.#config.demoMode) throw new DeviceCommandError("Stvarno upravljanje nije dostupno u demo prikazu.", 409, "DEMO_MODE");
    const pointId = typeof id === "string" ? id.trim() : "";
    this.#configured(pointId);
    if (this.#poller.getSnapshot().status !== "connected") {
      throw new DeviceCommandError("Kontroler trenutačno nije povezan.", 409, "POINT_UNAVAILABLE");
    }
    if (this.#inFlight.has(pointId)) throw new DeviceCommandError("Slanje naredbe za ovu vrijednost već je u tijeku.", 409, "WRITE_IN_PROGRESS");
    this.#inFlight.add(pointId);
    try {
      let fresh;
      try {
        fresh = await this.#metadata.readFreshPoint(pointId);
      } catch {
        throw new DeviceCommandError("Svježa provjera dopuštenja i stanja nije uspjela; naredba nije poslana.", 502, "DEVICE_COMMAND_CHECK_FAILED");
      }
      // Configuration may have changed while the controller was being read.
      const configured = this.#configured(pointId);
      if (this.#poller.getSnapshot().status !== "connected") {
        throw new DeviceCommandError("Kontroler trenutačno nije povezan.", 409, "POINT_UNAVAILABLE");
      }
      const point = model.normalizePoint({ ...configured, ...fresh.widget, id: pointId,
        writable: configured.writable, visible: configured.visible }, fresh.metadata);
      const validation = model.validateDeviceCommand(point, value);
      if (!validation.allowed) {
        throw new DeviceCommandError(validation.reason || "Naredba nije dopuštena.", 422, validation.code || "DEVICE_COMMAND_INVALID");
      }
      try {
        const result = await this.#poller.writeValue(pointId, validation.value);
        if (result?.success !== true) throw new Error("Missing write acknowledgement");
        return { id: pointId, success: true, message: "Naredba je prihvaćena; provjerava se stvarno stanje uređaja." };
      } catch (error) {
        const mapped = transmissionErrors[error?.code];
        throw new DeviceCommandError(mapped?.[1] || "Slanje naredbe nije uspjelo. Provjeri stvarno stanje uređaja.", mapped?.[0] || 502, mapped ? error.code : "DEVICE_COMMAND_WRITE_FAILED");
      }
    } finally {
      this.#inFlight.delete(pointId);
    }
  }
}

module.exports = { DeviceCommandService, DeviceCommandError };
