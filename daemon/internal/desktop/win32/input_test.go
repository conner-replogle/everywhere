//go:build windows

package win32

import "testing"

// Windows maps an absolute coordinate c to pixel c*extent/65536, rounded down.
func TestAbsoluteLandsOnThePixel(t *testing.T) {
	for _, extent := range []int{800, 1366, 1920, 2560, 3840, 7680} {
		for _, lo := range []int32{0, -1920} {
			for v := lo; v < lo+int32(extent); v++ {
				c := absolute(v, lo, extent)
				if got := lo + int32(int64(c)*int64(extent)/65536); got != v {
					t.Fatalf("extent %d, lo %d: pixel %d → %d → pixel %d", extent, lo, v, c, got)
				}
			}
		}
	}
}
