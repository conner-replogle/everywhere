package update

import "testing"

func TestNewer(t *testing.T) {
	for _, c := range []struct {
		a, b string
		want bool
	}{
		{"0.1.2", "0.1.1", true},
		{"v0.2.0", "0.1.9", true},
		{"0.1.10", "0.1.9", true},
		{"0.1.1", "0.1.1", false},
		{"0.1.0", "0.1.1", false},
		{"1.0", "0.9.9", true},
		{"0.1.2", "dev", false},
		{"dev", "0.1.1", false},
		{"0.2.0-rc1", "0.1.0", true},
	} {
		if got := Newer(c.a, c.b); got != c.want {
			t.Errorf("Newer(%q, %q) = %v, want %v", c.a, c.b, got, c.want)
		}
	}
}
