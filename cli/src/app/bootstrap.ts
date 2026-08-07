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
  expandHome,
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

export interface LocalAgentContext {
  contextPrompt: string;
  shellEnv: Record<string, string>;
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

  const localContext = await prepareLocalAgentContext(profileName, profile, plugin);
  const agent = new LocalAgent({
    llm: resolveLocalLlm(profile),
    env: new NodeExecutionEnv({ cwd: process.cwd(), shellEnv: localContext.shellEnv }),
    skills: plugin?.skills ?? [],
    contextPrompt: localContext.contextPrompt,
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

/** Bind local Skill execution to the infrastructure target already selected by the profile. */
export function createLocalAgentContext(profileName: string, profile: Profile): LocalAgentContext {
  const kubeconfig = profile.kube?.kubeconfig_path
    ? expandHome(profile.kube.kubeconfig_path)
    : undefined;
  const shellEnv: Record<string, string> = {
    TARGET_ENV: profileName,
    TARGET_ACCESS_MODE: "remote",
    TARGET_READONLY: String(profile.readonly),
    ...(kubeconfig ? { TARGET_KUBECONFIG: kubeconfig } : {}),
    ...(profile.namespace ? { TARGET_NAMESPACE: profile.namespace } : {}),
  };
  const target = [
    `profile=${JSON.stringify(profileName)}`,
    kubeconfig ? `kubeconfig=${JSON.stringify(kubeconfig)}` : undefined,
    profile.namespace ? `namespace=${JSON.stringify(profile.namespace)}` : undefined,
    `readonly=${profile.readonly}`,
  ].filter(Boolean).join(", ");
  const contextPrompt = [
    `The Doctor host has already bound this session to one infrastructure target (${target}).`,
    "The profile name is the selected environment identifier. Skill scripts can use the injected "
      + "TARGET_ENV, TARGET_KUBECONFIG, TARGET_NAMESPACE, TARGET_READONLY, and TARGET_ACCESS_MODE variables.",
    "Do not ask the user to choose an environment merely because a Skill contains a multi-environment catalog. "
      + "Use the active profile context; if the user requests another environment, ask them to switch Doctor profile.",
  ].join("\n");
  return { contextPrompt, shellEnv };
}

/** Let the selected Plugin add access facts without allowing it to retarget the active profile. */
export async function prepareLocalAgentContext(
  profileName: string,
  profile: Profile,
  plugin?: PluginDefinition,
): Promise<LocalAgentContext> {
  const profileContext = createLocalAgentContext(profileName, profile);
  const prepared = await plugin?.prepareSkillContext?.({
    env: profileName,
    namespace: profile.namespace,
    readonly: profile.readonly,
  });
  return {
    // Profile-owned target keys win so a Plugin cannot silently cross the selected boundary.
    shellEnv: { ...prepared?.env, ...profileContext.shellEnv },
    contextPrompt: [profileContext.contextPrompt, prepared?.contextPrompt]
      .filter(Boolean)
      .join("\n"),
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
