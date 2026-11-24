const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const tls = require("node:tls");
const { installExtraCertificates, readExtraCertificates } = require("../middleware/caCertificates");

// Public root certificates stand in for a site CA; no private key is needed.
const [first, second] = tls.rootCertificates;

test("accepts PEM with real or escaped line breaks, base64 and files", (t) => {
  assert.deepEqual(readExtraCertificates({ EWS_CA_CERT: first }), [first]);
  assert.deepEqual(readExtraCertificates({ EWS_CA_CERT: first.replace(/\n/g, "\\n") }), [first]);
  assert.deepEqual(readExtraCertificates({ EWS_CA_CERT: Buffer.from(`${first}\n${second}\n`).toString("base64") }), [first, second]);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ews-ca-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "site-ca.pem");
  fs.writeFileSync(file, `${second}\n`);
  assert.deepEqual(readExtraCertificates({ EWS_CA_CERT: first, EWS_CA_FILE: file }), [first, second]);
});

test("rejects values that are not certificates instead of starting without them", () => {
  assert.throws(() => readExtraCertificates({ EWS_CA_CERT: "not a certificate" }), /EWS_CA_CERT must contain/);
  const broken = first.replace(/\n[A-Za-z0-9+/]{20}/, "\nAAAAAAAAAAAAAAAAAAAA");
  assert.throws(() => readExtraCertificates({ EWS_CA_CERT: broken }), /not a valid X.509/);
  assert.throws(() => readExtraCertificates({ EWS_CA_FILE: path.join(os.tmpdir(), "missing-ews-ca.pem") }), /Unable to read EWS_CA_FILE/);
});

test("adds certificates to the existing trust list and changes nothing when unset", () => {
  const calls = [];
  const fake = { getCACertificates: () => ["built-in"], setDefaultCACertificates: (list) => calls.push(list) };
  assert.equal(installExtraCertificates({}, fake), 0);
  assert.deepEqual(calls, []);
  assert.equal(installExtraCertificates({ EWS_CA_CERT: first }, fake), 1);
  assert.deepEqual(calls, [["built-in", first]]);
});
