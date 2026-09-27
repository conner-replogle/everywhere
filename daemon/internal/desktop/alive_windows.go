package desktop

// alive reports whether process pid exists. Hyprland never runs on Windows,
// so there's no instance to find.
func alive(pid int) bool { return false }
