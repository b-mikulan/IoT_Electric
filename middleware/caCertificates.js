const fs = require("node:fs");
const tls = require("node:tls");
const { X509Certificate } = require("node:crypto");

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

// Portainer and .env files keep values on one line, so EWS_CA_CERT accepts PEM
// with real or escaped (\n) line breaks, or the whole PEM encoded as base64.
function decodeCertificateText(value) {
  const text = String(value).trim().replace(/\\n/g, "\n");
  if (text.includes("-----BEGIN")) return text;
  const decoded = Buffer.from(text.replace(/\s+/g, ""), "base64").toString("utf8");
  if (!decoded.includes("-----BEGIN CERTIFICATE-----")) {
    throw new Error("EWS_CA_CERT must contain a PEM certificate or a base64-encoded PEM certificate.");
  }
  return decoded;
}

function parseCertificates(text, source) {
  const blocks = text.match(PEM_BLOCK) || [];
  if (!blocks.length) throw new Error(`${source} does not contain a PEM certificate.`);
  return blocks.map((block, index) => {
    // A controller may use a self-signed server certificate instead of a CA.
    try { new X509Certificate(block); }
    catch { throw new Error(`${source} certificate ${index + 1} is not a valid X.509 certificate.`); }
    return block;
  });
}

function readExtraCertificates(env = process.env) {
  const certificates = [];
  const inline = String(env.EWS_CA_CERT || "").trim();
  if (inline) certificates.push(...parseCertificates(decodeCertificateText(inline), "EWS_CA_CERT"));
  const file = String(env.EWS_CA_FILE || "").trim();
  if (file) {
    let text;
    try { text = fs.readFileSync(file, "utf8"); }
    catch (error) { throw new Error(`Unable to read EWS_CA_FILE ${file}: ${error.message}`); }
    certificates.push(...parseCertificates(text, "EWS_CA_FILE"));
  }
  return certificates;
}

// Adds the configured CAs to the certificates this process already trusts,
// including the one built into the image, for every later TLS connection.
// Without EWS_CA_CERT or EWS_CA_FILE nothing changes.
function installExtraCertificates(env = process.env, tlsModule = tls) {
  const extra = readExtraCertificates(env);
  if (!extra.length) return 0;
  tlsModule.setDefaultCACertificates([...tlsModule.getCACertificates("default"), ...extra]);
  return extra.length;
}

module.exports = { installExtraCertificates, readExtraCertificates };
