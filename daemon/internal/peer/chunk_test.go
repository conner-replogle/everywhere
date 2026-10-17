package peer

import (
	"bytes"
	"testing"
	"unicode/utf8"
)

func TestSplitUTF8(t *testing.T) {
	b := bytes.Repeat([]byte("aé漢🙂"), 1000)
	parts := splitUTF8(b, 100)
	if !bytes.Equal(bytes.Join(parts, nil), b) {
		t.Fatal("parts don't join back")
	}
	for _, p := range parts {
		if len(p) > 100 || !utf8.Valid(p) {
			t.Fatalf("bad part %q", p)
		}
	}
}
