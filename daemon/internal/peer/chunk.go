package peer

import (
	"encoding/json"
	"sync/atomic"
	"unicode/utf8"

	"github.com/pion/webrtc/v4"

	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
)

// controlChunk is the most a control message carries at once. A data
// channel message can't be bigger than the browser allows (64 KB unless it
// says more), so bigger ones go as chunks the client puts back together.
const controlChunk = 48 << 10

var chunkSeq atomic.Uint64

// sendControl sends a control message, in chunks if it's big.
func sendControl(dc *webrtc.DataChannel, msg []byte) {
	if len(msg) <= controlChunk {
		_ = dc.SendText(string(msg))
		return
	}
	id := chunkSeq.Add(1)
	parts := splitUTF8(msg, controlChunk)
	for i, part := range parts {
		out, _ := json.Marshal(protocol.ControlChunk{Chunk: id, Index: i, Count: len(parts), Data: string(part)})
		if dc.SendText(string(out)) != nil {
			return
		}
	}
}

// splitUTF8 cuts b into pieces of at most n bytes, never inside a character.
func splitUTF8(b []byte, n int) [][]byte {
	var out [][]byte
	for len(b) > n {
		cut := n
		for cut > 0 && !utf8.RuneStart(b[cut]) {
			cut--
		}
		out = append(out, b[:cut])
		b = b[cut:]
	}
	return append(out, b)
}
