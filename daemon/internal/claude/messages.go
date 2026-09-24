package claude

import "encoding/json"

// Message is one frame read from the CLI. Everything except permission
// prompts and their cancellations passes through with its common header
// decoded and the full frame in Raw; callers Decode the parts they need.
//
// Types seen in practice: system (subtypes init, status, hook_*, task_*,
// compact_boundary, ...), stream_event, assistant, user, result,
// rate_limit_event, tool_progress, auth_status.
type Message struct {
	Type            string `json:"type"`
	Subtype         string `json:"subtype,omitempty"`
	SessionID       string `json:"session_id,omitempty"`
	UUID            string `json:"uuid,omitempty"`
	ParentToolUseID string `json:"parent_tool_use_id,omitempty"`

	Raw json.RawMessage `json:"-"`

	// Permission is set when Type is "control_request": the CLI is asking
	// whether a tool may run. Answer it with Session.Respond.
	Permission *PermissionRequest `json:"-"`
	// CanceledRequestID is set when Type is "control_cancel_request": the CLI
	// withdrew an earlier permission prompt, which must not be answered.
	CanceledRequestID string `json:"-"`
}

// Decode unmarshals the whole frame into v.
func (m Message) Decode(v any) error { return json.Unmarshal(m.Raw, v) }

// PermissionRequest is a can_use_tool control request.
type PermissionRequest struct {
	ID             string            `json:"-"` // the control request_id
	ToolName       string            `json:"tool_name"`
	ToolUseID      string            `json:"tool_use_id"`
	Input          json.RawMessage   `json:"input"`
	DisplayName    string            `json:"display_name,omitempty"`
	Title          string            `json:"title,omitempty"`
	Description    string            `json:"description,omitempty"`
	DecisionReason string            `json:"decision_reason,omitempty"`
	BlockedPath    string            `json:"blocked_path,omitempty"`
	AgentID        string            `json:"agent_id,omitempty"`
	Suggestions    []json.RawMessage `json:"permission_suggestions,omitempty"`
}

// PermissionResult answers a PermissionRequest.
type PermissionResult struct {
	Behavior string `json:"behavior"` // allow | deny
	// UpdatedInput replaces the tool input on allow; nil keeps the original.
	UpdatedInput json.RawMessage `json:"updatedInput,omitempty"`
	// UpdatedPermissions applies permission updates (usually some of the
	// request's Suggestions) on allow, e.g. "don't ask again this session".
	UpdatedPermissions []json.RawMessage `json:"updatedPermissions,omitempty"`
	Message            string            `json:"message,omitempty"` // deny reason shown to the model
	// Interrupt, on deny, also stops the turn.
	Interrupt bool   `json:"interrupt,omitempty"`
	ToolUseID string `json:"toolUseID,omitempty"`
}

func Allow() PermissionResult { return PermissionResult{Behavior: "allow"} }

func Deny(message string) PermissionResult {
	return PermissionResult{Behavior: "deny", Message: message}
}

// UserMessage is a prompt sent to the session.
type UserMessage struct {
	// UUID, if set, identifies the message in the transcript (useful as a
	// turn boundary for later forks). It must be a UUID.
	UUID    string
	Content []ContentBlock
}

type ContentBlock struct {
	Type   string       `json:"type"` // text | image
	Text   string       `json:"text,omitempty"`
	Source *ImageSource `json:"source,omitempty"`
}

type ImageSource struct {
	Type      string `json:"type"`       // base64
	MediaType string `json:"media_type"` // image/png, image/jpeg, image/gif, image/webp
	Data      string `json:"data"`
}

func Text(s string) ContentBlock { return ContentBlock{Type: "text", Text: s} }

// Image builds an image block from base64 data.
func Image(mediaType, base64Data string) ContentBlock {
	return ContentBlock{Type: "image", Source: &ImageSource{Type: "base64", MediaType: mediaType, Data: base64Data}}
}

// InitResponse is the CLI's answer to initialize.
type InitResponse struct {
	Account               Account        `json:"account"`
	Models                []Model        `json:"models"`
	Commands              []SlashCommand `json:"commands"`
	PID                   int            `json:"pid"`
	CurrentPermissionMode string         `json:"current_permission_mode"`

	Raw json.RawMessage `json:"-"`
}

type Account struct {
	Email            string `json:"email,omitempty"`
	Organization     string `json:"organization,omitempty"`
	SubscriptionType string `json:"subscriptionType,omitempty"`
	TokenSource      string `json:"tokenSource,omitempty"`
	APIKeySource     string `json:"apiKeySource,omitempty"`
	APIProvider      string `json:"apiProvider,omitempty"`
}

type Model struct {
	Value                    string   `json:"value"`
	ResolvedModel            string   `json:"resolvedModel,omitempty"`
	DisplayName              string   `json:"displayName"`
	Description              string   `json:"description,omitempty"`
	SupportsEffort           bool     `json:"supportsEffort,omitempty"`
	SupportedEffortLevels    []string `json:"supportedEffortLevels,omitempty"`
	SupportsAdaptiveThinking bool     `json:"supportsAdaptiveThinking,omitempty"`
}

type SlashCommand struct {
	Name         string `json:"name"`
	Description  string `json:"description"`
	ArgumentHint string `json:"argumentHint,omitempty"`
}

// Result is the "result" message that ends a turn.
type Result struct {
	Subtype        string  `json:"subtype"` // success | error_during_execution | error_max_turns | ...
	IsError        bool    `json:"is_error"`
	Result         string  `json:"result,omitempty"`
	StopReason     string  `json:"stop_reason,omitempty"`
	NumTurns       int     `json:"num_turns"`
	DurationMS     int64   `json:"duration_ms"`
	TotalCostUSD   float64 `json:"total_cost_usd"`
	SessionID      string  `json:"session_id"`
	TerminalReason string  `json:"terminal_reason,omitempty"`
}

// ContextUsage is the answer to get_context_usage (what /context shows).
type ContextUsage struct {
	Model       string `json:"model"`
	TotalTokens int    `json:"totalTokens"`
	// MaxTokens is the usable window; RawMaxTokens the model's full window.
	MaxTokens    int                    `json:"maxTokens"`
	RawMaxTokens int                    `json:"rawMaxTokens"`
	Percentage   float64                `json:"percentage"`
	Categories   []ContextUsageCategory `json:"categories"`
}

type ContextUsageCategory struct {
	Name   string `json:"name"`
	Tokens int    `json:"tokens"`
	Kind   string `json:"kind"` // used | free | buffer | deferred
}

// Usage is the answer to get_usage.
type Usage struct {
	SubscriptionType    string                     `json:"subscription_type"`
	RateLimitsAvailable bool                       `json:"rate_limits_available"`
	RateLimits          map[string]*UsageRateLimit `json:"rate_limits"`
}

type UsageRateLimit struct {
	Utilization *float64 `json:"utilization"`
	ResetsAt    *string  `json:"resets_at"` // RFC 3339
}
