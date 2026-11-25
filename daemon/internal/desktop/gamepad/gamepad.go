// Package gamepad plugs virtual game controllers into the host, so a remote
// desktop viewer's controllers reach games as if they were plugged in there.
// On Windows they are Xbox 360 controllers on the ViGEmBus driver, which
// games read through XInput (and DirectInput, SDL, Steam Input); other hosts
// don't have them yet.
package gamepad

// MaxPads is how many controllers a session can plug in, as XInput has.
const MaxPads = 4

// State is a controller's buttons and axes, as XInput reports them.
type State struct {
	Buttons        uint16 // XINPUT_GAMEPAD_* bits
	LT, RT         uint8
	LX, LY, RX, RY int16 // up is positive
}

// RumbleFunc is told when a game sets a controller's motors (0..255): large
// is the low-frequency one, small the high-frequency one.
type RumbleFunc func(index int, large, small uint8)

// InstallHint says how to make controllers available on this host.
const InstallHint = "install the ViGEmBus driver on it (https://github.com/nefarius/ViGEmBus/releases, or `winget install ViGEm.ViGEmBus`)"
