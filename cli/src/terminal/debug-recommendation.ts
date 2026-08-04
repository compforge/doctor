export interface DoctorDebugCommandInput {
  profileName: string;
  namespace: string;
  services?: readonly string[];
  pod?: string;
  container?: string;
  kubeconfig?: string;
  context?: string;
  config?: string;
}

function quoteCommandArg(value: string): string {
  if (/^[\w./:@,+=-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** Render the already selected Kubernetes scope as a copy-pastable debug preparation command. */
export function formatDoctorDebugCommand(input: DoctorDebugCommandInput): string {
  const args = [
    "mono-doctor", "doctor", "debug",
    "--profile", input.profileName,
    "-n", input.namespace,
  ];
  if (input.services?.length) args.push("--services", input.services.join(","));
  else if (input.pod) args.push("-p", input.pod);
  if (input.container) args.push("-c", input.container);
  if (input.kubeconfig) args.push("--kubeconfig", input.kubeconfig);
  if (input.context) args.push("--context", input.context);
  if (input.config) args.push("--config", input.config);
  return args.map(quoteCommandArg).join(" ");
}
