const SYS_PTRACE_BIT = 19;

const PTRACE_FACTS_SCRIPT = String.raw`
import json
import os
import sys

pid = sys.argv[1]

def read_status(path):
    with open(path, encoding="utf-8", errors="replace") as file:
        return {
            key.rstrip(":"): value.strip()
            for line in file
            if ":" in line
            for key, value in [line.split(":", 1)]
        }

self_status = read_status("/proc/self/status")
target_status = read_status(f"/proc/{pid}/status")
cap_eff = int(self_status.get("CapEff", "0"), 16)
try:
    with open("/proc/sys/kernel/yama/ptrace_scope", encoding="utf-8") as file:
        ptrace_scope = int(file.read().strip())
except (FileNotFoundError, PermissionError, ValueError):
    ptrace_scope = None

caller_uid = os.getuid()
target_uids = target_status.get("Uid", "").split()
target_uid = int(target_uids[0]) if target_uids else None
print(json.dumps({
    "cap_eff_hex": self_status.get("CapEff", "0"),
    "sys_ptrace_effective": bool(cap_eff & (1 << ${SYS_PTRACE_BIT})),
    "ptrace_scope": ptrace_scope,
    "caller_uid": caller_uid,
    "target_uid": target_uid,
    "same_uid": target_uid == caller_uid if target_uid is not None else None,
    "seccomp_mode": int(self_status.get("Seccomp", "0")),
    "no_new_privs": self_status.get("NoNewPrivs", "0") == "1",
}))
`;

interface PtraceFactsWire {
  cap_eff_hex?: string;
  sys_ptrace_effective?: boolean;
  ptrace_scope?: number | null;
  caller_uid?: number;
  target_uid?: number | null;
  same_uid?: boolean | null;
  seccomp_mode?: number;
  no_new_privs?: boolean;
}

export interface PtraceFacts {
  sysPtraceDeclared: boolean;
  sysPtraceEffective: boolean;
  capEffHex?: string;
  ptraceScope?: number;
  callerUid?: number;
  targetUid?: number;
  sameUid?: boolean;
  seccompMode?: number;
  noNewPrivs: boolean;
  attachLikely: boolean;
  reason: string;
}

export function ptraceFactsCmd(pid: number): string[] {
  return ["python3", "-c", PTRACE_FACTS_SCRIPT, String(pid)];
}

export function podDeclaresSysPtrace(raw: string, containerName: string): boolean {
  const pod = JSON.parse(raw) as any;
  const containers = [
    ...(pod.spec?.containers ?? []),
    ...(pod.spec?.ephemeralContainers ?? []),
  ];
  const container = containers.find((item: any) => item.name === containerName);
  return (container?.securityContext?.capabilities?.add ?? [])
    .some((capability: unknown) => String(capability).toUpperCase() === "SYS_PTRACE");
}

export function parsePtraceFacts(raw: string, sysPtraceDeclared: boolean): PtraceFacts {
  const value = JSON.parse(raw) as PtraceFactsWire;
  const ptraceScope = Number.isInteger(value.ptrace_scope) ? value.ptrace_scope! : undefined;
  const sysPtraceEffective = value.sys_ptrace_effective === true;
  const sameUid = typeof value.same_uid === "boolean" ? value.same_uid : undefined;
  let attachLikely = false;
  let reason: string;

  if (ptraceScope === 3) {
    reason = "kernel ptrace_scope=3 禁止 attach";
  } else if (sysPtraceEffective) {
    attachLikely = true;
    reason = "当前执行进程具有有效 CAP_SYS_PTRACE";
  } else if (ptraceScope === 0 && sameUid) {
    attachLikely = true;
    reason = "ptrace_scope=0 且调用进程与目标进程 UID 相同";
  } else if (ptraceScope === undefined) {
    reason = "无法确认 ptrace_scope，且当前执行进程没有有效 CAP_SYS_PTRACE";
  } else if (!sameUid) {
    reason = `调用进程与目标进程 UID 不同，且缺少有效 CAP_SYS_PTRACE（ptrace_scope=${ptraceScope}）`;
  } else {
    reason = `ptrace_scope=${ptraceScope} 限制 attach，且当前执行进程没有有效 CAP_SYS_PTRACE`;
  }

  return {
    sysPtraceDeclared,
    sysPtraceEffective,
    capEffHex: value.cap_eff_hex?.trim() || undefined,
    ptraceScope,
    callerUid: Number.isInteger(value.caller_uid) ? value.caller_uid : undefined,
    targetUid: Number.isInteger(value.target_uid) ? value.target_uid! : undefined,
    sameUid,
    seccompMode: Number.isInteger(value.seccomp_mode) ? value.seccomp_mode : undefined,
    noNewPrivs: value.no_new_privs === true,
    attachLikely,
    reason,
  };
}
