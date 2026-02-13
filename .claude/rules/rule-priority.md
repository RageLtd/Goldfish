# Rule Priority

When rules conflict, follow this priority order (highest first):

1. **Safety** — security, secrets, destructive action guards
2. **Quality** — test coverage, security review, quality gates
3. **Workflow** — plan-first, stop conditions, approvals
4. **Code style** — functional patterns, error handling, minimal changes

A lower-priority rule never overrides a higher one. For example, "keep changes minimal" does not justify skipping test coverage — quality outranks code style.

When two rules at the same level conflict, prefer the more specific rule over the general one.
