// Package version holds build metadata, set via -ldflags at release time.
package version

// Version is the daemon version; "dev" for local builds.
var Version = "dev"

// Repo is the GitHub repository releases are published to.
const Repo = "conner-replogle/everywhere"
