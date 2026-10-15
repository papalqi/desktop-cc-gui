import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scripts = path.join(root, "scripts");
const psQuote = (s) => `'${s.replaceAll("'", "''")}'`;
const shQuote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
const encoded = (s) => Buffer.from(s, "utf16le").toString("base64");
const updateId = () => {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "");
  return `${stamp.slice(0, 8)}-${stamp.slice(8, 14)}-${randomUUID().slice(0, 8)}`;
};
const hash = async (p) => createHash("sha256").update(await readFile(p)).digest("hex").toUpperCase();

export function runCommand(command, args, { cwd = root, input, inherit = false } = {}) {
  return new Promise((resolve, reject) => {
    // pnpm launched from PowerShell 7 otherwise passes its modules into Windows PowerShell 5.1.
    const env = command === "powershell.exe" ? Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "psmodulepath")) : process.env;
    const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: inherit ? "inherit" : "pipe" });
    let stdout = "", stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(`${command} exited ${code}: ${stderr.trim() || stdout.trim()}`)));
    child.stdin?.on("error", () => {}); // A rejected SSH connection may close stdin first.
    child.stdin?.end(input);
  });
}

export function sshArgs(connection, scp = false) {
  const args = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=yes"];
  if (connection.port) args.push(scp ? "-P" : "-p", String(connection.port));
  if (connection.identityFile) args.push("-o", "IdentitiesOnly=yes", "-i", connection.identityFile);
  return args;
}

export async function packageWindows(run = runCommand) {
  if (process.platform !== "win32") throw new Error("Build the Windows package on Windows.");
  console.log("Building frontend and Windows release executable...");
  await run("cmd.exe", ["/d", "/s", "/c", "pnpm build"], { inherit: true });
  // A local release app may be running from target/release; Windows locks that executable.
  const targetDir = path.join(root, "src-tauri", "target", "relay-build");
  await run("cargo.exe", ["build", "--bin", "ccgui-next", "--features", "tauri/custom-protocol", "--release", "--target-dir", targetDir], { cwd: path.join(root, "src-tauri"), inherit: true });
  const directory = path.join(root, "artifacts", "windows", updateId());
  const payload = path.join(directory, "payload");
  await mkdir(payload, { recursive: true });
  await copyFile(path.join(targetDir, "release", "ccgui-next.exe"), path.join(payload, "ccgui-next.exe"));
  for (const name of ["agent-catalogs", "skills"]) await cp(path.join(root, "src-tauri", "resources", name), path.join(payload, name), { recursive: true });
  const archive = path.join(directory, "package.zip");
  await run("powershell.exe", ["-NoProfile", "-EncodedCommand", encoded(`$ErrorActionPreference='Stop'; Compress-Archive -Path ${psQuote(path.join(payload, "*"))} -DestinationPath ${psQuote(archive)}`)]);
  const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const artifact = { version, archiveHash: await hash(archive), exeHash: await hash(path.join(payload, "ccgui-next.exe")) };
  await writeFile(path.join(directory, "manifest.json"), JSON.stringify(artifact, null, 2) + "\n");
  console.log(`Package: ${directory}`);
  return { ...artifact, directory, archive };
}

export async function readArtifact(directory) {
  directory = path.resolve(directory);
  const artifact = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
  if (artifact.superseded) throw new Error("This package was superseded; build or select the current reviewed package.");
  const archive = path.join(directory, "package.zip");
  if (await hash(archive) !== artifact.archiveHash) throw new Error("Package archive changed since it was built.");
  return { ...artifact, directory, archive };
}

export async function relayHealth(config, machine, run = runCommand) {
  const relay = config.relay;
  const data = Buffer.from(JSON.stringify({ machine, sessionFile: `${relay.directory}/sessions.json`, wsUrl: relay.wsUrl })).toString("base64");
  const source = await readFile(path.join(scripts, "check-relay.mjs"), "utf8");
  return JSON.parse(await run("ssh.exe", [...sshArgs(relay), relay.host, `${shQuote(relay.bun)} run - ${data}`], { input: source }));
}

function requireIdle(health, machine) {
  if (health.activeRuns !== 0) throw new Error(`${machine} has ${health.activeRuns} active runs; wait for them to finish before updating.`);
}

async function waitForRelay(config, machine, run) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try { return await relayHealth(config, machine, run); }
    catch (error) {
      if (attempt === 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

export async function updateMachine(config, machine, artifact, { run = runCommand, rollbackReceipt } = {}) {
  const connection = config.machines[machine];
  if (!connection) throw new Error(`Unknown Windows target: ${machine}. Configure scripts/deploy-windows.local.json.`);
  if (!rollbackReceipt) requireIdle(await relayHealth(config, machine, run), machine);
  const id = rollbackReceipt?.id ?? updateId();
  const stageId = updateId();
  const setup = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $dir=Join-Path $env:TEMP 'ccgui-update-${stageId}'; New-Item -ItemType Directory -Path $dir | Out-Null; @{stage=$dir} | ConvertTo-Json -Compress`;
  const { stage } = JSON.parse(await run("ssh.exe", [...sshArgs(connection), connection.host, `powershell -NoProfile -EncodedCommand ${encoded(setup)}`]));
  if (!/^[a-z]:[\\/]/i.test(stage) || /["%\r\n]/.test(stage)) throw new Error("Remote temporary directory is not a safe Windows path.");
  const remote = stage.replaceAll("\\", "/");
  const receiptDir = path.join(root, "artifacts", "deploy", machine);
  await mkdir(receiptDir, { recursive: true });
  const requestFile = path.join(receiptDir, `${stageId}.request.json`);
  await writeFile(requestFile, JSON.stringify({ id, task: connection.task, archiveHash: artifact?.archiveHash, exeHash: artifact?.exeHash }));
  const saveReceipt = async (receipt) => {
    const json = JSON.stringify(receipt, null, 2) + "\n";
    await writeFile(path.join(receiptDir, `${id}.json`), json);
    await writeFile(path.join(receiptDir, "latest.json"), json);
  };
  const invoke = async (action) => JSON.parse(await run("ssh.exe", [...sshArgs(connection), connection.host, `powershell -NoProfile -ExecutionPolicy Bypass -File "${remote}/install-windows.ps1" -Action ${action} -Request "${remote}/request.json"`]));
  try {
    await run("scp.exe", [...sshArgs(connection, true), path.join(scripts, "install-windows.ps1"), `${connection.host}:${remote}/install-windows.ps1`]);
    await run("scp.exe", [...sshArgs(connection, true), requestFile, `${connection.host}:${remote}/request.json`]);
    if (rollbackReceipt) {
      const restored = await invoke("rollback");
      const health = await waitForRelay(config, machine, run);
      const receipt = { ...rollbackReceipt, status: "rolled-back", rolledBack: true, restored, health };
      await saveReceipt(receipt);
      return receipt;
    }
    console.log(`Uploading package to ${machine}...`);
    await run("scp.exe", [...sshArgs(connection, true), artifact.archive, `${connection.host}:${remote}/package.zip`]);
    const baseline = await invoke("prepare");
    requireIdle(await relayHealth(config, machine, run), machine);
    // Save recovery information before the first stop/replacement, including if SSH disconnects.
    let receipt = { id, machine, artifact: artifact.directory, baseline, status: "prepared" };
    await saveReceipt(receipt);
    let installed;
    try { installed = await invoke("apply"); } // Installation failures restore the backup on the target.
    catch (error) {
      receipt = { ...receipt, status: "apply-failed", error: error.message };
      await saveReceipt(receipt);
      throw error;
    }
    receipt = { ...receipt, status: "installed", installed };
    await saveReceipt(receipt);
    try {
      const health = await waitForRelay(config, machine, run);
      if (health.version !== artifact.version) throw new Error("Relay reports an unexpected application version.");
      receipt = { ...receipt, status: "healthy", installed, health };
    } catch (error) {
      // The target checks its local bridge before rollback, even if the relay is unavailable.
      let restored;
      try { restored = await invoke("rollback"); }
      catch (rollbackError) {
        receipt = { ...receipt, status: "rollback-failed", error: error.message, rollbackError: rollbackError.message };
        await saveReceipt(receipt);
        throw new Error(`Health check failed: ${error.message}; rollback failed: ${rollbackError.message}; backup: ${installed.backup}`);
      }
      receipt = { ...receipt, status: "rolled-back", restored, error: error.message };
      await saveReceipt(receipt);
      await waitForRelay(config, machine, run);
      throw new Error(`Health check failed; backup restored: ${error.message}`);
    }
    await saveReceipt(receipt);
    return receipt;
  } finally {
    const cleanup = `$ErrorActionPreference='Stop'; $dir=${psQuote(stage)}; $expected=[IO.Path]::GetFullPath((Join-Path $env:TEMP 'ccgui-update-${stageId}')); if ([IO.Path]::GetFullPath($dir) -ne $expected) { throw 'Cleanup path mismatch' }; Remove-Item -LiteralPath $dir -Recurse -Force`;
    try { await run("ssh.exe", [...sshArgs(connection), connection.host, `powershell -NoProfile -EncodedCommand ${encoded(cleanup)}`]); }
    catch (error) { console.warn(`Temporary upload retained at ${stage}: ${error.message}`); }
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--package") { await packageWindows(); return; }
  const machine = args.shift()?.toUpperCase();
  if (!machine || !(args.length === 0 || (args.length === 1 && args[0] === "--rollback") || (args.length === 2 && args[0] === "--artifact"))) {
    throw new Error("Usage: pnpm deploy:win PC6 [--artifact <package-directory> | --rollback]");
  }
  const config = JSON.parse(await readFile(path.join(scripts, "deploy-windows.local.json"), "utf8"));
  if (!config.machines[machine]) throw new Error(`Unknown Windows target: ${machine}`);
  const rollbackReceipt = args.includes("--rollback") ? JSON.parse(await readFile(path.join(root, "artifacts", "deploy", machine, "latest.json"), "utf8")) : undefined;
  if (rollbackReceipt?.rolledBack || rollbackReceipt?.status === "rolled-back") throw new Error("This deployment has already been rolled back.");
  if (!rollbackReceipt) requireIdle(await relayHealth(config, machine), machine);
  const artifactArg = args.indexOf("--artifact");
  const artifact = rollbackReceipt ? undefined : artifactArg >= 0 ? await readArtifact(args[artifactArg + 1]) : await packageWindows();
  const receipt = await updateMachine(config, machine, artifact, { rollbackReceipt });
  console.log(`${machine}: ${receipt.rolledBack ? "backup restored" : "updated"}; relay ${receipt.health.version}, frontend and workspace API healthy.`);
  console.log(`Receipt: ${path.join(root, "artifacts", "deploy", machine, `${receipt.id}.json`)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
