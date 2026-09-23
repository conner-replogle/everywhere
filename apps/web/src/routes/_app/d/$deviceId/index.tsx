import { createFileRoute } from "@tanstack/react-router";
import { SquareTerminalIcon } from "lucide-react";
import { useDevice } from "@/components/device-context";

export const Route = createFileRoute("/_app/d/$deviceId/")({
  component: DeviceHome,
});

function DeviceHome() {
  const { threads, projects } = useDevice();
  const hasThreads = (threads.data?.length ?? 0) > 0;
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="flex max-w-sm flex-col items-center gap-2 text-center">
        <SquareTerminalIcon className="size-6 text-muted-foreground" />
        <h2 className="text-[15px] font-semibold">{hasThreads ? "Pick a thread" : "No threads yet"}</h2>
        <p className="text-muted-foreground">
          {hasThreads
            ? "Choose a thread in the sidebar, or start a terminal or Claude thread in a project."
            : projects.data
              ? "Hover a project in the sidebar and press + to start a thread. Each thread is a shell or a Claude conversation in that project's directory."
              : "Loading projects…"}
        </p>
      </div>
    </div>
  );
}
