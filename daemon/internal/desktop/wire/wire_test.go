package wire

import (
	"math"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestParse(t *testing.T) {
	cases := []struct {
		in   []byte
		want any
	}{
		{[]byte{TypeMove, 1, 0, 0xff, 0xff, 0, 0x80}, Move{Seq: 1, X: 65535, Y: 32768}},
		{[]byte{TypeButton, ButtonRight, 1, 10, 0, 20, 0}, Button{Button: ButtonRight, Pressed: true, X: 10, Y: 20}},
		{[]byte{TypeKey, 30, 0, 1}, Key{Code: 30, Pressed: true}},
		{[]byte{TypeReleaseAll}, ReleaseAll{}},
		{[]byte{0x7f, 1, 2, 3}, nil},
		{[]byte{TypeSelectOutput, 4, 'D', 'P', '-', '1'}, SelectOutput{Name: "DP-1"}},
		{[]byte{TypeWorkspace, 3, 0, 0, 0}, Workspace{ID: 3}},
		{[]byte{TypeSetFollow, 1}, SetFollow{On: true}},
		{[]byte{TypeSelectWindow, 2, '4', '2'}, SelectWindow{ID: "42"}},
		{[]byte{TypeFocusWindow, 1, '7'}, FocusWindow{ID: "7"}},
		{[]byte{TypeClipboard, 2, 0, 0, 0, 'h', 'i'}, Clipboard{Text: "hi"}},
		{[]byte{TypeSetClipSync, 1}, SetClipSync{On: true}},
	}
	for _, c := range cases {
		got, err := Parse(c.in)
		if err != nil || got != c.want {
			t.Errorf("Parse(%v) = %#v, %v; want %#v", c.in, got, err, c.want)
		}
	}

	s := []byte{TypeScroll, 1, 0, 0, 0, 0, 0, 0, 0, 0}
	le.PutUint32(s[6:], math.Float32bits(-2.5))
	if got, _ := Parse(s); got != (Scroll{Continuous: true, DY: -2.5}) {
		t.Errorf("scroll = %#v", got)
	}
	if _, err := Parse([]byte{TypeMove, 1}); err != ErrShort {
		t.Errorf("short move err = %v", err)
	}
}

func TestNewer(t *testing.T) {
	if !Newer(1, 0) || Newer(0, 1) || !Newer(0, 65535) || Newer(5, 5) {
		t.Fatal("sequence comparison wrong")
	}
}

func TestMarshalWorkspaces(t *testing.T) {
	got := MarshalWorkspaces([]WorkspaceInfo{{ID: 2, Windows: 3, Active: true, Focused: true, Monitor: "eDP-1", Name: "2"}})
	want := []byte{TypeWorkspaces, 1, 2, 0, 0, 0, 3, 0, 3, 5, 'e', 'D', 'P', '-', '1', 1, '2'}
	if string(got) != string(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestShortStringUTF8(t *testing.T) {
	s := shortString(strings.Repeat("é", 200)) // 400 bytes
	if n := int(s[0]); n != 254 || !utf8.Valid(s[1:]) {
		t.Fatalf("length %d, valid %v", n, utf8.Valid(s[1:]))
	}
}

func TestHello(t *testing.T) {
	got := Hello{Width: 2, Height: 1, Output: "DP-1", Window: "9", Class: "foot", Title: "t"}.Marshal()
	want := []byte{TypeHello, 2, 0, 1, 0, 4, 'D', 'P', '-', '1', 1, '9', 4, 'f', 'o', 'o', 't', 1, 't'}
	if string(got) != string(want) {
		t.Fatalf("got %v", got)
	}
}
