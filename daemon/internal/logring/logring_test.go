package logring

import (
	"slices"
	"testing"
)

func TestRing(t *testing.T) {
	r := &Ring{Max: 3}
	_, _ = r.Write([]byte("one\ntw"))
	_, _ = r.Write([]byte("o\nthree\nfour\n"))
	if got := r.Tail(0); !slices.Equal(got, []string{"two", "three", "four"}) {
		t.Fatalf("Tail(0) = %q", got)
	}
	if got := r.Tail(2); !slices.Equal(got, []string{"three", "four"}) {
		t.Fatalf("Tail(2) = %q", got)
	}
	_, _ = r.Write([]byte("five\n"))
	if got := r.Tail(10); !slices.Equal(got, []string{"three", "four", "five"}) {
		t.Fatalf("after wrap = %q", got)
	}
}
