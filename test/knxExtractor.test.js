const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {
  resolveZipEntryTarget,
} = require("../tools/knx-extractor/extractProject");

test("keeps extracted files inside the selected output directory", () => {
  const outputDir = path.resolve("output", "example_extracted");

  assert.equal(
    resolveZipEntryTarget(outputDir, "M-0001/Hardware.xml"),
    path.join(outputDir, "M-0001", "Hardware.xml")
  );

  assert.throws(
    () => resolveZipEntryTarget(outputDir, "../outside.xml"),
    /Unsafe path in KNX archive/
  );
});
