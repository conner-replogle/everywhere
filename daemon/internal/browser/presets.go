package browser

import (
	"fmt"

	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
)

// Preset is a device the tab can emulate. Sizes are CSS pixels in the
// device's natural orientation, from Chrome DevTools' device list.
type Preset struct {
	ID            string
	Label         string
	Category      string // Phone | Tablet | Desktop
	Width, Height int
}

var Presets = []Preset{
	{"iphone-se", "iPhone SE", "Phone", 375, 667},
	{"iphone-xr", "iPhone XR", "Phone", 414, 896},
	{"iphone-12-pro", "iPhone 12 Pro", "Phone", 390, 844},
	{"iphone-14-pro-max", "iPhone 14 Pro Max", "Phone", 430, 932},
	{"pixel-7", "Pixel 7", "Phone", 412, 915},
	{"galaxy-s8-plus", "Samsung Galaxy S8+", "Phone", 360, 740},
	{"galaxy-s20-ultra", "Samsung Galaxy S20 Ultra", "Phone", 412, 915},
	{"galaxy-z-fold-5", "Galaxy Z Fold 5", "Phone", 344, 882},
	{"galaxy-a51", "Samsung Galaxy A51/71", "Phone", 412, 914},
	{"ipad-mini", "iPad Mini", "Tablet", 768, 1024},
	{"ipad-air", "iPad Air", "Tablet", 820, 1180},
	{"ipad-pro", "iPad Pro", "Tablet", 1024, 1366},
	{"surface-pro-7", "Surface Pro 7", "Tablet", 912, 1368},
	{"surface-duo", "Surface Duo", "Tablet", 540, 720},
	{"zenbook-fold", "Asus Zenbook Fold", "Tablet", 853, 1280},
	{"nest-hub", "Nest Hub", "Tablet", 1024, 600},
	{"nest-hub-max", "Nest Hub Max", "Tablet", 1280, 800},
	{"laptop", "Laptop", "Desktop", 1280, 800},
	{"desktop", "Desktop", "Desktop", 1920, 1080},
}

// ResolveViewport turns a viewport request (mode fill | preset | freeform)
// into a setting. Orientation is portrait, landscape or "" for the preset's
// own.
func ResolveViewport(mode, preset, orientation string, width, height int) (protocol.BrowserViewportSetting, error) {
	switch mode {
	case "", "fill":
		return protocol.BrowserViewportSetting{Mode: "fill"}, nil
	case "preset":
		for _, p := range Presets {
			if p.ID != preset {
				continue
			}
			w, h := p.Width, p.Height
			portrait := h >= w
			if (orientation == "landscape" && portrait) || (orientation == "portrait" && !portrait) {
				w, h = h, w
			}
			return protocol.BrowserViewportSetting{Mode: "preset", Preset: p.ID, Width: w, Height: h, Mobile: p.Category != "Desktop"}, nil
		}
		return protocol.BrowserViewportSetting{}, fmt.Errorf("unknown viewport preset %q", preset)
	case "freeform":
		if width <= 0 || height <= 0 {
			return protocol.BrowserViewportSetting{}, fmt.Errorf("a freeform viewport needs width and height")
		}
		return protocol.BrowserViewportSetting{Mode: "freeform", Width: clampDim(width, 3840), Height: clampDim(height, 2160)}, nil
	}
	return protocol.BrowserViewportSetting{}, fmt.Errorf("unknown viewport mode %q", mode)
}

func clampDim(v, most int) int { return min(max(v, minDim), most) }

const minDim = 200
