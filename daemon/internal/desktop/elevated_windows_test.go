package desktop

import (
	"encoding/xml"
	"strings"
	"testing"
)

func TestElevatedTaskXML(t *testing.T) {
	s := elevatedTaskXML(`C:\Program Files\everywhere\everywhere-desktop.exe`, `PC\A&B`)
	var task struct {
		Principals struct {
			Principal struct {
				UserId, LogonType, RunLevel string
			}
		}
		Actions struct {
			Exec struct{ Command, Arguments string }
		}
	}
	// encoding/xml won't decode a UTF-16 declaration; the body is the same.
	if err := xml.Unmarshal([]byte(strings.Replace(s, "UTF-16", "UTF-8", 1)), &task); err != nil {
		t.Fatal(err)
	}
	p := task.Principals.Principal
	if p.UserId != `PC\A&B` || p.RunLevel != "HighestAvailable" || p.LogonType != "InteractiveToken" {
		t.Fatalf("principal %+v", p)
	}
	if got, want := task.Actions.Exec.Arguments, `--headless "C:\Program Files\everywhere\everywhere-desktop.exe" elevated`; got != want {
		t.Fatalf("arguments %q, want %q", got, want)
	}
}
