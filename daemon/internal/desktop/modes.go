package desktop

import "github.com/conner-replogle/everywhere/daemon/internal/desktop/wire"

// profile is what a viewer-selectable mode means for capture and encoding.
type profile struct {
	maxHeight   int // 0 = native
	maxFPS      int // 0 = follow content
	targetUsage int
	minKbps     int
	startKbps   int
	maxKbps     int
}

// Every mode is H.264: browsers decode it in hardware everywhere, with the
// least decode latency.
func profileFor(mode wire.Mode) profile {
	switch mode {
	case wire.ModeSmooth:
		// Fewer pixels roughly halves VCN encode time.
		return profile{maxHeight: 1080, maxFPS: 60, targetUsage: 7, minKbps: 3000, startKbps: 12000, maxKbps: 20000}
	case wire.ModeLowBandwidth:
		return profile{maxHeight: 720, maxFPS: 30, targetUsage: 4, minKbps: 400, startKbps: 1500, maxKbps: 3000}
	default:
		return profile{targetUsage: 4, minKbps: 4000, startKbps: 20000, maxKbps: 40000}
	}
}

// scaledSize fits width x height under maxHeight, keeping aspect and even dimensions.
func scaledSize(width, height, maxHeight int) (int, int) {
	if maxHeight <= 0 || height <= maxHeight || width <= 0 || height <= 0 {
		return 0, 0
	}
	w := width * maxHeight / height
	return w &^ 1, maxHeight &^ 1
}

func clamp(v, lo, hi int) int {
	return max(lo, min(hi, v))
}
