export const PYHEAP_VERSION = "0.7.0+doctor.2";
export const PYHEAP_TOOL_DIR = "/tmp/doctor-pyheap";
export const PYHEAP_DUMP_PATH = "/opt/doctor/bin/pyheap_dump";

export function pyheapPrereqCmd(dumpPath = PYHEAP_DUMP_PATH): string[] {
  return [
    "sh",
    "-c",
    `python="$(command -v python3 || true)"; gdb="$(command -v gdb || true)"; `
    + `if [ -n "$gdb" ] && "$gdb" -nx -batch -ex 'python import sys' -ex quit >/dev/null 2>&1; then gdb_python=yes; else gdb_python=no; fi; `
    + `if { [ -d ${PYHEAP_TOOL_DIR} ] && [ -w ${PYHEAP_TOOL_DIR} ]; } `
    + `|| { [ ! -e ${PYHEAP_TOOL_DIR} ] && [ -w /tmp ]; }; then writable=yes; else writable=no; fi; `
    + `printf "python3=%s\\ngdb=%s\\ngdb_python=%s\\nwritable=%s\\npyheap=%s\\n" `
    + `"${"$"}{python:-missing}" "${"$"}{gdb:-missing}" "$gdb_python" "$writable" `
    + `"$([ -x ${dumpPath} ] && echo ${dumpPath} || echo missing)"`,
  ];
}

export interface PyheapPrereqs {
  python3: boolean;
  gdb: boolean;
  gdbPython: boolean;
  writable: boolean;
  dumper: boolean;
}

export function parsePyheapPrereqs(output: string): PyheapPrereqs | undefined {
  const entries = new Map(
    output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.includes("="))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)] as const;
      }),
  );
  const python3 = entries.get("python3");
  const gdb = entries.get("gdb");
  const gdbPython = entries.get("gdb_python");
  const writable = entries.get("writable");
  const dumper = entries.get("pyheap");
  if (
    python3 === undefined
    || gdb === undefined
    || gdbPython === undefined
    || writable === undefined
    || dumper === undefined
  ) return undefined;
  return {
    python3: python3 !== "missing" && python3 !== "",
    gdb: gdb !== "missing" && gdb !== "",
    gdbPython: gdbPython === "yes",
    writable: writable === "yes",
    dumper: dumper !== "missing" && dumper !== "",
  };
}

/** PyHeap executes graph traversal inside the target interpreter while holding the GIL. */
export function runPyheapDumpCmd(
  pid: number,
  heapFile: string,
  strReprLen: number,
  noAttribute = false,
  dumpPath = PYHEAP_DUMP_PATH,
): string[] {
  return [
    "sh",
    "-c",
    `mkdir -p ${PYHEAP_TOOL_DIR} && PEX_ROOT=${PYHEAP_TOOL_DIR}/pex TMPDIR=${PYHEAP_TOOL_DIR} `
    + `python3 ${dumpPath} --pid ${pid} --file ${heapFile} --str-repr-len ${strReprLen}`
    + (noAttribute ? " --no-attribute" : ""),
  ];
}

export function cleanupPyheapCmd(): string[] {
  return ["sh", "-c", `rm -rf ${PYHEAP_TOOL_DIR}`];
}
