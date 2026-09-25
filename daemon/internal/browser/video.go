package browser

import (
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"time"
)

// The capture extension streams tabs to viewers as WebRTC video: Chrome
// captures the tab (chrome.tabCapture), encodes it and handles congestion
// itself. Its key pins its id, which the browser is told to trust with tab
// capture (--allowlisted-extension-id) since nobody can click its icon.
//
//go:embed capture
var captureExt embed.FS

const (
	captureExtID  = "ffgdbopkpbbjigklpngeklikinpdfddj"
	videoBinding  = "__everywhereVideo"
	hostReadyWait = 5 * time.Second
)

// videoHost is the extension's page, which owns every capture and every
// viewer's peer connection.
type videoHost struct {
	conn                *conn
	targetID, sessionID string
}

// videoEvent is a message from the host page.
type videoEvent struct {
	T         string          `json:"t"` // ice | ended
	Key       string          `json:"key"`
	Viewer    string          `json:"viewer"`
	Candidate json.RawMessage `json:"candidate"`
}

// writeCaptureExt copies the extension into dir, replacing what's there.
func writeCaptureExt(dir string) error {
	if err := os.RemoveAll(dir); err != nil {
		return err
	}
	sub, _ := fs.Sub(captureExt, "capture")
	return os.CopyFS(dir, sub)
}

// startVideoHost loads the capture extension and opens its page. It fails on
// browsers without extension support, like chrome-headless-shell; tabs then
// fall back to JPEG screencasts.
func startVideoHost(ctx context.Context, c *conn, extDir string) (*videoHost, error) {
	if err := writeCaptureExt(extDir); err != nil {
		return nil, err
	}
	var loaded struct {
		ID string `json:"id"`
	}
	if err := c.call(ctx, "", "Extensions.loadUnpacked", map[string]any{"path": extDir}, &loaded); err != nil {
		return nil, err
	}
	if loaded.ID != captureExtID {
		return nil, fmt.Errorf("capture extension loaded as %s, want %s", loaded.ID, captureExtID)
	}
	var created struct {
		TargetID string `json:"targetId"`
	}
	url := "chrome-extension://" + captureExtID + "/host.html"
	if err := c.call(ctx, "", "Target.createTarget", map[string]any{"url": url, "newWindow": true, "background": true}, &created); err != nil {
		return nil, err
	}
	var attached struct {
		SessionID string `json:"sessionId"`
	}
	if err := c.call(ctx, "", "Target.attachToTarget", map[string]any{"targetId": created.TargetID, "flatten": true}, &attached); err != nil {
		return nil, err
	}
	h := &videoHost{conn: c, targetID: created.TargetID, sessionID: attached.SessionID}
	if err := c.call(ctx, h.sessionID, "Runtime.addBinding", map[string]any{"name": videoBinding}, nil); err != nil {
		return nil, err
	}
	deadline := time.Now().Add(hostReadyWait)
	for {
		var ready bool
		if err := h.eval(ctx, "self.ready === true", &ready); err == nil && ready {
			return h, nil
		}
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("capture host didn't load")
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// eval runs expr in the host page, awaiting it, and decodes its value into out.
func (h *videoHost) eval(ctx context.Context, expr string, out any) error {
	var r struct {
		Result struct {
			Value json.RawMessage `json:"value"`
		} `json:"result"`
		ExceptionDetails *struct {
			Text      string `json:"text"`
			Exception struct {
				Description string `json:"description"`
			} `json:"exception"`
		} `json:"exceptionDetails"`
	}
	if err := h.conn.call(ctx, h.sessionID, "Runtime.evaluate", map[string]any{
		"expression": expr, "awaitPromise": true, "returnByValue": true,
	}, &r); err != nil {
		return err
	}
	if e := r.ExceptionDetails; e != nil {
		msg := e.Exception.Description
		if msg == "" {
			msg = e.Text
		}
		return fmt.Errorf("capture: %s", msg)
	}
	if out != nil && len(r.Result.Value) > 0 {
		return json.Unmarshal(r.Result.Value, out)
	}
	return nil
}

// invoke calls one of the host page's functions with JSON arguments.
func (h *videoHost) invoke(ctx context.Context, out any, fn string, args ...any) error {
	expr := fn + "("
	for i, a := range args {
		b, err := json.Marshal(a)
		if err != nil {
			return err
		}
		if i > 0 {
			expr += ","
		}
		expr += string(b)
	}
	return h.eval(ctx, expr+")", out)
}

// kbpsFor turns a viewer's quality setting into a bitrate cap.
func kbpsFor(quality int) int {
	switch {
	case quality <= 45:
		return 2500
	case quality <= 75:
		return 8000
	default:
		return 20000
	}
}
