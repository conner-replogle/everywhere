// Package files is the files plugin: the files tab, listing directories
// and reading files over file: channels (which the chat's attachments,
// telemetry files and dashboards use too).
package files

import (
	"context"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/pion/webrtc/v4"

	"github.com/conner-replogle/everywhere/daemon/internal/plugin"
	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
	"github.com/conner-replogle/everywhere/daemon/internal/store"
)

// Plugin is the files plugin.
type Plugin struct{}

// New makes the files plugin.
func New() *Plugin { return &Plugin{} }

func (p *Plugin) Manifest() plugin.Manifest {
	return plugin.Manifest{
		ID: "files", Title: "Files", API: plugin.API, Builtin: true,
		Permissions: []string{plugin.PermFSRead, plugin.PermRemote},
	}
}

func (p *Plugin) Start(h plugin.Host) error {
	h.AddKind(plugin.KindHandler{Kind: plugin.Kind{Kind: protocol.ThreadFiles}})
	h.HandleChannel(protocol.FileChannelPrefix, func(ctx context.Context, _ plugin.ChannelContext, dc *webrtc.DataChannel) {
		serveFile(ctx, dc)
	})
	h.HandleRPC("fs.list", plugin.Params(func(_ plugin.RPCContext, p struct {
		Path string `json:"path"`
	}) (any, error) {
		return listDir(p.Path)
	}), plugin.Remote())
	return nil
}

func (p *Plugin) Stop() {}

// listDir lists a directory's entries, directories first.
func listDir(path string) (protocol.FsListing, error) {
	dir, err := store.ResolveDir(path)
	if err != nil {
		return protocol.FsListing{}, err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return protocol.FsListing{}, err
	}
	out := protocol.FsListing{Path: dir, Entries: []protocol.FsEntry{}}
	if parent := filepath.Dir(dir); parent != dir {
		out.Parent = &parent
	}
	for _, e := range entries {
		info, err := os.Stat(filepath.Join(dir, e.Name())) // follows symlinks
		if err != nil {
			if info, err = e.Info(); err != nil {
				continue
			}
		}
		out.Entries = append(out.Entries, protocol.FsEntry{
			Name:    e.Name(),
			Dir:     info.IsDir(),
			Size:    info.Size(),
			ModTime: info.ModTime().UnixMilli(),
		})
	}
	sort.Slice(out.Entries, func(i, j int) bool {
		a, b := out.Entries[i], out.Entries[j]
		if a.Dir != b.Dir {
			return a.Dir
		}
		return strings.ToLower(a.Name) < strings.ToLower(b.Name)
	})
	return out, nil
}
