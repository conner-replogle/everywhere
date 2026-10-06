package term

// Command is what Spawn starts.
type Command struct {
	Dir string
	// Command is run by the user's shell; "" starts the shell itself,
	// interactive.
	Command string
	// Env is added to the shell's environment.
	Env        []string
	Cols, Rows uint16
}
