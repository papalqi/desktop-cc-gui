import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runCommand, updateMachine } from "./deploy-windows.mjs";

const healthy = { version: "1.1.3", activeRuns: 0, workspaces: 9, frontend: true };
const artifact = { directory: "test-package", archive: "test-package/package.zip", archiveHash: "A", exeHash: "B", version: "1.1.3" };
const config = (machine) => ({ relay: { host: "relay", directory: "/relay", bun: "/bin/bun", wsUrl: "ws://localhost/ws" }, machines: { [machine]: { host: "desktop", task: "CCGUIRelay" } } });

function commands({ health = () => healthy, prepareError, applyError, rollbackError } = {}) {
  const actions = [];
  let healthChecks = 0;
  const run = async (command, args) => {
    const remote = args.at(-1);
    if (command === "scp.exe") { actions.push("upload"); return ""; }
    if (remote.includes(" run - ")) return JSON.stringify(health(++healthChecks));
    const action = remote.match(/-Action (prepare|apply|rollback)/)?.[1];
    if (!action) return JSON.stringify({ stage: "C:/Temp/ccgui-test-stage" });
    actions.push(action);
    if (action === "prepare" && prepareError) throw new Error(prepareError);
    if (action === "apply" && applyError) throw new Error(applyError);
    if (action === "rollback" && rollbackError) throw new Error(rollbackError);
    return JSON.stringify(action === "prepare" ? { oldHash: "OLD", oldPid: 1 } : { sha256: action === "rollback" ? "OLD" : "B", newPid: 2 });
  };
  return { run, actions };
}

test("busy machine is rejected before uploading or preparing a backup", async () => {
  const fixture = commands({ health: () => ({ ...healthy, activeRuns: 1 }) });
  await assert.rejects(updateMachine(config("TEST_BUSY"), "TEST_BUSY", artifact, fixture), /1 active runs/);
  assert.deepEqual(fixture.actions, []);
});

test("a turn started during preparation prevents replacement", async () => {
  const fixture = commands({ health: (n) => ({ ...healthy, activeRuns: n === 2 ? 1 : 0 }) });
  await assert.rejects(updateMachine(config("TEST_RACE"), "TEST_RACE", artifact, fixture), /active runs/);
  assert.ok(fixture.actions.includes("prepare"));
  assert.ok(!fixture.actions.includes("apply"));
});

test("failed backup preparation does not attempt installation", async () => {
  const fixture = commands({ prepareError: "Uploaded archive mismatch" });
  await assert.rejects(updateMachine(config("TEST_BACKUP"), "TEST_BACKUP", artifact, fixture), /archive mismatch/);
  assert.ok(!fixture.actions.includes("apply"));
});

test("installation failure remains a failure with a recovery receipt", async () => {
  const fixture = commands({ applyError: "Update failed and backup restored" });
  await assert.rejects(updateMachine(config("TEST_INSTALL"), "TEST_INSTALL", artifact, fixture), /backup restored/);
  const receipt = JSON.parse(await readFile("artifacts/deploy/TEST_INSTALL/latest.json", "utf8"));
  assert.equal(receipt.status, "apply-failed");
  assert.equal(receipt.baseline.oldHash, "OLD");
});

test("bad online version rolls back and reports failure", async () => {
  const fixture = commands({ health: (n) => ({ ...healthy, version: n === 3 ? "0.0.0" : "1.1.3" }) });
  await assert.rejects(updateMachine(config("TEST_HEALTH"), "TEST_HEALTH", artifact, fixture), /Health check failed; backup restored/);
  assert.deepEqual(fixture.actions.filter((a) => a !== "upload"), ["prepare", "apply", "rollback"]);
  const receipt = JSON.parse(await readFile("artifacts/deploy/TEST_HEALTH/latest.json", "utf8"));
  assert.equal(receipt.status, "rolled-back");
});

test("healthy update records the backup and online verification", async () => {
  const fixture = commands();
  const receipt = await updateMachine(config("TEST_SUCCESS"), "TEST_SUCCESS", artifact, fixture);
  assert.equal(receipt.status, "healthy");
  assert.equal(receipt.health.frontend, true);
  assert.equal(receipt.baseline.oldHash, "OLD");
  assert.ok(!fixture.actions.includes("rollback"));
});

test("a blocked rollback preserves the failure and installed-state receipt", async () => {
  const fixture = commands({ health: (n) => ({ ...healthy, version: n === 3 ? "0.0.0" : "1.1.3" }), rollbackError: "App has active turns; app was not stopped" });
  await assert.rejects(updateMachine(config("TEST_BLOCKED"), "TEST_BLOCKED", artifact, fixture), /rollback failed: App has active turns/);
  const receipt = JSON.parse(await readFile("artifacts/deploy/TEST_BLOCKED/latest.json", "utf8"));
  assert.equal(receipt.status, "rollback-failed");
  assert.equal(receipt.installed.sha256, "B");
});

test("explicit rollback skips packaging and checks the restored service", async () => {
  const fixture = commands();
  const receipt = await updateMachine(config("TEST_ROLLBACK"), "TEST_ROLLBACK", undefined, { ...fixture, rollbackReceipt: { id: "20261012-000000-abcd1234" } });
  assert.equal(receipt.rolledBack, true);
  assert.equal(receipt.restored.sha256, "OLD");
  assert.deepEqual(fixture.actions.filter((a) => a !== "upload"), ["rollback"]);
});

test("Windows installer restores real files after copy/start failures and rejects busy updates", { skip: process.platform !== "win32" }, async () => {
  const output = await runCommand("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "scripts/install-windows.test.ps1"]);
  assert.match(output, /6 installer scenarios passed/);
  console.log(output);
});
