package process

import (
	"bytes"
	"regexp"
	"strings"
)

// reportPrefix starts a line a process prints to report progress.
const reportPrefix = "::ew "

// maxLine caps a line of plain text; the rest of a longer one is dropped.
const maxLine = 4096

// hideReports cuts ::ew lines out of the raw output viewers see. A line
// that might be one is held back until it's clearly not.
type hideReports struct {
	midLine  bool // not at the start of a line
	held     []byte
	dropping bool
}

func (f *hideReports) filter(p []byte) []byte {
	out := make([]byte, 0, len(p))
	for _, b := range p {
		switch {
		case f.dropping:
			if b == '\n' {
				f.dropping, f.midLine = false, false
			}
		case len(f.held) > 0 || (!f.midLine && b == ':'):
			f.held = append(f.held, b)
			if bytes.HasPrefix([]byte(reportPrefix), f.held) {
				if len(f.held) == len(reportPrefix) {
					f.dropping, f.held = true, f.held[:0]
				}
				continue
			}
			out = append(out, f.held...)
			f.held = f.held[:0]
			f.midLine = b != '\n'
		default:
			out = append(out, b)
			f.midLine = b != '\n'
		}
	}
	return out
}

// textScanner turns raw terminal output into plain lines: escape sequences
// are dropped (OSC payloads are handed to onOSC), a carriage return lets
// what follows overwrite the line, and backspace erases.
type textScanner struct {
	onLine func(string)
	onOSC  func(string)

	// n counts the bytes written, so a line's callback can tell where in
	// the output the line ended.
	n     int64
	state int
	line  []byte
	cr    bool // a \r came last: the next character starts the line over
	param []byte
	osc   []byte
}

const (
	stGround = iota
	stEsc
	stEscInter
	stCSI
	stOSC
	stOSCEsc
	stString // DCS, SOS, PM, APC: skipped to the string terminator
	stStringEsc
)

func (t *textScanner) write(p []byte) {
	for _, b := range p {
		t.n++
		switch t.state {
		case stGround:
			t.ground(b)
		case stEsc:
			switch {
			case b == '[':
				t.state, t.param = stCSI, t.param[:0]
			case b == ']':
				t.state, t.osc = stOSC, t.osc[:0]
			case b == 'P' || b == 'X' || b == '^' || b == '_':
				t.state = stString
			case b >= 0x20 && b <= 0x2f:
				t.state = stEscInter
			default:
				t.state = stGround
			}
		case stEscInter:
			if b < 0x20 || b > 0x2f {
				t.state = stGround
			}
		case stCSI:
			switch {
			case b >= 0x40 && b <= 0x7e:
				t.state = stGround
				// Erase in line: "\r\x1b[2K" redraws a progress line.
				if b == 'K' && (string(t.param) == "2" || t.cr) {
					t.line = t.line[:0]
				}
			case len(t.param) < 32:
				t.param = append(t.param, b)
			}
		case stOSC:
			switch b {
			case 0x07:
				t.endOSC()
			case 0x1b:
				t.state = stOSCEsc
			default:
				if len(t.osc) < 4096 {
					t.osc = append(t.osc, b)
				}
			}
		case stOSCEsc:
			t.endOSC()
			if b != '\\' {
				t.state = stEsc
				t.n-- // counted again
				t.write([]byte{b})
			}
		case stString:
			if b == 0x1b {
				t.state = stStringEsc
			} else if b == 0x07 {
				t.state = stGround
			}
		case stStringEsc:
			t.state = stGround
			if b != '\\' {
				t.state = stString
			}
		}
	}
}

func (t *textScanner) ground(b byte) {
	switch {
	case b == 0x1b:
		t.state = stEsc
	case b == '\n':
		t.emit()
	case b == '\r':
		t.cr = true
	case b == '\b':
		if n := len(t.line); n > 0 {
			// Back over a whole UTF-8 character.
			i := n - 1
			for i > 0 && t.line[i]&0xc0 == 0x80 {
				i--
			}
			t.line = t.line[:i]
		}
	case b < 0x20 && b != '\t':
	default:
		if t.cr {
			t.line, t.cr = t.line[:0], false
		}
		if len(t.line) < maxLine {
			t.line = append(t.line, b)
		}
	}
}

func (t *textScanner) emit() {
	s := strings.TrimRight(string(t.line), " \t")
	t.line, t.cr = t.line[:0], false
	if t.onLine != nil {
		t.onLine(s)
	}
}

func (t *textScanner) endOSC() {
	t.state = stGround
	if t.onOSC != nil {
		t.onOSC(string(t.osc))
	}
}

// partial is the line in progress, if any.
func (t *textScanner) partial() string { return strings.TrimRight(string(t.line), " \t") }

// plainLines turns raw output into its lines of plain text.
func plainLines(raw []byte) []string {
	var lines []string
	t := textScanner{onLine: func(s string) { lines = append(lines, s) }}
	t.write(raw)
	if p := t.partial(); p != "" {
		lines = append(lines, p)
	}
	return lines
}

var localURL = regexp.MustCompile(`https?://(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|[a-zA-Z0-9-]+\.local)(?::\d{1,5})?(?:/[^\s"'<>]*)?`)

// localURLs finds URLs on this machine in a line, as a browser should open
// them.
func localURLs(line string) []string {
	var out []string
	for _, u := range localURL.FindAllString(line, -1) {
		u = strings.TrimRight(u, ".,;:)]}")
		u = strings.Replace(u, "://0.0.0.0", "://localhost", 1)
		u = strings.Replace(u, "://[::]", "://localhost", 1)
		out = append(out, u)
	}
	return out
}
