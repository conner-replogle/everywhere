package claude

import (
	"os"
	"runtime"
	"strings"
)

// TokenEnv is the variable claude reads a long-lived token from (one made
// with `claude setup-token`), in place of the credentials it signs in with
// and renews.
const TokenEnv = "CLAUDE_CODE_OAUTH_TOKEN"

// WithToken is env (nil: the daemon's) with claude's long-lived token, or
// without one when token is "".
func WithToken(env []string, token string) []string {
	if env == nil {
		env = os.Environ()
	}
	out := make([]string, 0, len(env)+1)
	for _, kv := range env {
		k, _, _ := strings.Cut(kv, "=")
		if k == TokenEnv || (runtime.GOOS == "windows" && strings.EqualFold(k, TokenEnv)) {
			continue
		}
		out = append(out, kv)
	}
	if token != "" {
		out = append(out, TokenEnv+"="+token)
	}
	return out
}
