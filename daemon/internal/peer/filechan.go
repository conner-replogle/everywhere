package peer

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"

	"github.com/pion/webrtc/v4"

	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
)

// maxFileRead caps what a file channel sends; the viewer is for looking at
// files, not copying big ones off the device.
const maxFileRead = 25 << 20

// serveFile sends one file on a file:<id> channel, then leaves the channel
// for the client to close.
func (s *Server) serveFile(dc *webrtc.DataChannel) {
	send := func(msg any) error {
		b, _ := json.Marshal(msg)
		return dc.SendText(string(b))
	}
	low := make(chan struct{}, 1)
	dc.SetBufferedAmountLowThreshold(maxChunk * 16)
	dc.OnBufferedAmountLow(func() {
		select {
		case low <- struct{}{}:
		default:
		}
	})
	closed := make(chan struct{})
	dc.OnClose(func() { close(closed) })

	started := false
	dc.OnMessage(func(msg webrtc.DataChannelMessage) {
		var req protocol.FileRead
		if !msg.IsString || json.Unmarshal(msg.Data, &req) != nil || req.T != "read" || started {
			return
		}
		started = true
		go func() {
			if err := sendFile(req.Path, send, dc, low, closed); err != nil {
				_ = send(protocol.FileError{T: "error", Message: err.Error()})
			}
		}()
	})
}

func sendFile(path string, send func(any) error, dc *webrtc.DataChannel, low, closed <-chan struct{}) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	if info.IsDir() {
		return errors.New("that's a directory")
	}
	if info.Size() > maxFileRead {
		return fmt.Errorf("too big to show (%d MB; the limit is %d MB)", info.Size()>>20, maxFileRead>>20)
	}
	if err := send(protocol.FileStart{T: "start", Path: path, Size: info.Size(), ModTime: info.ModTime().UnixMilli()}); err != nil {
		return err
	}
	buf := make([]byte, maxChunk)
	for {
		n, err := f.Read(buf)
		if n > 0 {
			for dc.BufferedAmount() > maxChunk*64 {
				select {
				case <-low:
				case <-closed:
					return nil
				}
			}
			if err := dc.Send(buf[:n]); err != nil {
				return nil
			}
		}
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return err
		}
	}
	return send(map[string]string{"t": "end"})
}
