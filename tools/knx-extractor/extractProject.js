const AdmZip = require("adm-zip");
const fs = require("fs");
const path = require("path");
const { XMLParser } = require("fast-xml-parser");

const args = process.argv.slice(2);
const INPUT_FILE = args[0] ? path.resolve(args[0]) : null;
const INPUT_BASE = INPUT_FILE ? path.parse(INPUT_FILE).name : null;
const OUTPUT_PARENT_DIR = path.resolve(args[1] || "output");
const OUTPUT_DIR = INPUT_BASE
  ? path.join(OUTPUT_PARENT_DIR, `${INPUT_BASE}_extracted`)
  : null;
const OUTPUT_JSON = INPUT_BASE
  ? path.join(OUTPUT_PARENT_DIR, `${INPUT_BASE}_settings.json`)
  : null;

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function resolveZipEntryTarget(outputDir, entryName) {
  const outputRoot = path.resolve(outputDir);
  const targetPath = path.resolve(outputRoot, entryName);
  const relativeTarget = path.relative(outputRoot, targetPath);

  if (
    relativeTarget === ".." ||
    relativeTarget.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeTarget)
  ) {
    throw new Error(`Unsafe path in KNX archive: ${entryName}`);
  }

  return targetPath;
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

    const targetPath = resolveZipEntryTarget(outputDir, entry.entryName);
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


function extractObjectSuffix(id) {
  if (!id) return null;
  const value = String(id);
  const marker = "_O-";
  const markerIndex = value.indexOf(marker);
  if (markerIndex === -1) return value;
  return value.slice(markerIndex + 1);
}


function splitLinkIds(linksRaw) {
  if (!linksRaw) return [];
  return String(linksRaw)
    .split(/\s+/)
    .map(s => s.trim())
    .filter(Boolean);
}


function extractComObjectBaseId(id) {
  if (!id) return null;
  const value = String(id);
  const match = value.match(/(?:^|_)(O-[^_]+)(?:_R-\d+)?$/);
  return match ? match[1] : value;
}


function getChannelFamilyFromFunctionCode(functionCode) {
  switch (String(functionCode)) {
    case "1":
      return "switch";
    case "6":
      return "shutter";
    case "7":
      return "blind";
    default:
      return null;
  }
}


function getChannelFamilyFromComObjectName(name) {
  if (!name) return null;
  const raw = String(name).toUpperCase();
  if (raw.includes("_SW") || raw.includes("_SWITCH")) return "switch";
  if (raw.includes("_SH") || raw.includes("SHUTTER")) return "shutter";
  if (raw.includes("_BL") || raw.includes("BLIND")) return "blind";
  return null;
}


function parseChannelTextParameterName(parameterName) {
  if (!parameterName) return null;
  const match = String(parameterName).match(/^DYNAMIC_TEXT_PAR_(SWITCH|SHUTTER|BLIND)(\d+)$/);
  if (!match) return null;

  return {
    family: match[1].toLowerCase(),
    index: Number.parseInt(match[2], 10)
  };
}


function formatGroupAddress3Level(groupAddress) {
  if (groupAddress === null || groupAddress === undefined || groupAddress === "") return "";

  const raw = String(groupAddress).trim();
  if (!raw) return "";
  if (raw.includes("/")) return raw;

  const numericAddress = Number.parseInt(raw, 10);
  if (!Number.isFinite(numericAddress) || numericAddress < 0 || numericAddress > 65535) {
    return raw;
  }

  const main = (numericAddress >> 11) & 0x1f;
  const middle = (numericAddress >> 8) & 0x07;
  const sub = numericAddress & 0xff;

  return `${main}/${middle}/${sub}`;
}


function buildGroupAddressMap(projectObj) {
  const map = new Map();

  walk(projectObj, node => {
    const id = node?.["@_Id"];
    const address = node?.["@_Address"];
    if (!id || address === undefined) return;

    const idText = String(id);
    const idx = idText.indexOf("_GA-");
    if (idx === -1) return;

    const gaToken = `GA-${idText.slice(idx + 4)}`;
    map.set(gaToken, {
      id: idText,
      address: String(address),
      address3Level: formatGroupAddress3Level(address),
      name: node?.["@_Name"] || null,
      datapointType: node?.["@_DatapointType"] || null,
      description: node?.["@_Description"] || null
    });
  });

  return map;
}


// za svaki app program xml, kreira dva indeksa: jedan za parametre (parameterById) 
// i jedan za reference na parametre (parameterRefById)
// te dva indeksa za com objekti i njihove reference (comObjectById, comObjectBySuffix, comObjectRefById, comObjectRefBySuffix)
function buildAppIndexes(appXmlObj) {
  const parameterById = new Map();
  const parameterRefById = new Map();
  const comObjectById = new Map();
  const comObjectBySuffix = new Map();
  const comObjectRefById = new Map();
  const comObjectRefBySuffix = new Map();

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

    // Find ComObject nodes by _O- id and store metadata used for GA linking enrichment.
    if (node["@_Id"] && String(node["@_Id"]).includes("_O-")) {
      const entry = {
        id: node["@_Id"],
        name: node["@_Name"] || null,
        text: node["@_Text"] || null,
        functionText: node["@_FunctionText"] || null,
        datapointType: node["@_DatapointType"] || null,
        objectSize: node["@_ObjectSize"] || null
      };
      comObjectById.set(entry.id, entry);

      const suffix = extractObjectSuffix(entry.id);
      if (suffix) comObjectBySuffix.set(suffix, entry);
    }

    // Find ComObjectRef nodes (id and ref both point to object ids).
    if (
      node["@_Id"] &&
      node["@_RefId"] &&
      String(node["@_Id"]).includes("_O-") &&
      String(node["@_RefId"]).includes("_O-")
    ) {
      const entry = {
        id: node["@_Id"],
        refId: node["@_RefId"],
        name: node["@_Name"] || null,
        text: node["@_Text"] || null,
        functionText: node["@_FunctionText"] || null,
        datapointType: node["@_DatapointType"] || null,
        objectSize: node["@_ObjectSize"] || null
      };

      comObjectRefById.set(entry.id, entry);

      const suffix = extractObjectSuffix(entry.id);
      if (suffix) comObjectRefBySuffix.set(suffix, entry);
    }
  });

  return {
    appXmlObj,
    parameterById,
    parameterRefById,
    comObjectById,
    comObjectBySuffix,
    comObjectRefById,
    comObjectRefBySuffix
  };
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
  const groupAddressByToken = buildGroupAddressMap(projectObj);

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
    const indexes = appId ? getAppIndexes(appId) : null;
    const pRefs = asArray(di?.ParameterInstanceRefs?.ParameterInstanceRef);
    const comObjectRefs = asArray(di?.ComObjectInstanceRefs?.ComObjectInstanceRef);
    const productMeta = productRefId ? productMetadataByRefId.get(productRefId) || null : null;
    const channelFamilyByIndex = new Map();
    const linkedComObjectFamilies = new Set();

    if (indexes && comObjectRefs.length > 0) {
      for (const cInst of comObjectRefs) {
        const instanceRefId = cInst?.["@_RefId"] || null;
        if (!instanceRefId) continue;

        const comRef =
          indexes.comObjectRefBySuffix.get(instanceRefId) ||
          indexes.comObjectRefById.get(instanceRefId) ||
          null;

        let comObject = null;
        if (comRef?.refId) {
          comObject =
            indexes.comObjectById.get(comRef.refId) ||
            indexes.comObjectBySuffix.get(extractObjectSuffix(comRef.refId)) ||
            null;
        }

        if (!comObject) {
          comObject =
            indexes.comObjectBySuffix.get(instanceRefId) ||
            indexes.comObjectById.get(instanceRefId) ||
            null;
        }

        const family =
          getChannelFamilyFromComObjectName(comRef?.name) ||
          getChannelFamilyFromComObjectName(comObject?.name);
        if (family) linkedComObjectFamilies.add(family);
      }
    }

    if (indexes) {
      // prati kanale koji imaju FNC
      const channelsWithExplicitFunctionCodes = new Set();

      // Prvi prolaz: iz FNC kodova (PAR_CH{index}_FNC0 ili PAR_CH{index}_FNC)
      for (const pInst of pRefs) {
        const instanceRefId = pInst?.["@_RefId"];
        if (!instanceRefId) continue;

        const pRef = indexes.parameterRefById.get(instanceRefId);
        const param = pRef ? indexes.parameterById.get(pRef.refId) : null;
        const parameterName = param?.name || pRef?.name || null;
        const value = pInst?.["@_Value"] ?? null;

        const fnMatch = String(parameterName || "").match(/^PAR_CH(\d+)_(?:FNC0|FNC)$/);
        if (!fnMatch) continue;

        const channelIndex = Number.parseInt(fnMatch[1], 10);
        channelsWithExplicitFunctionCodes.add(channelIndex); // Postavi da ovaj ima FNC kod(pouzdanije od DYNAMIC_TEXT_PAR)

        const family = getChannelFamilyFromFunctionCode(value);
        if (family) channelFamilyByIndex.set(channelIndex, family);
      }

      // Drugi prolaz: extract channel family info from DYNAMIC_TEXT_PAR parameters, 
      // ali samo za kanale koji nemaju eksplicitni FNC kod (jer eksplicitni kodovi su pouzdaniji i trebaju imati prednost)
      for (const pInst of pRefs) {
        const instanceRefId = pInst?.["@_RefId"];
        if (!instanceRefId) continue;

        const pRef = indexes.parameterRefById.get(instanceRefId);
        const param = pRef ? indexes.parameterById.get(pRef.refId) : null;
        const parameterName = param?.name || pRef?.name || null;
        const dynamicTextMatch = parseChannelTextParameterName(parameterName);
        if (!dynamicTextMatch) continue;

        // Samo postavi channel family iz DYNAMIC_TEXT_PAR ako kanal nema eksplicitni FNC kod, jer eksplicitni kodovi su pouzdaniji i trebaju imati prednost
        if (!channelsWithExplicitFunctionCodes.has(dynamicTextMatch.index)) {
          const existingFamily = channelFamilyByIndex.get(dynamicTextMatch.index);
          if (!existingFamily) {
            channelFamilyByIndex.set(dynamicTextMatch.index, dynamicTextMatch.family);
            continue;
          }

          if (existingFamily === dynamicTextMatch.family) continue;

          const existingIsLinked = linkedComObjectFamilies.has(existingFamily);
          const candidateIsLinked = linkedComObjectFamilies.has(dynamicTextMatch.family);

          // Ako za isti kanal postoji konflikt (npr. ghost SHUTTER + aktivni SWITCH),
          // preferiraj family koji je prisutan među aktivnim linkanim ComObjectima.
          if (!existingIsLinked && candidateIsLinked) {
            channelFamilyByIndex.set(dynamicTextMatch.index, dynamicTextMatch.family);
          }
        }
      }
    }

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
      changedParameters: [],
      groupLinks: []
    };

    if (appId && pRefs.length > 0) {
      if (indexes) {
        for (const pInst of pRefs) {
          const instanceRefId = pInst?.["@_RefId"];
          const value = pInst?.["@_Value"] ?? null;

          const pRef = indexes.parameterRefById.get(instanceRefId);
          const param = pRef ? indexes.parameterById.get(pRef.refId) : null;
          const parameterName = param?.name || pRef?.name || null;
          const channelTextMeta = parseChannelTextParameterName(parameterName);
          if (channelTextMeta) {
            const activeFamily = channelFamilyByIndex.get(channelTextMeta.index);
            // Preskoci ako ne postoji ili ako se chanel family ne slaže s onim iz funkcijskog koda (ako postoji)
            if (activeFamily !== channelTextMeta.family) {
              continue;
            }
          }

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

    if (comObjectRefs.length > 0) {
      for (const cInst of comObjectRefs) {
        const instanceRefId = cInst?.["@_RefId"] || null;
        const channelId = cInst?.["@_ChannelId"] || null;
        const description = cInst?.["@_Description"] || null;
        const instanceDatapointType = cInst?.["@_DatapointType"] || null;
        const links = splitLinkIds(cInst?.["@_Links"]);

        let comRef = null;
        let comObject = null;
        if (indexes && instanceRefId) {
          comRef =
            indexes.comObjectRefBySuffix.get(instanceRefId) ||
            indexes.comObjectRefById.get(instanceRefId) ||
            null;

          if (comRef?.refId) {
            comObject =
              indexes.comObjectById.get(comRef.refId) ||
              indexes.comObjectBySuffix.get(extractObjectSuffix(comRef.refId)) ||
              null;
          }

          if (!comObject) {
            comObject =
              indexes.comObjectBySuffix.get(instanceRefId) ||
              indexes.comObjectById.get(instanceRefId) ||
              null;
          }
        }

        if (links.length === 0) {
          device.groupLinks.push({
            instanceRefId,
            channelId,
            description,
            linkId: null,
            groupAddressId: null,
            groupAddressName: null,
            groupAddressAddress: null,
            groupAddressThreeLevelAddress: null,
            groupAddressDatapointType: null,
            comObjectRefId: comRef?.id || null,
            comObjectId: comRef?.refId || comObject?.id || null,
            comObjectName: comRef?.name || comObject?.name || null,
            comObjectText: comRef?.text || comObject?.text || null,
            comObjectFunctionText: comRef?.functionText || comObject?.functionText || null,
            comObjectDatapointType:
              comRef?.datapointType || comObject?.datapointType || instanceDatapointType || null,
            comObjectSize: comRef?.objectSize || comObject?.objectSize || null
          });
          continue;
        }

        for (const linkId of links) {
          const ga = groupAddressByToken.get(linkId) || null;

          device.groupLinks.push({
            instanceRefId,
            channelId,
            description,
            linkId,
            groupAddressId: ga?.id || null,
            groupAddressName: ga?.name || null,
            groupAddressAddress: ga?.address || null,
            groupAddressThreeLevelAddress: ga?.address3Level || null,
            groupAddressDatapointType: ga?.datapointType || null,
            comObjectRefId: comRef?.id || null,
            comObjectId: comRef?.refId || comObject?.id || null,
            comObjectName: comRef?.name || comObject?.name || null,
            comObjectText: comRef?.text || comObject?.text || null,
            comObjectFunctionText: comRef?.functionText || comObject?.functionText || null,
            comObjectDatapointType:
              comRef?.datapointType || comObject?.datapointType || instanceDatapointType || null,
            comObjectSize: comRef?.objectSize || comObject?.objectSize || null
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
  if (!INPUT_FILE) {
    throw new Error(
      "Usage: npm run knx:extract -- <project.knxproj> [output-directory]"
    );
  }

  if (!fs.existsSync(INPUT_FILE)) {
    throw new Error(`KNX project not found: ${INPUT_FILE}`);
  }

  ensureDirectory(OUTPUT_DIR);

  const zip = new AdmZip(INPUT_FILE);
  const extractedCount = extractXmlFiles(zip, OUTPUT_DIR);
  console.log(`Extracted ${extractedCount} XML file(s) to ${OUTPUT_DIR}`);

  const deviceCount = buildDeviceSettingsJson();
  console.log(`Wrote settings JSON for ${deviceCount} device instance(s) to ${OUTPUT_JSON}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  resolveZipEntryTarget,
};
