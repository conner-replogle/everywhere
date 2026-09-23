import { createFileRoute, redirect, useNavigate, useRouter } from "@tanstack/react-router";
import { AuthForm } from "@/components/auth-form";
import { auth } from "@/lib/auth";

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): { redirect?: string } =>
    typeof search.redirect === "string" ? { redirect: search.redirect } : {},
  beforeLoad: async () => {
    const me = await auth.load();
    if (me.user) throw redirect({ to: "/" });
    if (me.signupOpen) throw redirect({ to: "/signup" });
  },
  component: Login,
});

function Login() {
  const navigate = useNavigate();
  const router = useRouter();
  const { redirect: to } = Route.useSearch();
  return (
    <AuthForm
      title="Sign in"
      submitLabel="Sign in"
      autoCompletePassword="current-password"
      onSubmit={async (u, p) => {
        await auth.login(u, p);
        // Only follow same-origin paths back.
        if (to?.startsWith("/") && !to.startsWith("//")) router.history.replace(to);
        else await navigate({ to: "/", replace: true });
      }}
    />
  );
}
