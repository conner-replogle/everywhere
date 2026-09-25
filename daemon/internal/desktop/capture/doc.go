// Package capture grabs a Hyprland output with ext-image-copy-capture into
// dmabufs and hardware-encodes it with VA-API, without copying frames. It needs
// cgo (Wayland, libgbm, GStreamer) and only builds into everywhere-desktop.
package capture
