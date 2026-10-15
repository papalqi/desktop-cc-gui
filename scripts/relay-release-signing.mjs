import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RELEASE_FILES = ["package.zip", "install-windows.ps1", "install-self-update.ps1"];
const versionPattern = /^\d+\.\d+\.\d+$/;

export function releasePayload(manifest) {
  return Buffer.from(JSON.stringify({ version: manifest.version, protocol: manifest.protocol,
    ...(manifest.minHubProtocol == null ? {} : { minHubProtocol: manifest.minHubProtocol }),
    files: manifest.files.map(({ name, url, bytes, sha256 }) => ({ name, url, bytes, sha256 })) }));
}

export async function createReleaseKey(privatePath, publicPath) {
  await mkdir(dirname(resolve(privatePath)), { recursive: true, mode: 0o700 });
  let privateKey;
  try { privateKey = createPrivateKey(await readFile(privatePath)); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    privateKey = generateKeyPairSync("ed25519").privateKey;
    await writeFile(privatePath, privateKey.export({ type: "pkcs8", format: "pem" }), { flag: "wx", mode: 0o600 });
  }
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("Release key must be Ed25519");
  const publicKey = createPublicKey(privateKey).export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
  await mkdir(dirname(resolve(publicPath)), { recursive: true });
  try {
    if ((await readFile(publicPath, "utf8")).trim() !== publicKey) throw new Error("Pinned release public key differs; rotate it through a reviewed application update");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await writeFile(publicPath, publicKey + "\n", { flag: "wx" });
  }
  return { privatePath: resolve(privatePath), publicPath: resolve(publicPath) };
}

export async function signRelease({ version, protocol = 0, minHubProtocol, baseUrl, directory, privateKey }) {
  if (!versionPattern.test(version) || ![0, 1].includes(protocol)) throw new Error("Invalid release version or protocol");
  const base = new URL(baseUrl.endsWith("/") ? baseUrl : baseUrl + "/");
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error("Invalid release base URL");
  const files = [];
  for (const name of RELEASE_FILES) {
    const bytes = await readFile(resolve(directory, name));
    files.push({ name, url: new URL(name, base).href, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  const manifest = { version, protocol, ...(minHubProtocol == null ? {} : { minHubProtocol }), files };
  const key = createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Release key must be Ed25519");
  manifest.signature = sign(null, releasePayload(manifest), key).toString("base64");
  if (!verify(null, releasePayload(manifest), createPublicKey(key), Buffer.from(manifest.signature, "base64"))) throw new Error("Release signature did not verify");
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [operation, privatePath, publicPath] = process.argv.slice(2);
  if (operation !== "--create-key" || !privatePath || !publicPath) throw new Error("Usage: node scripts/relay-release-signing.mjs --create-key <offline-private-key.pem> <pinned-public-key.txt>");
  console.log(JSON.stringify(await createReleaseKey(privatePath, publicPath)));
}
