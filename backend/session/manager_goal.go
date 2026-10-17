package session

// SetGoalProposalResolver installs the callback that delivers a user decision
// to a blocked goal-proposal channel. Desktop wires this after
// buildGoalProposalCallback registers its pending map. Without it,
// ResolveGoalProposal is a no-op (and the event-based path is the only
// resolution route).
func (m *Manager) SetGoalProposalResolver(fn func(requestID, decision, condition, verify, verificationMode string) bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.goalProposalResolver = fn
}

// ResolveGoalProposal delivers a user decision on a pending goal proposal.
// decision is "approve" or "cancel". condition/verify carry the
// (possibly edited) approved values; verificationMode carries the (possibly
// edited) per-goal verification mode for the approve path. Returns true when a
// pending proposal was found and resolved, false otherwise (including when no
// resolver is wired).
func (m *Manager) ResolveGoalProposal(requestID, decision, condition, verify, verificationMode string) bool {
	m.mu.RLock()
	fn := m.goalProposalResolver
	m.mu.RUnlock()
	if fn == nil {
		return false
	}
	return fn(requestID, decision, condition, verify, verificationMode)
}

// SetGoalSuggestionResolver installs the callback that delivers a user
// decision to a blocked goal-suggestion channel. Desktop wires this after its
// pending-suggestion map is ready. Without it, ResolveGoalSuggestion is a
// no-op (and the event-based path is the only resolution route).
func (m *Manager) SetGoalSuggestionResolver(fn func(requestID, decision string) bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.goalSuggestionResolver = fn
}

// ResolveGoalSuggestion delivers a user decision on a pending goal-mode
// suggestion. decision is "accept" or "decline". Returns true when a pending
// suggestion was found and resolved, false otherwise (including when no
// resolver is wired).
func (m *Manager) ResolveGoalSuggestion(requestID, decision string) bool {
	m.mu.RLock()
	fn := m.goalSuggestionResolver
	m.mu.RUnlock()
	if fn == nil {
		return false
	}
	return fn(requestID, decision)
}
