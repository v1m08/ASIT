import { EventEmitter } from 'events'

// Tiny in-process pub/sub so services can announce things without importing
// each other (todos → companion would otherwise be an import cycle).
//
// Events:
//   'changed'  (what: 'todos' | 'activity' | 'jobs')   — phone UI refresh hints
//   'notify'   ({ title, body, tag? })                  — phone push notification
//   'chat-done'({ taskId, title })                      — a chat turn finished
export const bus = new EventEmitter()
bus.setMaxListeners(30)
