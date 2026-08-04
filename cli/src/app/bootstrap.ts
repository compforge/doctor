import { homedir } from "node:os";
import { join } from "node:path";
import {
  loadConfig,
  resolveProfile,
  validateProfile,
  profileToUpload,
} from "./config/config";
import { loadState, resolveResumeTarget } from "./config/state";
import { DoctorClient } from "../protocol";
import type { CliFlags, State } from "../protocol";

export interface BootstrapResult {
  client: DoctorClient;
  connectionId: string;
  profileName: string;
  resumeConversationId?: string;
  state: State;
  statePath: string;
  warnings: string[];
}

export async function bootstrap(flags: CliFlags): Promise<BootstrapResult> {
  const home = homedir();
  const configPath = flags.config ?? process.env.DOCTOR_CONFIG ?? join(home, ".doctor", "config.yaml");
  const statePath = join(home, ".doctor", "state.yaml");

  const config = loadConfig(configPath);
  const state = loadState(statePath);

  // --profile X --resume[=...] is mutually exclusive.
  if (flags.profile && flags.resume !== undefined) {
    throw new Error("--profile and --resume are mutually exclusive (--resume already implies a profile)");
  }

  let profileName: string;
  let resumeConversationId: string | undefined;

  if (flags.resume !== undefined) {
    const target = resolveResumeTarget(state, flags.resume);
    profileName = target.profile;
    resumeConversationId = target.conversationId;
  } else {
    profileName = resolveProfile(config, flags.profile).name;
  }

  const profile = config.profiles[profileName];
  if (!profile) {
    throw new Error(`profile '${profileName}' not found in config`);
  }

  const validation = validateProfile(profile);
  if (validation.errors.length) {
    throw new Error(validation.errors.join("\n"));
  }

  // 未配 server = 本地 profile。本地 agent loop（llm 直连 + kubectl 渠道）尚未实现，
  // 交互问诊目前只有 server 一条路；采集类排查走 doctor cpu / doctor mem / doctor trace（不需要 server）。
  if (!profile.server) {
    throw new Error(
      `profile '${profileName}' 未配置 server（本地模式）：交互问诊需要 doctor-server；` +
        `无 server 的采集排查请用 doctor cpu / doctor mem / doctor trace`,
    );
  }

  const client = new DoctorClient(profile.server);

  if (!(await client.healthz())) {
    throw new Error(`server ${profile.server} 不可达，请检查 VPN / profile.server`);
  }

  const upload = profileToUpload(profile);
  const connectionId = await client.createConnection(upload);

  return {
    client,
    connectionId,
    profileName,
    resumeConversationId,
    state,
    statePath,
    warnings: validation.warnings,
  };
}
