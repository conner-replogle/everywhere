package claude

import "testing"

func TestWithToken(t *testing.T) {
	env := WithToken([]string{"A=1", TokenEnv + "=old"}, "new")
	if len(env) != 2 || env[0] != "A=1" || env[1] != TokenEnv+"=new" {
		t.Fatalf("env = %q", env)
	}
	if env := WithToken([]string{TokenEnv + "=old"}, ""); len(env) != 0 {
		t.Fatalf("env = %q", env)
	}
}
