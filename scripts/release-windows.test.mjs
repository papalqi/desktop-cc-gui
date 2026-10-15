import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { generateKeyPairSync, createPublicKey } from "node:crypto";
import { publishWindows } from "./release-windows.mjs";
import { runCommand } from "./deploy-windows.mjs";

test("release publishing transfers signed installers and publishes the channel after all assets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ccgui-release-publish-"));
  const owned = await realpath(directory);
  try {
    const keyPath = join(directory,"offline.pem");
    const privateKey = generateKeyPairSync("ed25519").privateKey;
    await writeFile(keyPath, privateKey.export({type:"pkcs8",format:"pem"}));
    const publicKey = createPublicKey(privateKey).export({type:"spki",format:"der"}).subarray(-32).toString("base64");
    await writeFile(join(directory,"package.zip"), "test-package");
    const calls = [];
    const options = { artifact:{ directory,version:"1.2.1" }, relay:{ host:"hub",directory:"/hub",releaseUrl:"http://hub:8787/" }, privateKeyPath:keyPath, publicKey,
      run:async (command,args) => { calls.push({command,args}); return ""; } };
    await assert.rejects(publishWindows({...options,publicKey:"wrong-key"}),/differs from the public key/);
    assert.equal(calls.length,0);
    const result = await publishWindows({ ...options,
      run:async (command,args) => { calls.push({command,args}); return ""; } });
    assert.equal(result.version,"1.2.1");
    assert.equal(calls.at(-1).command,"ssh.exe");
    assert.match(calls.at(-1).args.at(-1), /manifest\.json\.new/);
    assert.equal(calls.filter(({command}) => command === "scp.exe").length,4);
    assert.equal(JSON.stringify(calls).includes("offline.pem"),false);
    assert.equal(JSON.stringify(calls).includes("PRIVATE KEY"),false);
    const manifest = JSON.parse(await readFile(result.manifest,"utf8"));
    assert.equal(manifest.files.length,3);
    assert.equal(manifest.files[0].url,"http://hub:8787/releases/windows/1.2.1/package.zip");
  } finally {
    if (await realpath(directory) !== owned || !owned.startsWith(await realpath(tmpdir()) + sep)) throw new Error("test cleanup escaped owned directory");
    await rm(owned,{recursive:true,force:true});
  }
});

test("independent updater checks real staged hashes and rolls back failed checks without stopping busy apps", {skip:process.platform !== "win32"}, async () => {
  const output = await runCommand("powershell.exe", ["-NoProfile","-ExecutionPolicy","Bypass","-File",new URL("./install-self-update.test.ps1",import.meta.url).pathname.replace(/^\/(?=[A-Z]:)/i,"")]);
  assert.equal(output.split("PASS self-update:").length - 1,6,output);
});
