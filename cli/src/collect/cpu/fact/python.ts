export interface CpuPythonFacts {
  pySpyPath?: string;
}

interface CpuPythonFactsWire {
  py_spy_path?: string | null;
}

const CPU_PYTHON_FACTS_SCRIPT = String.raw`
import json
import shutil

print(json.dumps({
    "py_spy_path": shutil.which("py-spy"),
}))
`;

export function cpuPythonFactsCmd(): string[] {
  return ["python3", "-c", CPU_PYTHON_FACTS_SCRIPT];
}

export function parseCpuPythonFacts(raw: string): CpuPythonFacts | undefined {
  if (!raw.trim()) return undefined;
  const value = JSON.parse(raw) as CpuPythonFactsWire;
  return {
    pySpyPath: value.py_spy_path?.trim() || undefined,
  };
}
