## ADDED Requirements

### Requirement: Arm an isolated file-ingestion intent
The plugin SHALL create a time-limited file-ingestion intent when a user issues the file-ingestion command, and SHALL isolate that intent by OpenClaw account, conversation session, and sender.

#### Scenario: User arms file ingestion
- **WHEN** a user sends the file-ingestion command in a supported Feishu conversation
- **THEN** the plugin stores an intent that expires after the configured TTL and asks that user to send one file

#### Scenario: Another user sends a file
- **WHEN** a different sender posts a file in the same conversation while an intent is active
- **THEN** the plugin does not consume the active user's intent and does not submit that file for ingestion

#### Scenario: User cancels or intent expires
- **WHEN** the user cancels file ingestion or the TTL elapses before a valid file arrives
- **THEN** the plugin clears the intent and no later file is submitted under it

### Requirement: Submit exactly one intended file
The plugin SHALL consume an active intent atomically for one valid document file and SHALL upload the file bytes and source metadata to Knowledge Bridge with a deterministic requestId.

#### Scenario: Matching file is received
- **WHEN** the same sender and session provide one file with an accessible OpenClaw media path before expiry
- **THEN** the plugin claims the message, streams the file using multipart, and reports the returned taskId

#### Scenario: Duplicate delivery is observed
- **WHEN** OpenClaw delivers the same file message or hook more than once
- **THEN** the plugin uses the same requestId and Knowledge Bridge observes one logical ingestion request

#### Scenario: Media download is unavailable
- **WHEN** a media placeholder is present but no readable media path exists
- **THEN** the plugin does not upload placeholder text and reports a file-download failure

### Requirement: Preserve ordinary file behavior
The plugin SHALL leave file messages without a matching active intent unclaimed and SHALL exclude media placeholders from automatic candidate ingestion.

#### Scenario: Ordinary file is posted
- **WHEN** a file arrives without a matching active ingestion intent
- **THEN** the plugin creates no ingestion task and allows OpenClaw's normal handling to continue

#### Scenario: Candidate ingestion sees media placeholder
- **WHEN** the automatic candidate hook receives document or media placeholder text
- **THEN** the plugin skips candidate creation for that message

### Requirement: Report asynchronous ingestion outcome
The plugin SHALL reuse task status polling to notify the originating Feishu conversation of completion, failure, or polling timeout.

#### Scenario: Backend completes indexing
- **WHEN** the submitted task reaches COMPLETED
- **THEN** the plugin sends a completion notification to the original conversation

#### Scenario: Backend reports failure
- **WHEN** the submitted task reaches FAILED with an error
- **THEN** the plugin sends a failure notification containing a safe user-facing reason
