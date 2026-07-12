# R0 receipt: structured subprocess versus protocol failure

The versioned local fake Codex CLI distinguishes two deterministic failure surfaces
through `dist/providers/codex.js`: stderr plus nonzero exit is classified as adapter
authentication failure, while a zero-exit JSONL `error` record is classified by the
Codex protocol parser. No credentials, network calls, live quota, or state migration
are involved; the only runtime change is preservation of the protocol error detail.
Roll back by reverting the fixture, parser correction, and integration assertion.

The built-path assertion exposed that unknown JSONL protocol errors lost their provider
message in `createCodexParser`. The smallest correction preserves that structured message
while retaining the existing error category and recovery policy. It does not alter
subprocess stderr classification or `turn.failed`, which has no matching failure evidence
in this slice.

The fixture version is encoded in its synthetic JSONL message. This slice does not claim
auth probing, catalog drift, other provider protocols, or packed-artifact coverage.
