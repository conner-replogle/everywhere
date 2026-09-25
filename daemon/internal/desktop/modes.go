package desktop

import (
	"github.com/conner-replogle/everywhere/daemon/internal/desktop/ipc"
	"github.com/conner-replogle/everywhere/daemon/internal/desktop/wire"
)

// profile is what a viewer-selectable mode means for capture and encoding.
type profile struct {
	codecs      []ipc.Codec // in preference order; the first one the viewer negotiated wins
	maxHeight   int         // 0 = native
	maxFPS      int         // 0 = follow content
	targetUsage int
	minKbps     int
	startKbps   int
	maxKbps     int
}

func profileFor(mode wire.Mode, av1 bool) profile {
	switch mode {
	case wire.ModeSmooth:
		// Fewer pixels roughly halves VCN encode time; H.264 has the fastest decoders everywhere.
		return profile{codecs: []ipc.Codec{ipc.H264}, maxHeight: 1080, maxFPS: 60, targetUsage: 7,
			minKbps: 3000, startKbps: 12000, maxKbps: 20000}
	case wire.ModeLowBandwidth:
		return profile{codecs: []ipc.Codec{ipc.H265, ipc.H264}, maxHeight: 720, maxFPS: 30, targetUsage: 4,
			minKbps: 400, startKbps: 1500, maxKbps: 3000}
	default:
		codecs := []ipc.Codec{ipc.H265, ipc.H264}
		if av1 {
			codecs = append([]ipc.Codec{ipc.AV1}, codecs...)
		}
		return profile{codecs: codecs, targetUsage: 4, minKbps: 4000, startKbps: 20000, maxKbps: 40000}
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
