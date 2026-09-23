// Package config manages the daemon's on-disk configuration, credential and
// data locations.
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type Config struct {
	Server   string `json:"server"`
	DeviceID string `json:"deviceId"`
}

// ErrNotEnrolled is returned by Load when the device has never been enrolled.
var ErrNotEnrolled = errors.New("this device is not enrolled; generate an install command in the web UI")

// ConfigDir is ~/.config/everywhere, or $EVERYWHERE_HOME/config when set (used for tests).
func ConfigDir() string {
	if h := os.Getenv("EVERYWHERE_HOME"); h != "" {
		return filepath.Join(h, "config")
	}
	return filepath.Join(xdg("XDG_CONFIG_HOME", ".config"), "everywhere")
}

// DataDir is ~/.local/share/everywhere, or $EVERYWHERE_HOME/data when set.
func DataDir() string {
	if h := os.Getenv("EVERYWHERE_HOME"); h != "" {
		return filepath.Join(h, "data")
	}
	return filepath.Join(xdg("XDG_DATA_HOME", filepath.Join(".local", "share")), "everywhere")
}

func DBPath() string { return filepath.Join(DataDir(), "everywhere.db") }

func xdg(env, fallback string) string {
	if v := os.Getenv(env); v != "" {
		return v
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, fallback)
}

func configPath() string     { return filepath.Join(ConfigDir(), "config.json") }
func credentialPath() string { return filepath.Join(ConfigDir(), "credential") }

// Load returns the config and device credential.
func Load() (Config, string, error) {
	var cfg Config
	raw, err := os.ReadFile(configPath())
	if errors.Is(err, os.ErrNotExist) {
		return cfg, "", ErrNotEnrolled
	}
	if err != nil {
		return cfg, "", err
	}
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return cfg, "", fmt.Errorf("parse %s: %w", configPath(), err)
	}
	cred, err := os.ReadFile(credentialPath())
	if err != nil {
		return cfg, "", fmt.Errorf("read credential: %w", err)
	}
	return cfg, strings.TrimSpace(string(cred)), nil
}

// Save writes the config and credential (0600).
func Save(cfg Config, credential string) error {
	if err := os.MkdirAll(ConfigDir(), 0o700); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(configPath(), append(raw, '\n'), 0o600); err != nil {
		return err
	}
	return os.WriteFile(credentialPath(), []byte(credential+"\n"), 0o600)
}

// Remove deletes config and data directories.
func Remove() error {
	return errors.Join(os.RemoveAll(ConfigDir()), os.RemoveAll(DataDir()))
}
