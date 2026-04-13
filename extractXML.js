const AdmZip = require("adm-zip");
const fs = require("fs");
const path = require("path");
const { XMLParser } = require("fast-xml-parser");

const INPUT_FILE = path.join(__dirname, "Bruno 1.knxproj");
const OUTPUT_DIR = path.join(__dirname, "xml_extracted");
const OUTPUT_JSON = path.join(__dirname, "device_settings.json");

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function walk(node, visitor) {
  if (!node || typeof node !== "object") return;
  visitor(node);
  for (const key of Object.keys(node)) {
    const child = node[key];
    if (Array.isArray(child)) child.forEach(c => walk(c, visitor));
    else walk(child, visitor);
  }
}

function extractXmlFiles(zip, outputDir) {
  let extractedCount = 0;
  zip.getEntries().forEach(entry => {
    if (entry.isDirectory) return;
    if (path.extname(entry.entryName).toLowerCase() !== ".xml") return;

    const targetPath = path.join(outputDir, entry.entryName);
    ensureDirectory(path.dirname(targetPath));
    fs.writeFileSync(targetPath, entry.getData());
    extractedCount += 1;
  });
  return extractedCount;
}

function findFileRecursive(dir, fileName) {
  const items = fs.readdirSync(dir, { withFileTypes: true });
  for (const item of items) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) {
      const found = findFileRecursive(full, fileName);
      if (found) return found;
    } else if (item.name === fileName) {
      return full;
    }
  }
  return null;
}

function readXml(filePath, parser) {
  const xml = fs.readFileSync(filePath, "utf8");
  return parser.parse(xml);
}

function buildHardware2ProgramMap(hardwareXmlObj) {
  const map = new Map();
  const hardwares =
    asArray(
      hardwareXmlObj?.KNX?.ManufacturerData?.Manufacturer?.Hardware?.Hardware
    );

  for (const hw of hardwares) {
    const h2ps = asArray(hw?.Hardware2Programs?.Hardware2Program);
    for (const h2p of h2ps) {
      const h2pId = h2p?.["@_Id"];
      const appRef = h2p?.ApplicationProgramRef?.["@_RefId"];
      if (h2pId && appRef) map.set(h2pId, appRef);
    }
  }
  return map;
}

function buildAppIndexes(appXmlObj) {
  const parameterById = new Map();
  const parameterRefById = new Map();

  walk(appXmlObj, node => {
    if (node["@_Id"] && node["@_Name"] && node["@_ParameterType"] && node["@_Value"] !== undefined) {
      parameterById.set(node["@_Id"], {
        id: node["@_Id"],
        name: node["@_Name"] || null,
        text: node["@_Text"] || null,
        defaultValue: node["@_Value"] ?? null,
        parameterType: node["@_ParameterType"] || null
      });
    }

    if (node["@_Id"] && node["@_RefId"] && node["@_Name"] && String(node["@_Id"]).includes("_R-")) {
      parameterRefById.set(node["@_Id"], {
        id: node["@_Id"],
        refId: node["@_RefId"],
        name: node["@_Name"] || null
      });
    }
  });

  return { parameterById, parameterRefById };
}

function buildDeviceSettingsJson() {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    parseAttributeValue: false,
    processEntities: {
      enabled: true,
      maxTotalExpansions: 200000,
      maxExpandedLength: 20000000,
      maxEntityCount: 50000,
      maxEntitySize: 200000,
      maxExpansionDepth: 20
    }
  });

  const projectFile = findFileRecursive(OUTPUT_DIR, "0.xml");
  if (!projectFile) throw new Error("Could not find project file 0.xml");

  const projectObj = readXml(projectFile, parser);
  const deviceInstances =
    asArray(
      projectObj?.KNX?.Project?.Installations?.Installation?.Topology?.Area
    )
      .flatMap(area => asArray(area?.Line))
      .flatMap(line => asArray(line?.Segment))
      .flatMap(seg => asArray(seg?.DeviceInstance));

  const manufacturerFolders = fs.readdirSync(OUTPUT_DIR)
    .map(name => path.join(OUTPUT_DIR, name))
    .filter(p => fs.statSync(p).isDirectory() && path.basename(p).startsWith("M-"));

  const hardware2ProgramToApp = new Map();
  for (const mFolder of manufacturerFolders) {
    const hwFile = path.join(mFolder, "Hardware.xml");
    if (!fs.existsSync(hwFile)) continue;
    const hwObj = readXml(hwFile, parser);
    const localMap = buildHardware2ProgramMap(hwObj);
    for (const [k, v] of localMap.entries()) hardware2ProgramToApp.set(k, v);
  }

  const appIndexesCache = new Map();

  function getAppIndexes(appId) {
    if (appIndexesCache.has(appId)) return appIndexesCache.get(appId);
    const appFileName = `${appId}.xml`;
    const appFile = findFileRecursive(OUTPUT_DIR, appFileName);
    if (!appFile) {
      appIndexesCache.set(appId, null);
      return null;
    }
    const appObj = readXml(appFile, parser);
    const idx = buildAppIndexes(appObj);
    appIndexesCache.set(appId, idx);
    return idx;
  }

  const result = [];

  for (const di of deviceInstances) {
    const deviceId = di?.["@_Id"];
    const address = di?.["@_Address"] ?? null;
    const desc = di?.["@_Description"] ?? null;
    const h2pRefId = di?.["@_Hardware2ProgramRefId"] ?? null;

    const appId = h2pRefId ? hardware2ProgramToApp.get(h2pRefId) || null : null;
    const pRefs = asArray(di?.ParameterInstanceRefs?.ParameterInstanceRef);

    const device = {
      deviceInstanceId: deviceId || null,
      address,
      description: desc,
      hardware2ProgramRefId: h2pRefId,
      applicationProgramId: appId,
      settings: []
    };

    if (appId && pRefs.length > 0) {
      const indexes = getAppIndexes(appId);
      if (indexes) {
        for (const pInst of pRefs) {
          const instanceRefId = pInst?.["@_RefId"];
          const value = pInst?.["@_Value"] ?? null;

          const pRef = indexes.parameterRefById.get(instanceRefId);
          const param = pRef ? indexes.parameterById.get(pRef.refId) : null;

          device.settings.push({
            instanceRefId,
            value,
            parameterRefName: pRef?.name || null,
            parameterId: pRef?.refId || null,
            parameterName: param?.name || null,
            parameterText: param?.text || null,
            defaultValue: param?.defaultValue || null,
            parameterType: param?.parameterType || null
          });
        }
      }
    }

    result.push(device);
  }

  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(result, null, 2), "utf8");
  return result.length;
}

function main() {
  ensureDirectory(OUTPUT_DIR);

  const zip = new AdmZip(INPUT_FILE);
  const extractedCount = extractXmlFiles(zip, OUTPUT_DIR);
  console.log(`Extracted ${extractedCount} XML file(s) to ${OUTPUT_DIR}`);

  const deviceCount = buildDeviceSettingsJson();
  console.log(`Wrote settings JSON for ${deviceCount} device instance(s) to ${OUTPUT_JSON}`);
}

main();