package plugin

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Empty is an empty result.
type Empty struct{}

// Unmarshal decodes params; empty params leave v as it is.
func Unmarshal(raw json.RawMessage, v any) error {
	if len(raw) == 0 {
		return nil
	}
	if err := json.Unmarshal(raw, v); err != nil {
		return fmt.Errorf("bad params: %w", err)
	}
	return nil
}

// Params is an RPCFunc for methods whose params decode into P.
func Params[P any](fn func(c RPCContext, p P) (any, error)) RPCFunc {
	return func(_ context.Context, c RPCContext, raw json.RawMessage) (any, error) {
		var p P
		if err := Unmarshal(raw, &p); err != nil {
			return nil, err
		}
		return fn(c, p)
	}
}

// ResolvePath makes p absolute: ~ is the home directory, and a relative
// path is in dir.
func ResolvePath(dir, p string) string {
	p = strings.TrimSpace(p)
	if p == "~" || strings.HasPrefix(p, "~/") {
		if home, err := os.UserHomeDir(); err == nil {
			p = filepath.Join(home, strings.TrimPrefix(p, "~"))
		}
	}
	if !filepath.IsAbs(p) {
		p = filepath.Join(dir, p)
	}
	return filepath.Clean(p)
}
