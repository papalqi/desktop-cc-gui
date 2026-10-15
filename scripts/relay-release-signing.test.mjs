import assert from "node:assert/strict";
import test from "node:test";
import { createPrivateKey, createPublicKey, verify } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReleaseKey, releasePayload, RELEASE_FILES, signRelease } from "./relay-release-signing.mjs";

async function fixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "ccgui-release-signing-")));
  t.after(async () => { assert.equal(await realpath(directory), directory); await rm(directory, { recursive: true, force: true }); });
  for (const name of RELEASE_FILES) await writeFile(join(directory, name), "signed test file: " + name);
  return directory;
}

test("offline key generation keeps the pinned key stable and refuses an unreviewed key rotation", async (t) => {
  const directory = await fixture(t);
  const privatePath = join(directory, "private.pem"), publicPath = join(directory, "public.txt");
  await createReleaseKey(privatePath, publicPath);
  const original = await readFile(privatePath);
  await createReleaseKey(privatePath, publicPath);
  assert.deepEqual(await readFile(privatePath), original);
  await writeFile(publicPath, "different pinned public key\n");
  await assert.rejects(() => createReleaseKey(privatePath, publicPath), /Pinned release public key differs/);
});

test("signed manifests bind the version, protocol and every installer byte", async (t) => {
  const directory = await fixture(t);
  const privatePath = join(directory, "private.pem");
  await createReleaseKey(privatePath, join(directory, "public.txt"));
  const key = createPrivateKey(await readFile(privatePath));
  const manifest = await signRelease({ version: "1.2.1", directory, privateKey: await readFile(privatePath), baseUrl: "http://127.0.0.1:8787/_relay/releases/stable/1.2.1/" });
  const publicKey = createPublicKey(key);
  const signature = Buffer.from(manifest.signature, "base64");
  assert.equal(verify(null, releasePayload(manifest), publicKey, signature), true);
  manifest.version = "1.3.0";
  assert.equal(verify(null, releasePayload(manifest), publicKey, signature), false);
  manifest.version = "1.2.1";
  manifest.files[0].sha256 = "0".repeat(64);
  assert.equal(verify(null, releasePayload(manifest), publicKey, signature), false);
  await assert.rejects(() => signRelease({ version: "invalid", directory, privateKey: key, baseUrl: "http://127.0.0.1/" }), /Invalid release version/);
});
