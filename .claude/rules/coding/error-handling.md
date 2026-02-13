# Error Handling

Prefer async/await with explicit error handling.

- Avoid try/catch — it swallows errors and makes debugging more difficult
- Use Result/Either patterns or explicit error returns where possible
- Propagate errors explicitly rather than catching and silencing them

## Preferred Pattern

Return a result object instead of throwing or catching exceptions:

```
// Instead of try/catch:
result = await fetchUser(id)
if result.error:
    return { error: result.error }
return { data: result.data }
```

The result object should have two shapes:
- **Success**: `{ data: <value>, error: null }`
- **Failure**: `{ data: null, error: <error detail> }`

This keeps errors visible in the return type, forces callers to handle both cases, and avoids silent failures from caught exceptions.
