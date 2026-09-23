import { createFileRoute, Link, Outlet, redirect, useNavigate } from "@tanstack/react-router";
import { ChevronDownIcon, LogOutIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { auth } from "@/lib/auth";
import { hub, useHub } from "@/lib/hub";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ location }) => {
    const me = await auth.load();
    if (!me.user) {
      if (me.signupOpen) throw redirect({ to: "/signup" });
      throw redirect({ to: "/login", search: location.href === "/" ? {} : { redirect: location.href } });
    }
    return { user: me.user };
  },
  component: AppLayout,
});

function AppLayout() {
  const navigate = useNavigate();
  const { user } = Route.useRouteContext();

  useEffect(() => {
    hub.onUnauthorized = () => {
      auth.clear();
      void navigate({ to: "/login" });
    };
    hub.start();
    return () => {
      hub.onUnauthorized = null;
    };
  }, [navigate]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-10 shrink-0 items-center gap-4 border-b bg-sidebar px-3">
        <Link to="/" className="rounded-sm focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none">
          <Logo className="text-[13px]" />
        </Link>
        <nav className="flex items-center gap-0.5">
          <NavLink to="/">Devices</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
        <div className="ml-auto flex items-center gap-3">
          <HubStatus />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="gap-1 text-foreground">
                {user.username}
                <ChevronDownIcon className="text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Signed in as {user.username}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={async () => {
                  await auth.logout();
                  await navigate({ to: "/login" });
                }}
              >
                <LogOutIcon />
                Log out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
      <main className="min-h-0 flex-1">
        <Outlet />
      </main>
    </div>
  );
}

function NavLink({ to, children }: { to: "/" | "/settings"; children: React.ReactNode }) {
  return (
    <Link
      to={to}
      activeOptions={{ exact: to === "/" }}
      className="rounded-md px-2 py-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
      activeProps={{ className: "text-foreground bg-accent" }}
    >
      {children}
    </Link>
  );
}

/** Only shows up when the signaling socket is down; silence means healthy. */
function HubStatus() {
  const { status } = useHub();
  const down = status === "connecting" || status === "closed";
  // Don't flash on the initial connect; only report sustained trouble.
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!down) return setShow(false);
    const t = setTimeout(() => setShow(true), 2000);
    return () => clearTimeout(t);
  }, [down]);
  if (!down || !show) return null;
  return (
    <span className={cn("flex items-center gap-1.5 text-xs text-warn")} role="status">
      <span className="size-1.5 animate-pulse rounded-full bg-warn" />
      Reconnecting to server…
    </span>
  );
}
