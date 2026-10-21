import type { PluginInfo, PluginSetting, PluginSettingView } from "@everywhere/protocol";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { DevicePeer } from "@/lib/peer";
import { cn, errorMessage } from "@/lib/utils";
import { isAccount, pluginSettings, setPluginSettings } from "@/plugins/settings";

/**
 * A plugin's settings as a form, drawn from its plugin.json: device ones
 * are saved on the device, account ones by the account (for every device).
 */
export function PluginSettingsForm({ peer, plugin }: { peer: DevicePeer; plugin: PluginInfo }) {
  const settings = plugin.settings ?? [];
  const [views, setViews] = useState<Record<string, PluginSettingView> | null>(null);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [status, setStatus] = useState<{ error?: string; saved?: boolean }>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    pluginSettings(peer, plugin)
      .then((v) => live && setViews(v))
      .catch((e: unknown) => live && setStatus({ error: errorMessage(e) }));
    return () => {
      live = false;
    };
  }, [peer, plugin]);

  if (status.error && !views) return <p className="text-xs text-destructive">{status.error}</p>;
  if (!views) return <p className="text-xs text-muted-foreground">Loading settings…</p>;

  const changed = Object.keys(draft).length > 0;
  const save = async () => {
    setSaving(true);
    setStatus({});
    try {
      await setPluginSettings(peer, plugin, draft);
      setViews(await pluginSettings(peer, plugin));
      setDraft({});
      setStatus({ saved: true });
    } catch (e) {
      setStatus({ error: errorMessage(e) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {settings.map((s) => (
        <Field
          key={s.key}
          setting={s}
          view={views[s.key] ?? { set: false, value: s.default }}
          value={s.key in draft ? draft[s.key] : undefined}
          onChange={(v) => {
            setStatus({});
            setDraft((d) => {
              const next = { ...d };
              if (v === undefined) delete next[s.key];
              else next[s.key] = v;
              return next;
            });
          }}
        />
      ))}
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={!changed || saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
        {status.saved && !changed && <span className="text-xs text-muted-foreground">Saved.</span>}
        {status.error && <span className="text-xs text-destructive">{status.error}</span>}
      </div>
    </form>
  );
}

function Field({
  setting: s,
  view,
  value,
  onChange,
}: {
  setting: PluginSetting;
  view: PluginSettingView;
  /** The edited value, if it was edited. */
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const id = `setting-${s.key}`;
  const current = value !== undefined ? value : view.value;
  const label = (
    <span className="flex items-baseline gap-2">
      <label htmlFor={id} className="text-sm">
        {s.title}
      </label>
      {isAccount(s) && <span className="text-[10px] text-muted-foreground">all devices</span>}
    </span>
  );
  const hint = s.description && <p className="text-xs text-muted-foreground">{s.description}</p>;

  if (s.type === "boolean") {
    return (
      <div className="grid gap-0.5">
        <span className="flex items-center gap-2">
          <input id={id} type="checkbox" checked={current === true} onChange={(e) => onChange(e.target.checked)} />
          {label}
        </span>
        {hint}
      </div>
    );
  }
  const control =
    s.type === "select" ? (
      <select
        id={id}
        value={typeof current === "string" ? current : ""}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 rounded-md border bg-background px-2 text-sm"
      >
        {!view.set && current === undefined && <option value="">Choose…</option>}
        {(s.options ?? []).map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    ) : s.type === "text" ? (
      <textarea
        id={id}
        value={typeof current === "string" ? current : ""}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        className="rounded-md border bg-background px-2 py-1.5 font-mono text-xs"
      />
    ) : s.type === "secret" ? (
      <span className="flex items-center gap-2">
        <Input
          id={id}
          type="password"
          autoComplete="off"
          value={typeof value === "string" ? value : ""}
          placeholder={view.set ? `Set${view.hint ? ` (…${view.hint})` : ""}; type to replace it` : "Not set"}
          onChange={(e) => onChange(e.target.value || undefined)}
        />
        {view.set && value === undefined && (
          <Button type="button" variant="ghost" size="sm" onClick={() => onChange(null)}>
            Clear
          </Button>
        )}
        {value === null && <span className="text-xs text-muted-foreground">Cleared when saved</span>}
      </span>
    ) : (
      <Input
        id={id}
        type={s.type === "number" ? "number" : "text"}
        value={current === undefined || current === null ? "" : String(current)}
        onChange={(e) => {
          const raw = e.target.value;
          if (s.type !== "number") return onChange(raw);
          onChange(raw === "" ? null : Number(raw));
        }}
      />
    );
  return (
    <div className={cn("grid gap-1")}>
      {label}
      {control}
      {hint}
    </div>
  );
}
