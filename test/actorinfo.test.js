import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";

function runModule(script) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

test("setActorInfo validates actor id", () => {
  const script = `
    import { Dacument } from "./dist/index.js";
    import { generateSignPair } from "zeyra";
    const pair = await generateSignPair();
    try {
      await Dacument.setActorInfo({
        id: "not-base64url",
        privateKeyJwk: pair.signingJwk,
        publicKeyJwk: pair.verificationJwk,
      });
      process.exit(1);
    } catch {
      process.exit(0);
    }
  `;
  const result = runModule(script);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("setActorInfo validates key pairs", () => {
  const script = `
    import { Dacument } from "./dist/index.js";
    import { generateSignPair } from "zeyra";
    import { generateNonce } from "bytecodec";
    const id = generateNonce();
    const pair = await generateSignPair();
    const other = await generateSignPair();
    try {
      await Dacument.setActorInfo({
        id,
        privateKeyJwk: pair.signingJwk,
        publicKeyJwk: other.verificationJwk,
      });
      process.exit(1);
    } catch {
      process.exit(0);
    }
  `;
  const result = runModule(script);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
