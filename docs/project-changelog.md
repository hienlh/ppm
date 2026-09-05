# PPM Project Changelog

**The changelog lives at [`../CHANGELOG.md`](../CHANGELOG.md).** That file is the one the release
process updates (see the release steps in `CLAUDE.md` and `deployment-guide.md`), and the one
published with each npm release.

This file previously held a second, hand-maintained copy. It fell six versions behind — its last
entry was v0.13.0 while releases had reached v0.18.x — and it still carried an "Unreleased" section
listing features that had long since shipped. A changelog that disagrees with the real one is worse
than no changelog, so the duplicate is gone rather than being repaired.

The old entries remain in git history if you need them:

```bash
git log --follow -p -- docs/project-changelog.md
```

## Where to look

| Question | Source |
|---|---|
| What changed in a release? | [`CHANGELOG.md`](../CHANGELOG.md) |
| What is shipped vs still open? | [`project-roadmap.md`](project-roadmap.md) |
| Why was something built this way? | [`project-overview-pdr.md`](project-overview-pdr.md) |
| What trap already cost us time? | [`lessons-learned.md`](lessons-learned.md) |
