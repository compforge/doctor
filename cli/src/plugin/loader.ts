import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { PluginDefinition, PluginSkill } from "@compforge/doctor-plugin";
import { parse as parseYaml } from "yaml";
import { parsePluginManifest, parsePluginRef, type PluginManifest } from "./manifest";

export function pluginInstallRoot(): string {
  return join(homedir(), ".doctor", "plugins");
}

export function installedPluginPath(ref: string, root = pluginInstallRoot()): string {
  const { id, version } = parsePluginRef(ref);
  return join(root, id, version);
}

export function readInstalledManifest(root: string): PluginManifest {
  const path = join(root, "plugin.json");
  if (!existsSync(path)) throw new Error(`Installed Plugin has no manifest: ${path}`);
  return parsePluginManifest(readFileSync(path, "utf8"));
}

function loadSkill(root: string, path: string): PluginSkill {
  const filePath = resolve(root, path, "SKILL.md");
  if (!existsSync(filePath)) throw new Error(`Plugin Skill has no SKILL.md: ${path}`);
  const content = readFileSync(filePath, "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) throw new Error(`Plugin Skill has no YAML frontmatter: ${path}`);
  const metadata = parseYaml(match[1]!) as { name?: unknown; description?: unknown };
  if (typeof metadata?.name !== "string" || typeof metadata.description !== "string") {
    throw new Error(`Plugin Skill frontmatter requires name and description: ${path}`);
  }
  return { name: metadata.name, description: metadata.description, content, filePath };
}

export async function loadPluginDirectory(root: string, ref?: string): Promise<PluginDefinition> {
  const manifest = readInstalledManifest(root);
  if (ref) {
    const expected = parsePluginRef(ref);
    if (manifest.id !== expected.id || manifest.version !== expected.version) {
      throw new Error(`Installed Plugin identity does not match ${ref}`);
    }
  }
  const main = resolve(root, manifest.main);
  if (!existsSync(main)) throw new Error(`Installed Plugin entry is missing: ${manifest.main}`);
  const module = await import(`${pathToFileURL(main).href}?v=${manifest.contentDigest}`) as { default?: unknown };
  const definition = module.default as Partial<PluginDefinition> | undefined;
  if (
    !definition
    || definition.id !== manifest.id
    || definition.version !== manifest.version
    || typeof definition.services !== "object"
    || definition.services === null
    || typeof definition.services.servicesWith !== "function"
  ) {
    throw new Error(`Plugin entry does not export a matching PluginDefinition: ${manifest.id}@${manifest.version}`);
  }
  const skills = manifest.skills.map((path) => loadSkill(root, path));
  const names = new Set<string>();
  for (const skill of skills) {
    if (names.has(skill.name)) throw new Error(`Plugin has duplicate Skill name: ${skill.name}`);
    names.add(skill.name);
  }
  return { ...definition, id: manifest.id, version: manifest.version, skills } as PluginDefinition;
}

export async function loadInstalledPlugin(ref: string, installRoot = pluginInstallRoot()): Promise<PluginDefinition> {
  return loadPluginDirectory(installedPluginPath(ref, installRoot), ref);
}

export function readActivePluginRef(installRoot = pluginInstallRoot()): string | undefined {
  const path = join(installRoot, "active.json");
  if (!existsSync(path)) return undefined;
  const state = JSON.parse(readFileSync(path, "utf8")) as { schemaVersion?: unknown; ref?: unknown };
  if (state.schemaVersion !== 1 || typeof state.ref !== "string") {
    throw new Error(`Invalid Plugin active state: ${path}`);
  }
  parsePluginRef(state.ref);
  return state.ref;
}

export async function loadActivePlugin(
  installRoot = pluginInstallRoot(),
): Promise<PluginDefinition | undefined> {
  const ref = readActivePluginRef(installRoot);
  return ref ? loadInstalledPlugin(ref, installRoot) : undefined;
}
