import { createFileRoute, redirect } from "@tanstack/react-router";

// Devices no longer have a page of their own; their projects are in the sidebar.
export const Route = createFileRoute("/_app/_workspace/d/$deviceId/")({
  beforeLoad: () => {
    throw redirect({ to: "/" });
  },
});
