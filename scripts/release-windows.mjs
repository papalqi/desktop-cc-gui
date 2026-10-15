import { readFile, writeFile, copyFile } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { packageWindows, readArtifact, runCommand, sshArgs } from "./deploy-windows.mjs";
import { signRelease, RELEASE_FILES } from "./relay-release-signing.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

export async function publishWindows({ artifact, relay, privateKeyPath, publicKey, run = runCommand }) {
  const directory = artifact.directory;
  if (!relay.releaseUrl || !relay.directory.startsWith("/") || !/^\d+\.\d+\.\d+$/.test(artifact.version)) throw new Error("Configure relay.releaseUrl and an absolute relay.directory before publishing.");
  for (const name of RELEASE_FILES.slice(1)) await copyFile(join(root, "scripts", name), join(directory, name));
  const baseUrl = new URL(`releases/windows/${artifact.version}/`, relay.releaseUrl.endsWith("/") ? relay.releaseUrl : relay.releaseUrl + "/").href;
  const privateBytes = await readFile(privateKeyPath);
  const signerPublicKey = createPublicKey(createPrivateKey(privateBytes)).export({type:"spki",format:"der"}).subarray(-32).toString("base64");
  if (publicKey?.trim() !== signerPublicKey) throw new Error("Release signer differs from the public key pinned in the application.");
  const manifest = await signRelease({ version:artifact.version, baseUrl, directory, privateKey:privateBytes });
  const signed = join(directory, "signed-manifest.json");
  await writeFile(signed, JSON.stringify(manifest, null, 2) + "\n");
  const channel = relay.directory + "/releases/windows";
  const destination = channel + "/" + artifact.version;
  await run("ssh.exe", [...sshArgs(relay), relay.host, `mkdir -p ${shQuote(channel)} && mkdir ${shQuote(destination)}`]);
  for (const name of RELEASE_FILES) await run("scp.exe", [...sshArgs(relay, true), join(directory, name), `${relay.host}:${destination}/${name}`]);
  await run("scp.exe", [...sshArgs(relay, true), signed, `${relay.host}:${destination}/manifest.json`]);
  // Publish only once every versioned file is uploaded. Private key bytes
  // never leave this process or become an SSH argument.
  await run("ssh.exe", [...sshArgs(relay), relay.host, `cp ${shQuote(destination + "/manifest.json")} ${shQuote(channel + "/manifest.json.new")} && mv ${shQuote(channel + "/manifest.json.new")} ${shQuote(channel + "/manifest.json")}`]);
  const receipt = { version:artifact.version, channel:"windows", publishedAt:new Date().toISOString(), manifest:signed, enabledMachines:[] };
  await writeFile(join(directory, "release-receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  return receipt;
}

async function main() {
  const args = process.argv.slice(2);
  if (!(args.length === 0 || (args.length === 2 && args[0] === "--artifact"))) throw new Error("Usage: pnpm release:win [--artifact <package-directory>]");
  const privateKeyPath = process.env.CCGUI_RELEASE_PRIVATE_KEY;
  if (!privateKeyPath) throw new Error("Set CCGUI_RELEASE_PRIVATE_KEY to the offline Ed25519 key path.");
  const dirty = await runCommand("git", ["status", "--porcelain"]);
  if (dirty) throw new Error("Commit the reviewed source before publishing a release.");
  const { relay } = JSON.parse(await readFile(join(root, "scripts/deploy-windows.local.json"), "utf8"));
  const artifact = args.length ? await readArtifact(args[1]) : await packageWindows();
  const publicKey = await readFile(join(root,"src-tauri/resources/relay-update-public-key.txt"),"utf8");
  console.log(JSON.stringify(await publishWindows({ artifact, relay, privateKeyPath, publicKey })));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
