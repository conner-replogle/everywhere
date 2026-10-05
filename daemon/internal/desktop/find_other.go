//go:build !windows

package desktop

// findDesktop finds the user's desktop: their Hyprland.
func findDesktop() (desktopHost, error) {
	h, err := findHyprland()
	if err != nil {
		return nil, err
	}
	return h, nil
}

// descriptionOverrides replaces tool descriptions for this platform's desktop.
var descriptionOverrides = map[string]string{}
