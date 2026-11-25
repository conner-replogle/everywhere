package desktop

import (
	"runtime"
	"slices"

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
	p := baseProfile(mode, av1)
	switch runtime.GOOS {
	case "windows":
		p.codecs = []ipc.Codec{ipc.H264} // its worker encodes H.264 only
		// Target usage 7 asks Media Foundation for its fastest preset, which
		// NVENC, AMF and Quick Sync don't need to keep up: they spend the
		// time on quality instead. H.264 needs more bits than H.265 for the
		// same picture, too.
		p.targetUsage = 3
		if mode == wire.ModeSharp {
			p.targetUsage = 2
		}
		p.startKbps, p.maxKbps = p.startKbps*5/4, p.maxKbps*5/4
	case "darwin":
		p.codecs = slices.DeleteFunc(p.codecs, func(c ipc.Codec) bool { return c == ipc.AV1 }) // VideoToolbox has no AV1 encoder
	}
	return p
}

func baseProfile(mode wire.Mode, av1 bool) profile {
	switch mode {
	case wire.ModeSmooth:
		// Fewer pixels roughly halves VCN encode time; H.264 has the fastest decoders everywhere.
		return profile{codecs: []ipc.Codec{ipc.H264}, maxHeight: 1080, maxFPS: 60, targetUsage: 7,
			minKbps: 4000, startKbps: 16000, maxKbps: 30000}
	case wire.ModeLowBandwidth:
		return profile{codecs: []ipc.Codec{ipc.H265, ipc.H264}, maxHeight: 720, maxFPS: 30, targetUsage: 4,
			minKbps: 500, startKbps: 2000, maxKbps: 4000}
	default:
		codecs := []ipc.Codec{ipc.H265, ipc.H264}
		if av1 {
			codecs = append([]ipc.Codec{ipc.AV1}, codecs...)
		}
		return profile{codecs: codecs, targetUsage: 4, minKbps: 6000, startKbps: 30000, maxKbps: 60000}
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
