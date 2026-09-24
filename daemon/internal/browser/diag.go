package browser

import "encoding/json"

// diagnostics collects what a page logged and which requests failed, for
// agents inspecting the page.
type diagnostics struct{}

// note sees every CDP event of the tab, on its event goroutine.
func (d *diagnostics) note(method string, params json.RawMessage) {}
