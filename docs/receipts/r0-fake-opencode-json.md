# R0 receipt: built OpenCode JSON adapter

A versioned local OpenCode-format JSON fixture reaches `dist/providers/opencode.js`
through a real child process. It requires no account, quota, or network. The optional
`binArgs` prefix defaults empty, preserving production launches; rollback is a revert.
OpenCode native session-ID preservation is not asserted or claimed by this framing slice.
The fixture also proves stderr plus nonzero exit becomes one typed auth error before
substantive output, never a fabricated done; no auth probing claim is made.
