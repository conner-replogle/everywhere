package claude

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"os"
	"runtime"
	"strings"
	"testing"
	"time"
)

// fakeAuth plays `claude auth status` and `claude auth login` for the modes
// that start with "auth-". It reports whether it handled the mode.
func fakeAuth(mode string) bool {
	switch mode {
	case "auth-signed-out":
		// The real CLI exits 1 when signed out, with the status all the same.
		fmt.Println(`{"loggedIn": false, "authMethod": "none", "apiProvider": "firstParty"}`)
		os.Exit(1)
	case "auth-login":
		if runtime.GOOS != "windows" && os.Getenv("BROWSER") != "true" {
			fmt.Println("Login failed: a browser would have opened")
			os.Exit(1)
		}
		fmt.Println("Opening browser to sign in…")
		fmt.Println("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=s1")
		fmt.Print("Paste code here if prompted > ")
		in := bufio.NewScanner(os.Stdin)
		if !in.Scan() {
			os.Exit(1)
		}
		if in.Text() != "good#s1" {
			fmt.Println("Login failed: Request failed with status code 400")
			os.Exit(1)
		}
		fmt.Println("Login successful.")
	default:
		return false
	}
	return true
}

func fakeEnv(mode string) (string, []string) {
	exe, _ := os.Executable()
	return exe, append(os.Environ(), "EW_FAKE_CLAUDE="+mode, "BROWSER=firefox")
}

func TestAuthSignedOut(t *testing.T) {
	bin, env := fakeEnv("auth-signed-out")
	st, err := Auth(context.Background(), bin, env)
	if err != nil {
		t.Fatal(err)
	}
	if st.LoggedIn || st.AuthMethod != "none" {
		t.Fatalf("status = %+v", st)
	}
}

func startFakeLogin(t *testing.T) *Login {
	t.Helper()
	bin, env := fakeEnv("auth-login")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	l, err := StartLogin(ctx, bin, env, false)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(l.Cancel)
	if l.URL != "https://claude.com/cai/oauth/authorize?code=true&state=s1" {
		t.Fatalf("URL = %q", l.URL)
	}
	return l
}

func TestLoginWithCode(t *testing.T) {
	l := startFakeLogin(t)
	if err := l.Submit(context.Background(), "  good#s1\n"); err != nil {
		t.Fatal(err)
	}
}

func TestLoginRefusesBadCode(t *testing.T) {
	l := startFakeLogin(t)
	err := l.Submit(context.Background(), "bad")
	if err == nil || err.Error() != "Login failed: Request failed with status code 400" {
		t.Fatalf("err = %v", err)
	}
}

func TestLoginCancel(t *testing.T) {
	l := startFakeLogin(t)
	l.Cancel()
	select {
	case <-l.Done():
	default:
		t.Fatal("still running after Cancel")
	}
	if err := l.Submit(context.Background(), "good#s1"); !errors.Is(err, ErrLoginCanceled) {
		t.Fatalf("Submit after Cancel: %v", err)
	}
}

func TestLoginURL(t *testing.T) {
	for line, want := range map[string]string{
		"If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?a=b\n": "https://claude.com/cai/oauth/authorize?a=b",
		"Opening browser to sign in…\n":                                                   "",
		"See https://docs.claude.com for help\n":                                          "",
		"Paste code here if prompted > Login successful.\n":                               "",
	} {
		if got := loginURL(line); got != want {
			t.Errorf("loginURL(%q) = %q, want %q", strings.TrimSpace(line), got, want)
		}
	}
}
