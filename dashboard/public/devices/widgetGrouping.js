(function () {
  "use strict";

  // These are EBO organization folders, not device names or room identifiers.
  const technicalFolders = new Set(["Values", "Points", "External Bindings", "Logs", "Alarms", "Graphics"]);

  function parentGroup(id) {
    const slash = id.lastIndexOf("/");
    return (slash > 0 ? id.slice(0, slash).trim() : "") || "PLC vrijednosti";
  }

  function deriveWidgetGrouping(id) {
    const pointId = String(id || "").trim();
    const fallback = { key: parentGroup(pointId), label: parentGroup(pointId), context: "", kind: "folder" };
    if (!/^(01|11)\//.test(pointId)) return fallback;

    const parts = pointId.split("/").slice(1);
    if (parts.some((part) => !part)) return fallback;
    const branch = parts.findIndex((part, index) => index > 1 && technicalFolders.has(part));
    let owner = branch > 1 ? parts.slice(0, branch) : null;

    // Device properties such as AC309/Status sit directly under the Modbus
    // device, without a Points or Values folder.
    const io = parts.indexOf("IO Resources");
    if (!owner && io > 0 && parts.length > io + 3) owner = parts.slice(0, io + 3);
    if (!owner) return fallback;

    const zone = owner.lastIndexOf("Zones");
    const items = owner.lastIndexOf("Items");
    const room = zone > 0 ? owner[zone + 1] : null;
    const kind = room && owner.length === zone + 2 ? "zone"
      : (room && owner.length === zone + 3) ||
        (items > 0 && owner.length === items + 2) ||
        (io > 0 && owner.length === io + 3) ? "device" : "folder";
    const network = owner.indexOf("IP Network");
    const controller = network > 0 ? owner[network + 1] : null;
    const context = [owner[0], controller, room].filter(Boolean).join(" · ");

    return {
      // Prefix 01/11 distinguishes points/properties, not their owning device.
      // Preserve the complete path so equal names on two controllers stay apart.
      key: owner.join("/"),
      label: kind === "zone" ? `Zona ${room}` : owner[owner.length - 1],
      context,
      kind,
    };
  }

  function deriveWidgetGroup(id) {
    return deriveWidgetGrouping(id).key;
  }

  function widgetGroup(widget) {
    const custom = typeof widget?.group === "string" ? widget.group.trim() : "";
    return custom || deriveWidgetGroup(widget?.id);
  }

  function describeWidgetGroup(widget) {
    const automatic = deriveWidgetGrouping(widget?.id);
    const key = widgetGroup(widget);
    return key === automatic.key ? automatic : { key, label: key, context: "", kind: "custom" };
  }

  const api = { deriveWidgetGrouping, deriveWidgetGroup, widgetGroup, describeWidgetGroup };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else globalThis.IoTWidgetGrouping = api;
})();
