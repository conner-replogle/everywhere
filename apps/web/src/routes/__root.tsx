import { createRootRoute, Link, Outlet } from "@tanstack/react-router";
import { CenteredMessage } from "@/components/centered-message";
import { Button } from "@/components/ui/button";

export const Route = createRootRoute({
  component: Outlet,
  notFoundComponent: NotFound,
  errorComponent: ({ error, reset }) => (
    <CenteredMessage title="Something broke" body={error instanceof Error ? error.message : String(error)}>
      <Button variant="outline" size="sm" onClick={reset}>
        Try again
      </Button>
    </CenteredMessage>
  ),
});

function NotFound() {
  return (
    <CenteredMessage title="Nothing here" body="This page doesn't exist.">
      <Button variant="outline" size="sm" asChild>
        <Link to="/">Go to devices</Link>
      </Button>
    </CenteredMessage>
  );
}
