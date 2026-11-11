---
trigger: always_on
---

# Before calling a task done in `../ppm-android`

A task is done only when every module it touched builds and its tests run green. Before `task_done`:

1. Run the unit tests of every module you changed, not only the one holding your new test. If you changed anything under `app/`, that is `./gradlew :app:testDebugUnitTest` (start it as `long-commands.md` says and watch the log).
2. Read the log. `BUILD FAILED`, any `e:` line, or a test that did not run is not done. Your new tests must appear in `app/build/test-results` (or the module's) with no failure.
3. Write every JVM test the task names ("Test JVM: `XTest`") and do everything its description lists, on every layout it names (phone and tablet). Do not change files outside the task's _Files:_ line.
4. Commit your files (`shared-repo-commits.md`) before `task_done`. Uncommitted work is not done.
5. In the `task_done` summary, name the Gradle command you ran, the line that says it passed, and the commit hash.

On 2026-11-11 task 14 called `task_done` after 2 minutes with an 8-line file, no test, no Gradle run and no commit; it was reset and run again.

Compose tests in `app` use the shared rule, not a bare `createComposeRule()`:

    private val composeRule = createComposeRule()

    @get:Rule
    val rules: RuleChain = withComposeActivity(composeRule)

and wrap content in `PpmThemeProvider(theme = BuiltInThemes.auroraDark, mobile = …)`. Call `setContent` once per test; change state to show a second state.

Why: on 2026-11-10 task 7 was reported done while `app` did not compile (a top-level name clashed with an existing one in the same package) and its two test files had never been compiled.
