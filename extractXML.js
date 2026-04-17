const AdmZip = require("adm-zip");
const fs = require("fs");
const path = require("path");
const { XMLParser } = require("fast-xml-parser");

const args = process.argv.slice(2);
const INPUT_FILE = args[0] || path.join(__dirname, "Bruno 1.knxproj");
const INPUT_BASE = path.parse(INPUT_FILE).name;
const OUTPUT_PARENT_DIR = args[1] || path.join(__dirname, "output");
const OUTPUT_DIR = path.join(OUTPUT_PARENT_DIR, `${INPUT_BASE}_extracted`);
const OUTPUT_JSON = path.join(OUTPUT_PARENT_DIR, `${INPUT_BASE}_settings.json`);

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}


// pomocna funkicija koja pretvori u array ako vec nije (treba zbog xml parsera)
function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}


// pomoćna funkcija za obilazak XML čvorova
function walk(node, visitor) {
  if (!node || typeof node !== "object") return;
  visitor(node);
  for (const key of Object.keys(node)) {
    const child = node[key];
    if (Array.isArray(child)) child.forEach(c => walk(c, visitor));
    else walk(child, visitor);
  }
}


// prebaci sve XML datoteke iz zipa u output direktorij
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


// trazi odredani file unutar direktorija
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


// pročitaj XML datoteku i parsiraj je u JS objekt
function readXml(filePath, parser) {
  const xml = fs.readFileSync(filePath, "utf8");
  return parser.parse(xml);
}


// kreaira mapu za povezivanje Hardware2Program ID-eva s ApplicationProgram ID-eva
// (u project xml su samo reference na hardware2program, a app programi su zasebni xml-ovi, 
// tako da treba napraviti mapu da se zna koji app program pripada kojem hardware2programu)
// 0.xml -> device instance -> hardware2program ref id -> app program id -> parametri
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


// iz Hardware.xml napravi mapu ProductRefId -> metadata uređaja (tip, serija...)
function buildProductMetadataMap(hardwareXmlObj) {
  const map = new Map();
  const hardwares =
    asArray(
      hardwareXmlObj?.KNX?.ManufacturerData?.Manufacturer?.Hardware?.Hardware
    );

  for (const hw of hardwares) {
    const products = asArray(hw?.Products?.Product);
    for (const product of products) {
      const productRefId = product?.["@_Id"];
      if (!productRefId) continue;

      map.set(productRefId, {
        productRefId,
        deviceType: product?.["@_Text"] || hw?.["@_Name"] || null,
        orderNumber: product?.["@_OrderNumber"] || null,
        hardwareName: hw?.["@_Name"] || null,
        hardwareSerialNumber: hw?.["@_SerialNumber"] || null
      });
    }
  }

  return map;
}


// funkcija za kreiranje ključa u JSON outputu: 
// pokušava naći smislen naziv parametra koristeći dostupne informacije, 
// a ako ništa nije dostupno, koristi instanceRefId ili "UnknownSetting"
function buildSettingKey(instanceRefId, pRef, param) {
  return (
    param?.name ||
    param?.text ||
    pRef?.name ||
    instanceRefId ||
    "UnknownSetting"
  );
}


// za svaki app program xml, kreira dva indeksa: jedan za parametre (parameterById) 
// i jedan za reference na parametre (parameterRefById)
function buildAppIndexes(appXmlObj) {
  const parameterById = new Map();
  const parameterRefById = new Map();

  walk(appXmlObj, node => {
    // Find Parameter nodes: must have Id, Name, ParameterType, and Value
    if (node["@_Id"] && node["@_Name"] && node["@_ParameterType"] && node["@_Value"] !== undefined) {
      parameterById.set(node["@_Id"], {
        id: node["@_Id"],
        name: node["@_Name"] || null,
        text: node["@_Text"] || null,
        defaultValue: node["@_Value"] ?? null,
        parameterType: node["@_ParameterType"] || null
      });
    }

    // Find ParameterRef nodes: must have Id with _R- and RefId. Name is optional.
    // ParameterRef is used to reference the actual Parameter definition via RefId
    if (node["@_Id"] && node["@_RefId"] && String(node["@_Id"]).includes("_R-")) {
      parameterRefById.set(node["@_Id"], {
        id: node["@_Id"],
        refId: node["@_RefId"],
        name: node["@_Name"] || null
      });
    }
  });

  return { parameterById, parameterRefById };
}


// glavna funkcija koja povezuje sve dijelove: prvo parsira project file da dobije device instance-ove,
// zatim kreira mapu hardware2program -> app program, i onda za svaki device instance koji ima app program, 
// parsira taj app program da dobije parametre i spoji ih s vrijednostima iz device instance-a
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
  const productMetadataByRefId = new Map();
  for (const mFolder of manufacturerFolders) {
    const hwFile = path.join(mFolder, "Hardware.xml");
    if (!fs.existsSync(hwFile)) continue;
    const hwObj = readXml(hwFile, parser);

    const localMap = buildHardware2ProgramMap(hwObj);
    for (const [k, v] of localMap.entries()) hardware2ProgramToApp.set(k, v);

    const localProductMap = buildProductMetadataMap(hwObj);
    for (const [k, v] of localProductMap.entries()) productMetadataByRefId.set(k, v);
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
    const productRefId = di?.["@_ProductRefId"] ?? null;
    const serialNumber = di?.["@_SerialNumber"] ?? null;

    const appId = h2pRefId ? hardware2ProgramToApp.get(h2pRefId) || null : null;
    const pRefs = asArray(di?.ParameterInstanceRefs?.ParameterInstanceRef);
    const productMeta = productRefId ? productMetadataByRefId.get(productRefId) || null : null;

    const device = {
      settings: {
        deviceId: deviceId || null,
        deviceType: productMeta?.deviceType || null,
        serialNumber,
        individualAddress: address,
        description: desc,
        productRefId,
        orderNumber: productMeta?.orderNumber || null,
        hardwareName: productMeta?.hardwareName || null,
        hardwareCatalogSerial: productMeta?.hardwareSerialNumber || null,
        hardware2ProgramRefId: h2pRefId,
        applicationProgramId: appId
      },
      parameters: {},
      changedParameters: []
    };

    if (appId && pRefs.length > 0) {
      const indexes = getAppIndexes(appId);
      if (indexes) {
        for (const pInst of pRefs) {
          const instanceRefId = pInst?.["@_RefId"];
          const value = pInst?.["@_Value"] ?? null;

          const pRef = indexes.parameterRefById.get(instanceRefId);
          const param = pRef ? indexes.parameterById.get(pRef.refId) : null;

          const baseKey = buildSettingKey(instanceRefId, pRef, param);
          const key = Object.prototype.hasOwnProperty.call(device.parameters, baseKey)
            ? `${baseKey} (${instanceRefId})`
            : baseKey; // ako već postoji ključ s istim imenom, dodaj instanceRefId u zagradu da se razlikuju

          device.parameters[key] = value;

          device.changedParameters.push({
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