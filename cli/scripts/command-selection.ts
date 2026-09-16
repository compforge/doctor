import { createDoctorProgram } from "../src/app/main";

/** Validate against the actual Commander catalog before producing any build artifact. */
export function commandSelectionDefine(selection: string): Record<string, string> {
  createDoctorProgram({ commands: selection });
  return { __DOCTOR_COMMANDS__: JSON.stringify(selection) };
}

if (import.meta.main) {
  const define = commandSelectionDefine(process.argv[2] ?? "all");
  process.stdout.write(`__DOCTOR_COMMANDS__=${define.__DOCTOR_COMMANDS__}\n`);
}
