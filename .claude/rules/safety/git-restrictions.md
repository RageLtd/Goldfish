# Git Restrictions

- Never force-push (`--force`, `--force-with-lease`) without explicit approval
- Never run `git reset --hard`, `git clean -f`, or `git checkout .` without explicit approval
- Never amend published commits without explicit approval
- Never push to main/master directly — use feature branches
- Prefer staging specific files over `git add -A` or `git add .`
