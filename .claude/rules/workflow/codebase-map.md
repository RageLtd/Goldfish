# Codebase Map

When goldfish injects a codebase map at session start, prefer it over grepping/globbing for structural orientation:

- **Finding files**: Check the map first — it has directory summaries and file listings
- **Understanding structure**: Use `goldfish map:show` or `goldfish map:detail <dir>` instead of `find` or `ls -R`
- **Searching by purpose**: Use `goldfish map:search <query>` for semantic file discovery before falling back to grep

The map is a lightweight index (~200-400 tokens). Use grep/glob for exact string searches within files — the map is for navigating the project structure.
