const fsSync = require("node:fs");
const fs = require("node:fs/promises");

const { parseWidgets } = require("./config");

class WidgetStoreError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = "WidgetStoreError";
    this.status = status;
    this.code = code;
  }
}

class WidgetStore {
  #filePath;

  #enabled;

  #operation = Promise.resolve();

  constructor(filePath) {
    this.#filePath = String(filePath || "").trim();
    this.#enabled = false;
    if (this.#filePath) {
      try {
        fsSync.accessSync(this.#filePath, fsSync.constants.W_OK);
        this.#enabled = true;
      } catch {
        this.#enabled = false;
      }
    }
  }

  get enabled() {
    return this.#enabled;
  }

  async add(widget) {
    const operation = this.#operation.then(() => this.#add(widget));
    this.#operation = operation.catch(() => {});
    return operation;
  }

  async setVisibility(id, visible) {
    const operation = this.#operation.then(() =>
      this.#setVisibility(id, visible)
    );
    this.#operation = operation.catch(() => {});
    return operation;
  }

  async updateSettings(id, settings) {
    const operation = this.#operation.then(() =>
      this.#updateSettings(id, settings)
    );
    this.#operation = operation.catch(() => {});
    return operation;
  }

  #assertEnabled() {
    if (!this.enabled) {
      throw new WidgetStoreError(
        "Widget configuration is not backed by a writable WIDGETS_FILE.",
        409,
        "WIDGET_FILE_UNAVAILABLE"
      );
    }
  }

  async #readWidgets() {
    try {
      const rawWidgets = JSON.parse(
        (await fs.readFile(this.#filePath, "utf8")).replace(/^\uFEFF/, "")
      );
      if (!Array.isArray(rawWidgets)) {
        throw new WidgetStoreError(
          "Widget configuration must contain an array.",
          500,
          "INVALID_WIDGET_FILE"
        );
      }
      return rawWidgets;
    } catch (error) {
      if (error instanceof WidgetStoreError) throw error;
      throw new WidgetStoreError(
        `Unable to read widget configuration: ${error.message}`,
        500,
        "WIDGET_FILE_READ_FAILED"
      );
    }
  }

  async #writeWidgets(widgets) {
    try {
      const normalized = parseWidgets(JSON.stringify(widgets), false);
      await fs.writeFile(
        this.#filePath,
        `${JSON.stringify(widgets, null, 2)}\n`,
        "utf8"
      );
      return normalized;
    } catch (error) {
      throw new WidgetStoreError(
        `Unable to save widget configuration: ${error.message}`,
        500,
        "WIDGET_FILE_WRITE_FAILED"
      );
    }
  }

  async #add(widget) {
    this.#assertEnabled();
    const rawWidgets = await this.#readWidgets();

    const id = String(widget?.id || "").trim();
    if (rawWidgets.some((item) => String(item?.id || "").trim() === id)) {
      throw new WidgetStoreError(
        "This object is already on the dashboard.",
        409,
        "WIDGET_ALREADY_EXISTS"
      );
    }

    const storedWidget = {
      id,
      label: String(widget?.label || id),
      description: String(widget?.description || "PLC vrijednost"),
      unit: String(widget?.unit || ""),
    };
    const nextWidgets = [...rawWidgets, storedWidget];
    await this.#writeWidgets(nextWidgets);
    return storedWidget;
  }

  async #setVisibility(id, visible) {
    this.#assertEnabled();
    if (typeof visible !== "boolean") {
      throw new WidgetStoreError(
        "visible must be a boolean.",
        400,
        "INVALID_VISIBILITY"
      );
    }

    const widgetId = String(id || "").trim();
    const rawWidgets = await this.#readWidgets();
    const index = rawWidgets.findIndex(
      (widget) => String(widget?.id || "").trim() === widgetId
    );
    if (index < 0) {
      throw new WidgetStoreError(
        "This widget is not present in widgets.json.",
        404,
        "WIDGET_NOT_FOUND"
      );
    }

    rawWidgets[index] = { ...rawWidgets[index], visible };
    await this.#writeWidgets(rawWidgets);
    return { id: widgetId, visible };
  }

  async #updateSettings(id, settings) {
    this.#assertEnabled();
    const widgetId = String(id || "").trim();
    const rawWidgets = await this.#readWidgets();
    const index = rawWidgets.findIndex(
      (widget) => String(widget?.id || "").trim() === widgetId
    );
    if (index < 0) {
      throw new WidgetStoreError(
        "This widget is not present in widgets.json.",
        404,
        "WIDGET_NOT_FOUND"
      );
    }

    const updated = {
      ...rawWidgets[index],
      id: widgetId,
      label: settings.label,
      description: settings.description,
      unit: settings.unit,
      writable: settings.writable,
      visible: settings.visible,
    };
    if (settings.precision === null) {
      delete updated.precision;
    } else {
      updated.precision = settings.precision;
    }

    rawWidgets[index] = updated;
    const normalized = await this.#writeWidgets(rawWidgets);
    return normalized[index];
  }
}

module.exports = {
  WidgetStore,
  WidgetStoreError,
};
