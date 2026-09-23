import { createFileRoute } from "@tanstack/react-router";
import { MoreHorizontalIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { AddDeviceButton } from "@/components/add-device-dialog";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { PresenceDot } from "@/components/presence-dot";
import { RenameDialog } from "@/components/rename-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { api, type Device } from "@/lib/api";
import { devices as devicesStore, useDevices } from "@/lib/devices";
import { useHub } from "@/lib/hub";
import { timeAgo } from "@/lib/utils";

export const Route = createFileRoute("/_app/settings/devices")({
  component: DeviceSettings,
});

function DeviceSettings() {
  const { devices, error } = useDevices();
  const { online, presenceKnown } = useHub();
  const [renaming, setRenaming] = useState<Device | null>(null);
  const [removing, setRemoving] = useState<Device | null>(null);

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6">
      <div className="mb-4 flex items-end gap-3">
        <div>
          <h1 className="text-base font-semibold tracking-tight">Device settings</h1>
          <p className="text-xs text-muted-foreground">Enroll new machines, rename them, or revoke their access.</p>
        </div>
        <div className="ml-auto">
          <AddDeviceButton />
        </div>
      </div>

      {error && !devices && <p className="text-destructive">Couldn't load devices: {error}</p>}

      {devices?.length === 0 && (
        <p className="rounded-lg border border-dashed px-4 py-8 text-center text-muted-foreground">
          No devices enrolled.
        </p>
      )}

      {devices && devices.length > 0 && (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <table className="w-full text-left">
            <thead className="border-b text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Hostname</th>
                <th className="px-3 py-2 font-medium">Platform</th>
                <th className="px-3 py-2 font-medium">Version</th>
                <th className="px-3 py-2 font-medium">Added</th>
                <th className="px-3 py-2 font-medium">Last seen</th>
                <th className="w-10 px-2 py-2">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {devices.map((d) => {
                const isOnline = presenceKnown ? online.has(d.id) : undefined;
                return (
                  <tr key={d.id} className="hover:bg-accent/30">
                    <td className="px-4 py-2">
                      <span className="flex items-center gap-2.5">
                        <PresenceDot online={isOnline} />
                        <span className="font-medium">{d.name}</span>
                      </span>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{d.hostname}</td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {d.os}/{d.arch}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{d.version}</td>
                    <td className="px-3 py-2 text-muted-foreground">{timeAgo(d.createdAt)}</td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {isOnline ? <span className="text-live">Online now</span> : timeAgo(d.lastSeenAt)}
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${d.name}`}>
                            <MoreHorizontalIcon />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onSelect={() => setRenaming(d)}>
                            <PencilIcon />
                            Rename
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem variant="destructive" onSelect={() => setRemoving(d)}>
                            <Trash2Icon />
                            Remove
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <RenameDialog
        open={renaming !== null}
        onOpenChange={(o) => !o && setRenaming(null)}
        title="Rename device"
        initial={renaming?.name ?? ""}
        onSubmit={async (name) => {
          if (!renaming) return;
          await api.renameDevice(renaming.id, name);
          devicesStore.patch(renaming.id, { name });
        }}
      />

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Remove ${removing?.name ?? "device"}?`}
        confirmLabel="Remove device"
        description={
          <>
            <p>
              This revokes the device's credential and disconnects it immediately. It won't be able to reconnect, and
              any open terminals on it become unreachable from here.
            </p>
            <p>
              The daemon stays installed on the machine. To remove it there too, run{" "}
              <code className="rounded bg-terminal px-1 py-0.5 font-mono text-xs text-foreground">
                everywhere uninstall
              </code>{" "}
              on the device.
            </p>
          </>
        }
        onConfirm={async () => {
          if (!removing) return;
          await api.removeDevice(removing.id);
          devicesStore.patch(removing.id, null);
        }}
      />
    </div>
  );
}
