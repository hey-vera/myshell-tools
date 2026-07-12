# R0 receipt: built Codex timeout truthfulness

The versioned local fake Codex CLI has a no-terminal-output timeout scenario. Through
`dist/providers/codex.js`, it must settle with one typed timeout error and never a done
event. This is deterministic, uses no credentials/network/quota, and changes no runtime
production behavior unless the test exposes a defect. It has no migration impact; rollback
is reverting the fixture and assertion. It does not prove catalog drift, other adapters,
or packed-artifact behavior.
