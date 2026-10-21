// Package builtin lists the plugins compiled into the daemon.
package builtin

import (
	"github.com/conner-replogle/everywhere/daemon/internal/plugin"
	"github.com/conner-replogle/everywhere/daemon/internal/plugins/agent"
	"github.com/conner-replogle/everywhere/daemon/internal/plugins/browser"
	"github.com/conner-replogle/everywhere/daemon/internal/plugins/clone"
	"github.com/conner-replogle/everywhere/daemon/internal/plugins/code"
	"github.com/conner-replogle/everywhere/daemon/internal/plugins/dashboards"
	"github.com/conner-replogle/everywhere/daemon/internal/plugins/desktop"
	"github.com/conner-replogle/everywhere/daemon/internal/plugins/done"
	"github.com/conner-replogle/everywhere/daemon/internal/plugins/files"
	"github.com/conner-replogle/everywhere/daemon/internal/plugins/git"
	"github.com/conner-replogle/everywhere/daemon/internal/plugins/processes"
	"github.com/conner-replogle/everywhere/daemon/internal/plugins/scratch"
	"github.com/conner-replogle/everywhere/daemon/internal/plugins/share"
	"github.com/conner-replogle/everywhere/daemon/internal/plugins/telemetry"
	"github.com/conner-replogle/everywhere/daemon/internal/plugins/terminal"
)

// Plugins makes a fresh set of the built-in plugins.
func Plugins() []plugin.Plugin {
	return []plugin.Plugin{
		terminal.New(),
		agent.New(),
		browser.New(),
		desktop.New(),
		files.New(),
		processes.New(),
		telemetry.New(),
		dashboards.New(),
		scratch.New(),
		git.New(),
		clone.New(),
		code.New(),
		share.New(),
		done.New(),
	}
}
