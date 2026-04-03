

const AdmZip = require("adm-zip");
const fs = require("fs");
const path = require("path");

const INPUT_FILE = "project.knxproj";
const OUTPUT_FILE = "structure.json";

// Build tree structure from zip entries
function buildTree(entries) {
  const root = {};

  entries.forEach(entry => {
    const parts = entry.entryName.split("/").filter(Boolean);

    let current = root;

    parts.forEach((part, index) => {
      const isFile = index === parts.length - 1 && !entry.isDirectory;

      if (!current[part]) {
        current[part] = isFile ? "file" : {};
      }

      current = current[part];
    });
  });

  return root;
}

// Main
function main() {
  const zip = new AdmZip(INPUT_FILE);
  const entries = zip.getEntries();

  const tree = buildTree(entries);

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(tree, null, 2));

  console.log(`Structure written to ${OUTPUT_FILE}`);
}

main();