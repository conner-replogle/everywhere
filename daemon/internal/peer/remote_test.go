package peer

import "testing"

func TestPlainText(t *testing.T) {
	for _, c := range []struct{ in, want string }{
		{"\x1b[1;32mok\x1b[0m done\r\n", "ok done\n"},
		{"\x1b]0;title\x07$ ls\r\n", "$ ls\n"},
		{"progress 10%\rprogress 100%\r\n", "progress 100%\n"},
		{"abc\b\bX\n", "aX\n"},
		{"\x1b(Bplain   \n", "plain\n"},
	} {
		if got := plainText([]byte(c.in)); got != c.want {
			t.Errorf("plainText(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
