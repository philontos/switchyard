import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseClamshell,
  parseMacHardware,
  parsePmsetCustom,
  parsePowerSource,
} from "./power.ts";

test("pmset parser separates AC and battery idle/display sleep", () => {
  const parsed = parsePmsetCustom(`
Battery Power:
 sleep                5
 displaysleep         2
 tcpkeepalive         1
AC Power:
 sleep                0
 displaysleep         10
 tcpkeepalive         1
`);
  assert.equal(parsed.battery.sleep, 5);
  assert.equal(parsed.battery.displaysleep, 2);
  assert.equal(parsed.ac.sleep, 0);
  assert.equal(parsed.ac.displaysleep, 10);
});

test("pmset power source parser recognizes AC and battery", () => {
  assert.equal(parsePowerSource("Now drawing from 'AC Power'"), "ac");
  assert.equal(parsePowerSource("Now drawing from 'Battery Power'"), "battery");
  assert.equal(parsePowerSource("unknown"), "unknown");
});

test("hardware and clamshell parsers identify a current MacBook lid policy", () => {
  const hardware = parseMacHardware(JSON.stringify({
    SPHardwareDataType: [{ machine_name: "MacBook Pro", machine_model: "Mac17,8" }],
  }));
  assert.deepEqual(hardware, { name: "MacBook Pro", model: "Mac17,8" });
  assert.deepEqual(
    parseClamshell('"AppleClamshellCausesSleep" = No\n"AppleClamshellState" = Yes'),
    { causesSleep: false, closed: true },
  );
});
