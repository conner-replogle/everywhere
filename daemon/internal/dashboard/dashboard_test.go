package dashboard

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func write(t *testing.T, path, s string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(s), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestBuild(t *testing.T) {
	work := t.TempDir()
	dir, err := Dir(work, "train")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Dir(work, "../x"); err == nil {
		t.Fatal("a name with .. is a path")
	}
	b := NewBuilder()
	if r := b.Build(dir); len(r.Errors) == 0 {
		t.Fatal("built a dashboard that isn't there")
	}

	write(t, filepath.Join(dir, "index.tsx"), `
import { useState } from "react";
import { Card, LineChart, useEvents } from "everywhere";
import { smooth } from "./util";
import "./style.css";
export default function Dashboard() {
  const [n] = useState(3);
  const loss = useEvents<{ step: number; loss: number }>("loss");
  return <Card title="Loss"><LineChart series={[{ key: "loss", points: smooth(loss.map((e) => [e.data.step, e.data.loss]), n) }]} /></Card>;
}`)
	write(t, filepath.Join(dir, "util.ts"), `export const smooth = (p: [number, number][], _n: number) => p;`)
	write(t, filepath.Join(dir, "style.css"), `.x { color: red }`)
	r := b.Build(dir)
	if len(r.Errors) > 0 {
		t.Fatalf("errors: %v", r.Errors)
	}
	if !strings.Contains(r.JS, `__everywhere.modules["everywhere"]`) || !strings.Contains(r.JS, `__everywhere.modules["react/jsx-runtime"]`) {
		t.Fatalf("provided modules bundled instead of taken from the frame:\n%s", r.JS)
	}
	if !strings.Contains(r.JS, "var __dashboard") || !strings.Contains(r.CSS, "color: red") {
		t.Fatalf("js %q css %q", r.JS[:80], r.CSS)
	}
	if b, err := os.ReadFile(filepath.Join(work, Root, "types", "everywhere.d.ts")); err != nil || string(b) != Types {
		t.Fatal("types not written")
	}
	if again := b.Build(dir); again.Version != r.Version {
		t.Fatal("unchanged files built a new version")
	}

	time.Sleep(10 * time.Millisecond)
	write(t, filepath.Join(dir, "util.ts"), `export const smooth = (p: [number, number][]) => p.map(;`)
	r2 := b.Build(dir)
	if r2.Version == r.Version || len(r2.Errors) == 0 || !strings.HasPrefix(r2.Errors[0], "util.ts:1:") {
		t.Fatalf("syntax error: %+v", r2)
	}
}
