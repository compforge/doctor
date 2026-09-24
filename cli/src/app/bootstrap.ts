import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  Agent as LocalAgent,
  type AgentSource,
  type LlmConfig,
} from "@compforge/doctor-agent";
import type { Model, PluginDefinition } from "@compforge/doctor-plugin";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";

import {
  ServerAgent,
  createDoctorModel,
  createModelInferenceFetch,
  type DoctorModel,
} from "../chat";
import type { CommandContext } from "../command";
import {
  openModelAccess,
  requireInferenceModel,
  resolveModelTenant,
  selectModel,
  type SelectedInferenceModel,
} from "../model";

import { useLogger } from "../terminal/log";
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
import { prepareAgentCommands } from "./agent-commands";
import type { DistributionManifest } from "./distribution";
import { loadState, resolveResumeTarget } from "./config/state";

export interface BootstrapResult {
  agent: AgentSource;
  model: DoctorModel;
}

export interface LocalAgentContext {
  contextPrompt: string;
  shellEnv: Record<string, string>;
}

interface LocalModel {
  llm: LlmConfig;
  label: string;
  dispose?: () => Promise<void>;
}

export async function bootstrap(
  flags: CliFlags,
  plugin?: PluginDefinition,
  commandContext?: CommandContext,
  agentCommands?: Readonly<Record<string, DistributionManifest>>,
): Promise<BootstrapResult> {
  const home = homedir();
  const configPath = flags.config ?? process.env.DOCTOR_CONFIG ?? join(home, ".doctor", "config.yaml");
  if (configPath === "") throw new Error('chat requires profile configuration; --config="" disables it');
  const statePath = join(home, ".doctor", "state.yaml");
  const state = loadState(statePath);

  if (flags.profile && flags.resume !== undefined) {
    throw new Error("--profile and --resume are mutually exclusive (--resume already implies a profile)");
  }

  let profileName: string | undefined;
  let resumeConversationId: string | undefined;
  if (flags.resume !== undefined) {
    const target = resolveResumeTarget(state, flags.resume);
    profileName = target.profile;
    resumeConversationId = target.conversationId;
  } else {
    profileName = commandContext?.profile.name;
  }

  let profile = commandContext?.profile.value;
  if (!profile) {
    const resolved = resolveProfile(loadConfig(configPath), profileName ?? flags.profile);
    profileName = resolved.name;
    profile = resolved.profile;
  }
  if (!profileName) throw new Error("failed to resolve the working profile");

  // Apply this invocation's target before validation or upload; never mutate the saved profile.
  const environment = commandContext?.options.environment;
  profile = effectiveAgentProfile(profile, environment);
  if (flags.namespace) {
    profile = { ...profile, namespace: flags.namespace };
  }

  const remote = !!(flags.server || resumeConversationId);
  if (remote && environment?.context !== undefined) {
    throw new Error("远端 chat 暂不支持 --context；请使用 current-context 已选定的 --kubeconfig 文件");
  }
  const validation = validateProfile(profile, { requireServerLlm: remote });
  if (validation.errors.length) throw new Error(validation.errors.join("\n"));

  // Endpoint 配置只描述可用能力，不隐式改变执行位置；普通 chat 始终默认本地。
  // --server 与 --resume 都是显式远端意图，长期可继续复用同一 AgentUE 交互面。
  if (remote) {
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

  const localModel = await resolveLocalModel(flags, profileName, profile, plugin, commandContext);
  try {
    const localContext = await prepareLocalAgentContext(profileName, profile, plugin, environment?.context);
    const commandEnv = prepareAgentCommands(agentCommands ?? {}, plugin, {
      profileName, configPath: resolve(configPath),
      kubeconfig: profile.kube?.kubeconfig_path ? expandHome(profile.kube.kubeconfig_path) : undefined,
      context: environment?.context,
      namespace: profile.namespace,
    });
    try {
      const agent = new LocalAgent({
        llm: localModel.llm,
        env: new NodeExecutionEnv({ cwd: process.cwd(), shellEnv: { ...localContext.shellEnv, ...commandEnv.shellEnv } }),
        skills: plugin?.skills ?? [],
        contextPrompt: localContext.contextPrompt,
      });
      return {
        agent: withDispose(agent, async () => {
          try { await localModel.dispose?.(); }
          finally { commandEnv.dispose(); }
        }),
        model: createDoctorModel({
          profileName,
          profile,
          mode: "local",
          model: localModel.label,
          warnings: validation.warnings,
        }),
      };
    } catch (error) {
      commandEnv.dispose();
      throw error;
    }
  } catch (error) {
    await localModel.dispose?.();
    throw error;
  }
}

export function effectiveAgentProfile(profile: Profile, environment?: { kubeconfig?: string }): Profile {
  if (environment?.kubeconfig === undefined) return profile;
  if (!environment.kubeconfig.trim()) throw new Error("--kubeconfig 不能为空");
  return { ...profile, kube: { ...profile.kube, kubeconfig_path: environment.kubeconfig } };
}

/** Expose the selected profile's target as the Chat default; each tool call may choose another target. */
export function createLocalAgentContext(profileName: string, profile: Profile, context?: string): LocalAgentContext {
  if (context !== undefined && !context.trim()) throw new Error("--context 不能为空");
  const kubeconfig = profile.kube?.kubeconfig_path
    ? expandHome(profile.kube.kubeconfig_path)
    : undefined;
  const shellEnv: Record<string, string> = {
    TARGET_ENV: profileName,
    TARGET_ACCESS_MODE: "remote",
    TARGET_READONLY: String(profile.readonly),
    ...(kubeconfig ? { TARGET_KUBECONFIG: kubeconfig } : {}),
    ...(context !== undefined ? { TARGET_KUBE_CONTEXT: context } : {}),
    ...(profile.namespace ? { TARGET_NAMESPACE: profile.namespace } : {}),
  };
  const target = [
    `profile=${JSON.stringify(profileName)}`,
    kubeconfig ? `kubeconfig=${JSON.stringify(kubeconfig)}` : undefined,
    context !== undefined ? `context=${JSON.stringify(context)}` : undefined,
    profile.namespace ? `namespace=${JSON.stringify(profile.namespace)}` : undefined,
    `readonly=${profile.readonly}`,
  ].filter(Boolean).join(", ");
  const contextPrompt = [
    `The Doctor host selected the default infrastructure target for this chat (${target}).`,
    "The profile stays fixed for this conversation. Skill scripts can use the injected default "
      + "TARGET_ENV, TARGET_KUBECONFIG, TARGET_KUBE_CONTEXT, TARGET_NAMESPACE, TARGET_READONLY, and TARGET_ACCESS_MODE variables. "
      + "When using the default target, pass TARGET_KUBECONFIG and TARGET_KUBE_CONTEXT as --kubeconfig and --context when set.",
    "Use the selected target when the user has not requested another environment. "
      + "For another environment in this conversation, pass its explicit target options to each tool command; "
      + "do not switch the Chat profile. When no kubeconfig is selected, Doctor commands use KUBECONFIG or ~/.kube/config.",
  ].join("\n");
  return { contextPrompt, shellEnv };
}

/** Let the selected Plugin add access facts without allowing it to retarget the active profile. */
export async function prepareLocalAgentContext(
  profileName: string,
  profile: Profile,
  plugin?: PluginDefinition,
  context?: string,
): Promise<LocalAgentContext> {
  const profileContext = createLocalAgentContext(profileName, profile, context);
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

function resolveConfiguredLlm(profile: Profile): LlmConfig {
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

async function resolveLocalModel(
  flags: CliFlags,
  profileName: string,
  profile: Profile,
  plugin?: PluginDefinition,
  commandContext?: CommandContext,
): Promise<LocalModel> {
  if (profile.llm) {
    const llm = resolveConfiguredLlm(profile);
    return { llm, label: `${llm.provider}/${llm.model}` };
  }
  if (!plugin) {
    throw new Error(
      "本地问答未配置 llm，且 Doctor Host 未加载提供模型目录与 inference 能力的 Plugin",
    );
  }
  const access = await openModelAccess({
    command: "doctor chat",
    plugin,
    commandContext,
    profile: profileName,
    config: flags.config,
  });
  if (!access) throw new Error("已取消 Doctor chat 模型选择");
  try {
    const tenant = await resolveModelTenant({
      directory: access.directory,
      profileName,
      commandContext,
      promptTitle: "[chat] 当前启用租户：",
    });
    if (!tenant) throw new Error("已取消租户选择");
    useLogger("chat").info(`tenant: ${tenant.name}（${tenant.id}）`);
    const model = await selectChatModel(
      await access.catalog.query({
        identity: { kind: "tenant_id", value: tenant.id },
        constraints: { type: "llm" },
      }),
      undefined,
      { profileName, tenantId: tenant.id },
    );
    if (!model) throw new Error("已取消模型选择");
    const inference = await access.createInference(model.inference, 60_000);
    useLogger("chat").info(`model: ${model.name}（provider=${model.provider}, id=${model.id}）`);
    return {
      llm: {
        provider: "openai",
        apiKey: "doctor-plugin-inference",
        model: model.inference.model,
        endpoint: model.inference.baseUrl,
        fetch: createModelInferenceFetch(inference),
      },
      label: `${model.provider}/${model.name}`,
      dispose: access.dispose,
    };
  } catch (error) {
    await access.dispose();
    throw error;
  }
}

export async function selectChatModel(
  models: readonly Model[],
  prompt?: (models: readonly Model[]) => Promise<Model | undefined>,
  recentScope?: { profileName: string; tenantId: string },
): Promise<SelectedInferenceModel | undefined> {
  const selected = await selectModel({
    models: models.filter((model) => model.type === "llm"),
    ...recentScope,
    ...(prompt ? { interactive: true, prompt } : {}),
  });
  if (!selected) return undefined;
  const model = requireInferenceModel(selected);
  if (model.type !== "llm") throw new Error(`模型 '${model.name}' 不是 chat 可用的 LLM`);
  return model;
}

function withDispose(agent: AgentSource, dispose: () => Promise<void>): AgentSource {
  return {
    run: (text, context) => agent.run(text, context),
    abort: () => agent.abort(),
    dispose: async () => {
      try {
        await agent.dispose();
      } finally {
        await dispose();
      }
    },
  };
}
