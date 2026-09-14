import { useChatStore } from '@/stores/chatStore'

/** Apply the authoritative backend transition when a cooperative pause lands. */
export function handleSessionPausedEvent(sessionId: string): void {
  const store = useChatStore.getState()
  store.setPausing(sessionId, false)
  store.setPaused(sessionId, true)
  store.setTaskActive(sessionId, false)
  store.setActivityStatus(sessionId, 'Paused')
  // Pin the single live unfinished-task overlay to 'paused' so a STALE DB
  // snapshot (e.g. 'in_progress' loaded while the task was running) can never
  // outrank the real paused state on any status surface — the overlay is what
  // the surfaces read first.
  store.setUnfinishedTaskStatus(sessionId, 'paused')
}

/** Apply the authoritative backend transition when a paused session resumes. */
export function handleSessionResumedEvent(sessionId: string): void {
  const store = useChatStore.getState()
  store.setPausing(sessionId, false)
  store.setPaused(sessionId, false)
  // setTaskActive(true) also pins the live overlay to '' (a running session has
  // no unfinished task), superseding any stale 'paused'/'failed' snapshot.
  store.setTaskActive(sessionId, true)
  store.setActivityStatus(sessionId, 'Resuming...')
}
