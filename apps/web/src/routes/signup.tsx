import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { AuthForm } from "@/components/auth-form";
import { PASSWORD_HINT } from "@/lib/api";
import { auth } from "@/lib/auth";

export const Route = createFileRoute("/signup")({
  beforeLoad: async () => {
    const me = await auth.load(true);
    if (me.user) throw redirect({ to: "/" });
    if (!me.signupOpen) throw redirect({ to: "/login" });
  },
  component: Signup,
});

function Signup() {
  const navigate = useNavigate();
  return (
    <AuthForm
      title="Create the owner account"
      description="This install has one user. Signup closes as soon as this account exists."
      submitLabel="Create account"
      passwordHint={PASSWORD_HINT}
      autoCompletePassword="new-password"
      onSubmit={async (u, p) => {
        await auth.signup(u, p);
        await navigate({ to: "/", replace: true });
      }}
    />
  );
}
