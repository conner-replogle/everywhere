package term

// Command is what Spawn starts.
type Command struct {
	Dir string
	// Command is run by the user's shell; "" starts the shell itself,
	// interactive.
	Command string
	// Args, if set, is a program and its arguments, run directly rather
	// than by the shell; Command is then ignored.
	Args []string
	// Env is added to the shell's environment. With Args it is the whole
	// environment (nil: the daemon's).
	Env        []string
	Cols, Rows uint16
}
