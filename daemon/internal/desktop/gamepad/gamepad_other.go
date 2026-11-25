//go:build !windows

package gamepad

import "errors"

var errUnsupported = errors.New("passing controllers through needs a Windows host for now")

// Available reports why controllers can't be plugged in, or nil if they can.
func Available() error { return errUnsupported }

// Bus is a session's virtual controllers.
type Bus struct{}

func Open(RumbleFunc) (*Bus, error) { return nil, errUnsupported }

func (*Bus) Set(int, State) error { return errUnsupported }
func (*Bus) Unplug(int)           {}
func (*Bus) Close()               {}
