const { randomBytes } = require("node:crypto");
const {
  createPasswordHash,
} = require("../middleware/middlewareAuth");

const username = "middleware-admin";
const password = randomBytes(24).toString("base64url");
const passwordHash = createPasswordHash(password);

console.log("Generated middleware credentials. Save the password in a password manager.");
console.log();
console.log(`Username: ${username}`);
console.log(`Password: ${password}`);
console.log();
console.log("Add these values to .env or the Portainer stack:");
console.log(`MIDDLEWARE_USER=${username}`);
console.log(`MIDDLEWARE_PASSWORD_HASH=${passwordHash}`);
