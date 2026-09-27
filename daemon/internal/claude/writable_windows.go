package claude

import "os"

// writable reports whether the user may write in dir, by trying to.
func writable(dir string) bool {
	f, err := os.CreateTemp(dir, ".everywhere-")
	if err != nil {
		return false
	}
	f.Close()
	os.Remove(f.Name())
	return true
}
