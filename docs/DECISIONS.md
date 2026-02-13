# Decision Records

Non-trivial technical decisions for this project.

## 2026-02-12: Smarter Memory Retrieval — Unified Scoring Pool

**Context:** Cross-project context retrieval needed a strategy for mixing observations from different projects.

**Options considered:**
1. Separate pools per project with hard caps on cross-project items
2. Unified scoring pool where all projects compete equally
3. Weighted pools with configurable cross-project ratio

**Chosen:** Option 2 — unified scoring pool with same-project bonus as tiebreaker.

**Rationale:** Simplest model. A small additive bonus (0.1) for same-project observations is enough to prefer local context when scores are close, but a highly relevant cross-project observation still surfaces naturally. No hard caps means no arbitrary cutoffs.

**References:** `docs/plans/2026-02-12-smarter-memory-retrieval-design.md`

## 2026-02-12: Jaccard Similarity Threshold at 0.8

**Context:** Observation deduplication needs a similarity threshold to determine when two observations are "the same."

**Options considered:**
1. 0.5 threshold (catches loose duplicates, more aggressive)
2. 0.8 threshold (requires high word overlap)
3. Exact title match only

**Chosen:** Option 2 — Jaccard > 0.8.

**Rationale:** 0.8 requires ~80% word overlap, which catches near-duplicates (e.g., reworded titles from the same tool observation) without false-positive dedup on legitimately different observations. 0.5 was too aggressive in testing.

## 2026-02-12: Result Pattern Over try/catch

**Context:** Error handling strategy for the codebase.

**Options considered:**
1. Standard try/catch with thrown exceptions
2. Result<T, E> type with explicit ok/err returns

**Chosen:** Option 2 — Result type (`src/types/result.ts`).

**Rationale:** Makes error paths visible in type signatures. Forces callers to handle both cases. Prevents silent swallowing of errors. Aligns with functional programming style.
