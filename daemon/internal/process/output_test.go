package process

import (
	"reflect"
	"strings"
	"testing"
)

func TestHideReports(t *testing.T) {
	cases := []struct {
		name   string
		chunks []string
		want   string
	}{
		{"plain", []string{"hello\r\nworld\r\n"}, "hello\r\nworld\r\n"},
		{"report", []string{"a\r\n::ew stat x 1/2\r\nb\r\n"}, "a\r\nb\r\n"},
		{"first line", []string{"::ew status \"go\"\r\nok\r\n"}, "ok\r\n"},
		{"split prefix", []string{"a\r\n::e", "w checkpoint x\r\nb\r\n"}, "a\r\nb\r\n"},
		{"split mismatch", []string{"a\r\n::e", "x\r\n"}, "a\r\n::ex\r\n"},
		{"mid line", []string{"a ::ew stat x 1\r\n"}, "a ::ew stat x 1\r\n"},
		{"colon start", []string{":: not\r\n"}, ":: not\r\n"},
		{"no space", []string{"::ewx\r\n"}, "::ewx\r\n"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var f hideReports
			var got strings.Builder
			for _, ch := range c.chunks {
				got.Write(f.filter([]byte(ch)))
			}
			if got.String() != c.want {
				t.Fatalf("got %q, want %q", got.String(), c.want)
			}
		})
	}
}

func TestPlainLines(t *testing.T) {
	raw := "\x1b[32mgreen\x1b[0m text\r\n" +
		"10%\r20%\r30%\r\n" +
		"\x1b]9;4;1;50\x07after osc\r\n" +
		"old line\r\x1b[2Knew line\r\n" +
		"abc\b\bX\r\n" +
		"\x1b]0;title\x1b\\titled\r\n" +
		"\x1b(Bcharset\r\n" +
		"partial"
	want := []string{"green text", "30%", "after osc", "new line", "aX", "titled", "charset", "partial"}
	if got := plainLines([]byte(raw)); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %q\nwant %q", got, want)
	}
}

func TestOSC(t *testing.T) {
	var got []string
	s := textScanner{onOSC: func(p string) { got = append(got, p) }}
	s.write([]byte("\x1b]9;4;1;4"))
	s.write([]byte("2\x07x\x1b]9;4;0\x1b\\"))
	if want := []string{"9;4;1;42", "9;4;0"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestLocalURLs(t *testing.T) {
	got := localURLs("  ➜  Local:   http://localhost:5173/, also http://0.0.0.0:8000/api.")
	want := []string{"http://localhost:5173/", "http://localhost:8000/api"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %q, want %q", got, want)
	}
}
