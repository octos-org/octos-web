import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const certificateDirectory = resolve(projectRoot, ".cert");
const certificatePath = resolve(certificateDirectory, "octos-web.pem");
const keyPath = resolve(certificateDirectory, "octos-web-key.pem");

function privateIpv4Addresses() {
  const addresses = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (
        entry.family === "IPv4" &&
        !entry.internal &&
        (/^10\./.test(entry.address) ||
          /^192\.168\./.test(entry.address) ||
          /^172\.(1[6-9]|2\d|3[01])\./.test(entry.address))
      ) {
        addresses.push(entry.address);
      }
    }
  }
  return addresses;
}

function runMkcert(args) {
  try {
    execFileSync("mkcert", args, { cwd: projectRoot, stdio: "inherit" });
  } catch (cause) {
    if (cause?.code === "ENOENT") {
      throw new Error(
        "mkcert is not installed. On macOS, install it with `brew install mkcert`.",
      );
    }
    throw cause;
  }
}

mkdirSync(certificateDirectory, { recursive: true });
runMkcert(["-install"]);

const host = hostname();
const names = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  host,
  host.endsWith(".local") ? host : `${host}.local`,
  ...privateIpv4Addresses(),
]);

runMkcert([
  "-cert-file",
  certificatePath,
  "-key-file",
  keyPath,
  ...names,
]);

console.log("\nLocal HTTPS is ready for:");
for (const name of names) {
  const address = name.includes(":") ? `[${name}]` : name;
  console.log(`  https://${address}:5173/learn`);
}
console.log("\nStart the development server with: pnpm dev:https");
