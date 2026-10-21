// A plugin's settings: device values kept by the device (plugins.settings),
// account values kept by the account (the Worker, which sends them to every
// device). Secrets come back only as whether they're set and how they end.

import type { PluginInfo, PluginSetting, PluginSettingView } from "@everywhere/protocol";
import { api } from "@/lib/api";
import type { DevicePeer } from "@/lib/peer";

export const isAccount = (s: PluginSetting) => s.scope === "account";

/** Every setting's value view, from where each is kept. */
export async function pluginSettings(peer: DevicePeer, plugin: PluginInfo): Promise<Record<string, PluginSettingView>> {
  const settings = plugin.settings ?? [];
  if (settings.length === 0) return {};
  const [device, account] = await Promise.all([
    settings.some((s) => !isAccount(s))
      ? (peer.callPlugin("plugins.settings", { id: plugin.id }) as Promise<{ values: Record<string, PluginSettingView> }>).then((r) => r.values)
      : Promise.resolve({} as Record<string, PluginSettingView>),
    settings.some(isAccount) ? api.pluginSettings(plugin.id) : Promise.resolve({} as Record<string, PluginSettingView>),
  ]);
  const out: Record<string, PluginSettingView> = {};
  for (const s of settings) {
    out[s.key] = (isAccount(s) ? account[s.key] : device[s.key]) ?? { value: s.default, set: false };
  }
  return out;
}

/** Saves changed values (null clears one), each where it's kept. */
export async function setPluginSettings(peer: DevicePeer, plugin: PluginInfo, values: unknown): Promise<void> {
  if (!values || typeof values !== "object") throw new Error("give values");
  const byKey = new Map((plugin.settings ?? []).map((s) => [s.key, s]));
  const device: Record<string, unknown> = {};
  const account: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values as Record<string, unknown>)) {
    const s = byKey.get(k);
    if (!s) throw new Error(`${plugin.id} has no setting ${k}`);
    (isAccount(s) ? account : device)[k] = v;
  }
  if (Object.keys(device).length > 0) await peer.callPlugin("plugins.setSettings", { id: plugin.id, values: device });
  if (Object.keys(account).length > 0) {
    const secrets = (plugin.settings ?? []).filter((s) => isAccount(s) && s.type === "secret").map((s) => s.key);
    await api.setPluginSettings(plugin.id, account, secrets);
  }
}
