import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { request } from "../protocol.ts";
import { present } from "../fakes.ts";
import { retirementNative, type RetirementMode } from "./retirement-native.ts";

function parseMode(value: string | undefined): RetirementMode {
  switch (value) {
    case "idle": case "busy": case "pending": case "queued": case "no-shutdown": case "noauth": case "resume": return value;
    default: throw new Error(`invalid retirement child mode: ${value}`);
  }
}
const directory = present(process.env.RETIRE_STATE, "retirement state");
const id = present(process.argv[2], "child id");
const mode = parseMode(process.argv[3]);
const parent = present(process.argv[4], "child parent");
const { native, identity } = retirementNative(directory, { kind: "child", id, mode, parent });
  const fixture = native();
  await fixture.emit({ type: "session_start", reason: "startup" });
  if (mode === "busy" || mode === "pending") {
    await request(identity(id).socketPath, { kind: "submit", callerId: id, callerGeneration: identity(id).generation,
      generation: identity(id).generation, submissionId: `task-${id}`, task: "do not retire" });
  }
  writeFileSync(join(present(process.env.RETIRE_STATE, "retirement state"), `${id}.ready`), "ready");
  setInterval(() => {}, 1000);
