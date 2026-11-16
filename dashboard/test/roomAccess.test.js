const test = require("node:test");
const assert = require("node:assert/strict");
const { createRoomIndex, scopeRooms } = require("../lib/auth/roomAccess");

test("room-scoped settings reveal only light group members the viewer may see", () => {
  const widgets = ["GRP/Values/GrpPct", "L1/Values/LtPct", "L2/Values/LtPct"].map((suffix) => ({ id: `01/ES/Hall/${suffix}` }));
  const deviceSettings = [
    { key: "ES/Hall/GRP", room: "hall", lightMembers: ["ES/Hall/L1", "ES/Hall/L2", "ES/Gone/L9"] },
    { key: "ES/Hall/L1", room: "hall" },
    { key: "ES/Hall/L2", room: "office" },
  ];
  const index = createRoomIndex(widgets, { deviceSettings, floors: [], roomDetails: [] }, ["hall", "office"]);
  const hall = scopeRooms(index, ["hall"]).settings.devices;
  assert.deepEqual(hall.find((device) => device.key === "ES/Hall/GRP").lightMembers, ["ES/Hall/L1"]);
  assert.equal(JSON.stringify(hall).includes("L2"), false);
  assert.equal(JSON.stringify(hall).includes("L9"), false);
  assert.equal(Object.hasOwn(hall.find((device) => device.key === "ES/Hall/L1"), "lightMembers"), false);
  // The light stays visible on its own when its group is outside the viewer's rooms.
  assert.deepEqual(scopeRooms(index, ["office"]).settings.devices.map((device) => device.key), ["ES/Hall/L2"]);
});
