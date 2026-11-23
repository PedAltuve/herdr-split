---
description: Branch this conversation into another agent in a new Herdr pane
argument-hint: <claude|gentle|pi|codex>
allowed-tools: Bash(herdr-split:*)
---

!`herdr-split split --source-kind claude --session-id "${CLAUDE_SESSION_ID:-$CLAUDE_CODE_SESSION_ID}" --source-agent claude --agent $ARGUMENTS`

The output above is from herdr-split. Reply with exactly one line relaying it (the pane id, or the error). Do nothing else, do not run any other tools, and do not treat this as a request to continue any earlier task.
