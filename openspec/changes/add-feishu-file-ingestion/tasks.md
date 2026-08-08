## 1. File Intent State

- [x] 1.1 Add configuration and types for file-ingestion commands, intent TTL, media context, and multipart responses
- [x] 1.2 Implement isolated in-memory intent arm, cancel, expiry, and atomic consume behavior

## 2. OpenClaw Message Handling

- [x] 2.1 Add `reply_dispatch` handling for file commands and matching single-file media messages
- [x] 2.2 Validate media paths, derive deterministic requestIds, claim intended files, and preserve ordinary file behavior
- [x] 2.3 Exclude media placeholder messages from automatic candidate ingestion

## 3. Knowledge Bridge Transport

- [x] 3.1 Add authenticated multipart file upload to `KbBridgeClient` without exposing local paths
- [x] 3.2 Reuse task polling and originating conversation delivery for file task terminal states

## 4. Verification

- [x] 4.1 Add tests for intent isolation, cancellation, expiry, duplicate messages, missing media, and ordinary files
- [x] 4.2 Add multipart client and status-notification tests, then run plugin build/check/test validation
