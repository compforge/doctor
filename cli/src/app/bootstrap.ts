import { homedir } from "node:os";
import { join } from "node:path";

import {
  Agent as LocalAgent,
  type AgentSource,
  type LlmConfig,
} from "@compforge/doctor-agent";
import type { PluginDefinition } from "@compforge/doctor-plugin";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";

import { ServerAgent, createDoctorModel, type DoctorModel } from "../chat";
import { DoctorClient } from "../protocol";
import type { CliFlags } from "../protocol";
import {
  loadConfig,
  profileToUpload,
  resolveProfile,
  validateProfile,
} from "./config/config";
import type { Profile } from "./config/model";
import { loadState, resolveResumeTarget } from "./config/state";

export interface BootstrapResult {
  agent: AgentSource;
  model: DoctorModel;
}

export async function bootstrap(
  flags: CliFlags,
  plugin?: PluginDefinition,
): Promise<BootstrapResult> {
  const home = homedir();
  const configPath = flags.config ?? process.env.DOCTOR_CONFIG ?? join(home, ".doctor", "config.yaml");
  const statePath = join(home, ".doctor", "state.yaml");
  const config = loadConfig(configPath);
  const state = loadState(statePath);

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
  if (!profile) throw new Error(`profile '${profileName}' not found in config`);

  const validation = validateProfile(profile);
  if (validation.errors.length) throw new Error(validation.errors.join("\n"));

  // Endpoint 配置只描述可用能力，不隐式改变执行位置；普通 chat 始终默认本地。
  // --server 与 --resume 都是显式远端意图，长期可继续复用同一 AgentUE 交互面。
  if (flags.server || resumeConversationId) {
    if (!profile.server) {
      throw new Error(`profile '${profileName}' 未配置 server`);
    }
    const client = new DoctorClient(profile.server);
    if (!(await client.healthz())) {
      throw new Error(`server ${profile.server} 不可达，请检查 VPN / profile.server`);
    }
    const connectionId = await client.createConnection(profileToUpload(profile));
    return {
      agent: new ServerAgent({
        client,
        connectionId,
        conversationId: resumeConversationId,
        profileName,
        profile,
        state,
        statePath,
        verbose: flags.verbose,
      }),
      model: createDoctorModel({
        profileName,
        profile,
        mode: "server",
        warnings: validation.warnings,
        connectionId,
        conversationId: resumeConversationId,
      }),
    };
  }

  const agent = new LocalAgent({
    llm: resolveLocalLlm(profile),
    env: new NodeExecutionEnv({ cwd: process.cwd() }),
    skills: plugin?.skills ?? [],
    verbose: flags.verbose,
  });
  return {
    agent,
    model: createDoctorModel({
      profileName,
      profile,
      mode: "local",
      warnings: validation.warnings,
    }),
  };
}

function resolveLocalLlm(profile: Profile): LlmConfig {
  const llm = profile.llm;
  if (!llm) throw new Error("本地问答需要完整的 llm.provider/api_key/model 配置");
  const missing = ["provider", "api_key", "model"].filter(
    (key) => !llm[key as keyof typeof llm],
  );
  if (missing.length) {
    throw new Error(`本地问答需要完整的 llm.${missing.join("/")} 配置`);
  }
  if (llm.provider !== "openai" && llm.provider !== "deepseek") {
    throw new Error(`本地问答暂不支持 llm.provider=${llm.provider}（支持 openai、deepseek）`);
  }
  return {
    provider: llm.provider,
    apiKey: llm.api_key!,
    model: llm.model!,
    ...(llm.endpoint ? { endpoint: llm.endpoint } : {}),
    ...(llm.thinking !== undefined ? { thinking: llm.thinking } : {}),
  };
}
