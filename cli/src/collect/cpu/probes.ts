export const PY_SPY_VERSION = "0.4.2";
export const DOCTOR_DEBUG_PY_SPY_PATH = "/opt/doctor/bin/py-spy";

export function pySpyPrereqCmd(): string[] {
  return [
    "sh",
    "-c",
    `test -x ${DOCTOR_DEBUG_PY_SPY_PATH} && ${DOCTOR_DEBUG_PY_SPY_PATH} --version`,
  ];
}

export function pySpyDumpCmd(path: string, pid: number): string[] {
  return [path, "dump", "--nonblocking", "--pid", String(pid)];
}
