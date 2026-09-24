package peer

import (
	"encoding/json"
	"errors"
	"io"
	"sync"

	"github.com/pion/webrtc/v4"

	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
)

// serveUpload receives one attachment on an upload:<id> channel. Chunks are
// piped straight into the file, so a slow disk slows the sender down rather
// than filling memory. The client closes the channel after the result.
func (s *Server) serveUpload(dc *webrtc.DataChannel, id string) {
	var (
		mu sync.Mutex
		pw *io.PipeWriter
	)
	send := func(r protocol.UploadResult) {
		b, _ := json.Marshal(r)
		_ = dc.SendText(string(b))
	}

	dc.OnMessage(func(msg webrtc.DataChannelMessage) {
		mu.Lock()
		w := pw
		mu.Unlock()
		if !msg.IsString {
			if w != nil {
				_, _ = w.Write(msg.Data) // fails once the upload has been rejected
			}
			return
		}
		var start protocol.UploadStart
		if json.Unmarshal(msg.Data, &start) != nil {
			return
		}
		switch {
		case start.T == "start" && w == nil:
			pr, nw := io.Pipe()
			mu.Lock()
			pw = nw
			mu.Unlock()
			go func() {
				att, err := s.agents.SaveUpload(start.ThreadID, id, start.Name, start.MediaType, start.Size, pr)
				if err != nil {
					pr.CloseWithError(err)
					send(protocol.UploadResult{T: "error", Message: err.Error()})
					return
				}
				send(protocol.UploadResult{T: "done", Attachment: &att})
			}()
		case start.T == "end" && w != nil:
			_ = w.Close()
		}
	})
	dc.OnClose(func() {
		mu.Lock()
		defer mu.Unlock()
		if pw != nil {
			pw.CloseWithError(errors.New("upload channel closed"))
		}
	})
}
