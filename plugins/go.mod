module github.com/conner-replogle/everywhere/plugins

go 1.27.0

require github.com/conner-replogle/everywhere/daemon v0.0.0

// The SDK comes from this repo, so a plugin always builds against the SDK
// next to it.
replace github.com/conner-replogle/everywhere/daemon => ../daemon
