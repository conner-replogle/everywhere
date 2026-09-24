import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/_workspace/settings/")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/devices", replace: true });
  },
});
