package ipc

import (
	"bytes"
	"testing"
)

func TestConfigRoundTrip(t *testing.T) {
	var b bytes.Buffer
	cfg := []byte(`{"Output":"DISPLAY1","Input":true}`)
	if err := WriteConfig(&b, cfg); err != nil {
		t.Fatal(err)
	}
	b.WriteString("K") // a command follows the config on the same connection
	got, err := ReadConfig(&b)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, cfg) {
		t.Fatalf("got %q, want %q", got, cfg)
	}
	if rest := b.String(); rest != "K" {
		t.Fatalf("ReadConfig read past the config: %q left", rest)
	}
}

func TestReadConfigTooLarge(t *testing.T) {
	if _, err := ReadConfig(bytes.NewReader([]byte{0, 0, 0, 0x10})); err == nil {
		t.Fatal("a 256 MiB config was accepted")
	}
}
