package desktop

import (
	"testing"
)

func client(id, class, title string, mon int) hyprClient {
	c := hyprClient{Address: "0x" + id, Mapped: true, StableID: id, Class: class, Title: title, Monitor: mon}
	c.Workspace.Name = "1"
	return c
}

func TestResolveWindow(t *testing.T) {
	cs := []hyprClient{client("1", "foot", "shell", 0), client("2", "zen", "Docs", 0), client("3", "zen", "Mail", 0)}
	cs[0].Mapped = false
	for _, tc := range []struct {
		want source
		id   string
	}{
		{source{Window: "3"}, "3"},
		{source{Window: "9", Class: "zen", Title: "Docs"}, "2"},  // reopened: same app and title
		{source{Window: "9", Class: "zen", Title: "Other"}, "2"}, // same app
		{source{Window: "1"}, ""},                                // unmapped
		{source{Window: "9", Class: "gimp"}, ""},
	} {
		got := resolveWindow(cs, tc.want)
		if (got == nil && tc.id != "") || (got != nil && got.StableID != tc.id) {
			t.Errorf("resolveWindow(%+v) = %+v, want %q", tc.want, got, tc.id)
		}
	}
}

func TestWindowToMonitor(t *testing.T) {
	// A 2256x1504 monitor at scale 1.333 is 1692x1128 logical, placed at
	// x=10048; the window fills its right half.
	mon := hyprMonitor{Name: "eDP-1", X: 10048, Width: 2256, Height: 1504, Scale: 4.0 / 3}
	c := client("1", "foot", "", 0)
	c.At, c.Size = [2]int{10048 + 846, 0}, [2]int{846, 1128}
	g := newWindowGeom(&c, mon)
	for _, tc := range []struct{ x, y, wantX, wantY uint16 }{
		{0, 0, 32768, 0},
		{65535, 65535, 65535, 65535},
		{32768, 32768, 49152, 32768},
	} {
		x, y := g.toMonitor(tc.x, tc.y)
		if d := int(x) - int(tc.wantX); d < -2 || d > 2 || y != tc.wantY {
			t.Errorf("toMonitor(%d, %d) = %d, %d; want %d, %d", tc.x, tc.y, x, y, tc.wantX, tc.wantY)
		}
	}
}

func TestWindowInfosOrder(t *testing.T) {
	a, b, c := client("1", "zen", "", 0), client("2", "foot", "", 0), client("3", "spotify", "", 0)
	a.Workspace.Name, b.Workspace.Name, c.Workspace.Name = "10", "2", "special:music"
	infos := windowInfos([]hyprClient{a, b, c}, []hyprMonitor{{ID: 0, Name: "DP-1"}}, "0x2")
	if len(infos) != 3 || infos[0].ID != "2" || infos[1].ID != "1" || infos[2].ID != "3" {
		t.Fatalf("order %+v", infos)
	}
	if !infos[0].Focused || infos[0].Monitor != "DP-1" {
		t.Fatalf("first %+v", infos[0])
	}
}
