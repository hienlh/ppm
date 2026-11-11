---
trigger: always_on
---

# Commands that run longer than 10 seconds (Gradle, a whole test suite, a build)

Never end your turn while a command you started is still running. Ending the turn with "I'll report when it finishes" fails the task: in a spec run, PPM marks a task chat that stays idle for 20 s as failed, and you get no further turn to finish it.

`run_command` waits at most 10 s (`WaitMsBeforeAsync`), so a longer command goes to the background. Run it so you can watch it yourself:

1. Start it detached, writing to a log in `/tmp`, and note the exit code there:

       (./gradlew :app:testDebugUnitTest --tests 'X' > /tmp/<task>-gradle.log 2>&1; echo "EXIT=$?" >> /tmp/<task>-gradle.log) &

2. Then poll in short steps, each well under 10 s, until the `EXIT=` line appears:

       sleep 8; tail -5 /tmp/<task>-gradle.log

3. Read the result from the log, and only then go on or call `task_done`.

Use a log name of your own (your task number). Other task chats run beside you in the same repository.

Why: on 2026-11-10 a spec task chat backgrounded `./gradlew`, ended its turn with "running the tests, will report", and PPM marked the task failed with its work left uncommitted.
