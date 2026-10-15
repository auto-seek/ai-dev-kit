# Subtraction Log

Each `/ai-dev-kit-clean` pass appends one line here recording the date and the
HEAD commit it cleaned up to. For the branch being checked, the preflight/merge
gate uses the newest record whose `branch:` matches and whose `commit:` is an
ancestor of HEAD to measure subtraction debt — commits since that clean — and
fails when it exceeds the threshold (default 10). Records for other branches
do not count. Do not delete past entries.

Format:

```text
- YYYY-MM-DD | commit: <40-hex-sha> | branch: <branch> | scope: <scope> | mode: <propose|assisted|sweep>
```

A pass that found nothing to remove is recorded the same way, with `(none)` in
the scope and the mode left unchanged:

```text
- YYYY-MM-DD | commit: <40-hex-sha> | branch: <branch> | scope: <base>..HEAD (none) | mode: propose
```
