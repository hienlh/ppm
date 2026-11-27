# PPM Assistant

> Part of [AI Chat & Providers](ai-chat-and-providers.md#ppm-assistant).

An AI chat that works *on PPM* rather than on a project: it sees the screen of the device the
user is chatting from, finds and reads chats, reads databases and open tabs, opens and closes
tabs, switches projects, runs Command Palette commands, and sends messages into the user's
working chats. It also runs those chats for the user: it says which ones are waiting on them,
opens new ones, answers their approval cards (after a confirmation), and reports when a chat it
was asked to watch finishes. The same conversation can be carried on from **Telegram**, which is
a second window onto one Assistant session ([Telegram](#telegram)). It runs on Claude and Codex.
It reads content it did not write — other chats, database rows, terminal output — so the design
rule is: **navigating and reading inside the registered projects run unasked; anything that
changes data or could carry data off the machine asks first**, whatever mode the composer shows.

It replaces PPMBot, the earlier Telegram "coordinator": that ran its own session in bypass mode
and delegated work by running `ppm bot delegate` in a shell, so nothing it did was ever asked.
The coordinator, the `ppm bot` CLI and task delegation are gone; the bot, its connected chats,
the connect link and the `clawbot` settings key were kept so nobody has to connect again.

## Sessions

**A virtual project.** Assistant sessions live in the reserved project `__assistant__`
(`src/shared/assistant-project.ts`). Only the chat path resolves it — the chat WebSocket and
the `/chat` sub-router, through `resolveChatProjectPath` (`src/server/helpers/resolve-chat-project.ts`)
— so it never gets a terminal, LSP root, git surface or file tree. `projectService` refuses to
register a real project under that name, and the browser keeps it out of URLs, the project
picker and workspace sync.

**The work directory** is `<ppm dir>/assistant/<database name>` (`assistant-work-dir.ts`), one
per database file, because dev (`ppm.dev.db`) and production (`ppm.db`) share the PPM dir and
both providers list a project's sessions by working directory. One shared folder would show each
instance's Assistant chats in the other's list.

**Marking a session.** `session_metadata.assistant` (migration 61) is written when the session
is created, and copied when Codex renames the session on its first turn and when a session is
forked. `isAssistantSession` (`src/services/assistant/assistant-session.ts`) answers true on the
mark of the id, the mark of the id it migrated to, *or* the session's working directory being
the Assistant's. Losing the answer is the dangerous direction — an Assistant session read as an
ordinary one falls back to the provider default, usually bypass — so any one source is enough.
Assistant sessions never adopt a warm spare and get no tab tools.

**Permissions** ignore the composer's mode, so an Assistant chat's composer shows no mode chip
(the window's Full/Ask chip is the control). Claude is forced to `default`, because the policy
lives in the PreToolUse hook and bypass mode installs no hook; `assistantToolDecision`
(`src/services/assistant/assistant-tool-policy.ts`) decides there, with the same check as a
`canUseTool` backstop. It allows only Read, Glob and Grep that resolve inside a registered
project (or PPM's own installed source, the public npm package — never offered for a compiled
binary, which has no `src`) and outside the private roots (`assistant-private-paths.ts`: PPM's own credential
folders, the login and key stores common tools keep under the home folder, and `/proc`, `/sys`
and `/dev` on Linux — `/dev` on macOS), ToolSearch, TodoWrite, and the Assistant's own MCP
tools by exact name. While the only registered project holding a path is the home folder or
one above it (`/` included), the home folder's application-state area — every dot-entry
(`.config`, `.local/share`, `.zsh_history`, `.pgpass`…), `Library`, and `AppData` on Windows —
counts as private too, because too many tools keep logins there for a list to cover; a project
registered inside that area (`~/.dotfiles`) reads its own tree as usual. A Glob or Grep whose
folder holds the home folder asks. Everything else asks: web, shell commands PPM cannot show only
read, writes, subagents, skills, other MCP servers, reads anywhere else. A target is judged as the
CLI will read it — trimmed, `~` expanded, `/c/…` taken as `C:` on Windows. It fails closed: a path
that cannot be resolved, a relative path with no working directory, or a Windows network path
(answered without touching the disk) asks.
Codex gets its own profile (below).

**Read-only commands, edits, and acting on its own** (`assistant-shell-decision.ts`, Settings →
PPM Assistant → General → Permissions; both switches are read on every tool call):
- *Run read-only commands without asking* (`auto_readonly_commands`, on by default). A Bash or
  PowerShell command runs with no card when PPM can show it only reads inside the read roots above
  (`src/services/assistant/readonly-shell/`). Bash goes through a lexer that rejects anything it
  does not fully understand (expansion, substitution, globs, redirection other than to
  `/dev/null`, escapes) and a per-program allowlist of flags (`readonly-command-specs.ts`,
  `readonly-git-spec.ts`, `readonly-tool-specs.ts`); PowerShell is parsed by PowerShell's own
  parser in a long-lived helper (`powershell-ast-helper.ts`) and the tree is judged against an
  allowlist of cmdlets, parameters, members and types. Unknown program, flag, node or member,
  a parse error, a timeout (5 s), a background run or a request to leave the sandbox: a card.
  Every path a command touches goes through the same rule as Read (`readonly-path-check.ts`),
  real path resolved, and a recursive walk also refuses a folder holding a private root. No
  working directory is trusted — the Assistant's starts inside the PPM dir and an earlier `cd`
  moves it unseen — so `git status` without `-C <project>` asks, and the instructions tell the
  Assistant to name the project. The result is badged "Read-only · ran without asking", and the
  session trace gets an `assistant_auto_allowed` row (tool, reason, call id, never the command).
  Codex: a command approval whose wrapper is exactly Codex's own (`/bin/bash -lc '<one word>'`,
  `"…\powershell.exe" -Command <script>`, the legacy `execCommandApproval` argv;
  `codex-assistant-command-unwrap.ts`) is unwrapped and judged the same way, and accepted with no
  card; Codex's own parse (`commandActions`) is never trusted; a network grant, extra permissions
  or input to a running terminal is a card.
- *Let the Assistant act on its own* (`act_on_own`, off by default, turned on through a
  confirmation). Off: Claude is not offered Edit, Write, MultiEdit or NotebookEdit
  (`disallowedTools`, fixed when the CLI starts — so turning it on reaches a session from its next
  start, and the hook still asks for an edit in a session started while it was on), and Codex's
  file changes are declined with no card. On, and only in a turn the user opened in PPM or on
  Telegram (`assistant-turn-provenance.ts`; a watch, wake, schedule, forwarded text or a turn the
  tracker never saw open does not count), the provider's own tools run with no card. Still asked:
  a Read/Glob/Grep/Edit/Write whose target is private, and a command whose *text* names a private
  root, `ppm*.db` or a `..` step (`commandMentionsPrivateRoot` — a tripwire, not a boundary: a
  glob or a variable can spell a private path; the read-only shortcut is the one that resolves
  paths). PPM's own endpoint cards (database writes, git, messages to chats that are not
  managers, `chat_answer_approval`) keep asking, unless Full mode (below) answers them. Codex turns carry their own `approvalPolicy` and
  `sandboxPolicy` on every `turn/start`: `untrusted` + `readOnly`, or under this switch in a
  user-started turn `on-request` + `workspaceWrite` with the registered projects as writable roots
  (`assistantWritableRoots`: canonical paths, minus any that is, sits in or holds a private root)
  and no network. Codex also keeps its own cwd (the Assistant's empty folder in the PPM dir) and
  the temp folder writable, which is why the Assistant's thread sets `project_doc_max_bytes = 0`:
  an `AGENTS.md` one steered turn left there is never read as instructions.
- Acting on its own (and Full mode below) still asks before a provider tool call that sends
  something off the machine or to other people (`assistant-outbound-action.ts`): a command whose
  text pushes, publishes, posts to GitHub, uploads over HTTP, logs in remotely or sends mail, and a
  tool of the user's own MCP server whose name does not start with a read verb (`list_`, `get-`,
  `search…`). A denylist over text, so a guard against the model's own mistakes, not a boundary.

**Full mode** (`permission_mode`, Settings → PPM Assistant → General → Permissions, and the
Full/Ask chip in the Assistant's head and window titlebar, `assistant-mode-button.tsx`; both ask
for confirmation before Full, go back to Ask in one press, and follow a change made on another
device through `assistant:permission-mode` on `/ws/global`). The user
asked for it as "like a chat in bypass mode, except that pushing, publishing and sending to others
still needs me" (ppm/42). `full` includes acting on its own (`assistantPolicySwitches` answers
`actOnOwn` for it, so Edit/Write, Codex's writable roots and the provider-tool rules follow), and
also lets PPM answer its **own** cards: in a turn the user opened in PPM or on Telegram, the
endpoint's asker (`approvalAskerFor`) and the session tools' create/message cards
(`collab-env.ts`) are approved without being shown when `assistant-full-mode.ts` says so. It does
not look at whether the turn has read outside text: the user chose to trust their own turns, and
the line against injected text is that a turn PPM started never acts. Still asked in Full mode:
- `git_sync` push, `public_link_set` on, `port_forward_start` over Cloudflare, and
  `chat_answer_approval` (another chat's request, which the user has not seen);
- a settings change the catalog marks `card` (security, permissions, trusted text, accounts, the
  Telegram bridge) and every install or removal (`settings_*`, below): the tool passes its reason
  as the ask's `alwaysAsk`, which `hardLimitReason` honours;
- `ui_run_command` for an extension's command (`ext:…`), which may post or publish like a user MCP
  tool;
- `db_query` writes, except on a connection listed in `db_write_connections` (ticked in the same
  pane; a read-only connection is never written through either way), and `db_connection_save` on
  a listed connection — the list is kept by id, so an edit could point it at another database;
- a tab or file in a private folder (`touchesPrivate` on the ask), and the vault's locked tiers,
  whose cards take a password and never pass through the asker;
- more than 10 cards in one turn or 30 in an hour across Assistant sessions: the next one is
  shown. A pair-limit or escalation card keeps asking too.
A turn PPM started (watch, wake, digest, restart news, a schedule) and a turn whose start the
tracker never saw are refused or asked exactly as in Ask mode. Every card Full mode answers is a
`assistant_auto_approved` row in the session trace (tool and input), beside the approvals the
user gave. The instructions gain a *Full mode* section (`ASSISTANT_FULL_MODE_SECTION`, fixed at the
session's start like the act-on-its-own one), and *Hand project work to project chats* now frames
the Assistant as a director's assistant who hands project work down even when it could do it
unasked. Absent `permission_mode` means not chosen and behaves as Ask: the choice is the "PPM has
new features" question `assistant-full-mode-2026-11`, the first feature intro that is a setting
rather than tool switches (`FeatureIntro.setting`); choosing in Settings or with the chip settles
it. Codex in Full mode is its act-on-its-own profile: no network, so a push asks there by
construction, and a sandbox escalation is still a Codex approval card.

**The UI.** One tab type, `assistant` (`src/web/components/assistant/`): on a desktop it opens
inside a `tab-host` floating window — portrait, top right, about 470×620, then wherever the user
left it — and below `md` it is a full-screen tab; it belongs to no project, so it comes onto
whichever grid is on screen. It opens from the Command Palette (*PPM Assistant*), the rail button
before Logs (whose red count is what waits on the user, and which minimizes a window in front),
the drawer tile, an unbound keybinding (`open-assistant`) and notifications, all through
`openAssistant`. The window's titlebar says "Assistant" with Working or Idle and a gear to
Settings → PPM Assistant, and its dock chip carries the waiting count: both come from
`floating-window/tab-window-extras-registry.ts`, keyed by the hosted tab's type, which is also
how a manager chat opened beside another project gets "Open in project". The counts are
`stores/assistant-waiting-store.ts`, fed by `assistant:waiting_changed`; nothing polls.

Inside: a chip row — Filter (a dropdown; a bottom sheet of 48 px rows on a phone), then one chip
per manager chat with its dot (working, waiting on you, idle) and waiting count — over one
stream, the main session's `ChatTab` with the cards placed among its messages by `created_at`
(`chat/chat-timeline-extension.ts` over the pure `lib/assistant-timeline-merge.ts`; the digest
folded to one line, a wake turn answered `[no reply]` to "Assistant read N reports"). A project
filter keeps that project's cards (fetched filtered, `stores/assistant-cards-store.ts`, the
choice this device's own) and the loaded turns in which the Assistant messaged or asked its
manager chat (`lib/assistant-stream-filter.ts`); while it is on, older history comes from
"Load earlier" only. Reply-to — a decision card's Reply, or Reply in a card's right-click or
long-press menu — stands where the composer is with a Telegram-style quote over the field
("↩ Replying to card", then "{project} · {title}", and ✕), posts to `/cards/:id/reply` instead
of the Assistant, and ends on send, Esc, ✕, a session or project switch; it is never stored.

**Waiting on you.** Every card still waiting (`WAITING_CARD_KINDS`, `status = open`) is drawn once,
whole, at its own place in the stream (`cards/waiting-stream-card.tsx`): its body unclipped, its one
row of buttons at its end, nothing sticky and no scroll box of its own, so a long card (a plan runs
to 1,500 characters) is read with the chat's own scrollbar. Waiting cards come from the waiting list
as well as from the loaded pages (`streamCards` in `use-assistant-stream-timeline.tsx`), and are
marked `keep`, so one older than the loaded history is drawn before the oldest loaded message
instead of being held back, and moves up to its own place once that page loads
(`placeTimelineItems`). On the left of the chat footer's context row (`ChatTab`'s `contextChip`, where
an ordinary chat shows its activity, changes and connection chips) one chip,
`assistant-waiting-cards.tsx`, in the footer chips' size and the connection chip's alert tint, says
"Waiting" with the red count and steps with ‹ "n/N" › (urgent first, then the oldest); it names no
card and no project. A press on it or an arrow scrolls the stream to that card and outlines it for
1.8 s. The jump is a store request (`stores/assistant-waiting-jump-store.ts`) that the Assistant body
answers (`use-waiting-card-jump.ts`): it scrolls only the list holding the card (`scrollIntoView`
would also move the floating window's frame and the app's panels; `lib/reveal-in-scroll-list.ts`) so
the whole card shows, or, for a card taller than the stream, its button row just above the footer,
clear of the message navigator in the list's corner. A new card moves the chip to itself without
moving the stream. Below `md` the chip is 26 px drawn with 44 px hit areas (an invisible `::after`,
as on the footer's other chips), and it disappears when nothing waits. A chip's red count on the
manager row (`focusWaitingCards`) jumps to that project's first card, and "Show" under a follow-up to
exactly that card, moving a filter that would hide it to that project. The chip follows the project
filter, and a "+N" on it clears the filter when cards of other projects wait. A card lays its
buttons out by its own width (`@container/card`): one row from 27rem, else the answers on one row
and Open chat / Dismiss on another, above them on a phone. A decision that no longer waits (a
`WAITING_CARD_KINDS` card answered, dismissed, resolved elsewhere or gone) folds to one line
in the stream (`cards/answered-card-fold.tsx`, a list row sized by its content): title, project, how it ended ("Chose …", "OK given
in PPM", "You replied in PPM", "Dismissed") and when, plus "manager answered" once a reply got its
answer. Such a card also shows, folded, one line of the reply ("You: …", `followUp.reply`) and at
most two lines of the answer ("Manager: …", or the new card it answered with), both as plain text
(`src/shared/plain-text-preview.ts`, built by `cards/answered-card-preview.ts`); a press opens the card whole and read-only (its status line, no buttons), scrolling just
enough to show its last line above the footer, a second press folds it, and which ones are open is kept by card id so a card re-placed among new messages stays
as it was. Reports that never asked anything (done, failed, digest, rules notes) are not folded
this way. Text of a card that no longer waits folds past eight lines behind "Show more"
(`CardText`); a waiting card and a draft are always shown whole, since OK approves exactly them. The list is `GET /api/assistant/cards/open`
(`stores/assistant-open-cards-store.ts`), built by `assistantCards.openCards()` — the same
function `waiting()` counts — so every red count has exactly its cards behind it; the store
follows `assistant:card` and refetches when an `assistant:waiting_changed` does not describe it.
A manager chat's own open reports are not in its stream, so they keep a bar above its composer
(`manager-chat-waiting-cards.tsx` over `waiting-cards-bar.tsx`, in `chat-tab.tsx`): one card at a
time in a box that scrolls, its button row stuck to the box's bottom (`CardStickyActionsContext`),
and on a phone one 44 px row that opens the card in a full-height sheet. It leaves out the chat's
approvals and questions, which the chat already shows as its own cards; there Reply opens the reply
bar under the card and "Open manager chat" is not offered. `chats_attention` lists the same cards first
(`assistantCards`: id, project, kind, title, when sent, whatever `since` says), and Telegram's
`/status` leads with them, so "nothing waits" is never said while one is open.

**The set of decisions.** Waiting decisions (`needs_decision` and `urgent`; approvals, questions,
held rules changes and the budget card are not in it) are answered together, in one form drawn the
way the chat's AskUserQuestion card is (`cards/decision-set/`, sharing `chat/question-form-parts.tsx`
with `question-card.tsx`): amber where the chat's question is blue, red for an urgent card's tab.
In the Assistant it is the stream's last item, drawn whole like every card (no scroll box of its own,
nothing sticky), and each decision keeps a one-line stub at its own place ("waiting in the set
below") that jumps to its tab; the Waiting chip, a red count and a follow-up's "Show" land on the
set the same way (`data-waiting-set` in `use-waiting-card-jump.ts`). A manager chat's bar shows the
set (its own decisions only) as one page among its other cards. One tab per card, in a stable order
(`nextTabOrder`: a new card goes to the end and never moves the tab shown); each card offers a
numbered tile per choice, one "OK, send this draft" tile naming the draft's hash, or one "OK, go
ahead" — none where the server does not show the card whole (`okOffered`) — and "Other", the user's
own words plus up to five pictures (pasted or attached, scaled like the composer's). "Send this one"
sends the card shown through its own route (`ok`, `choose`, `reply`); "Send all answered (n/m)"
first shows a review of every answer (a draft OK with its recipient, first line and hash; a reply to
a card over a day old marked as confirmed), then sends them one by one, so a card answered elsewhere
is skipped and named without stopping the rest (`lib/decision-set/`). A pick remembers the card as
picked (`cardVersion`: last change, draft hash, choices, `okOffered`) and is taken back with a word
on its tab if the card changes. A card that stops waiting while the set is open keeps its tab, ✓ when
sent from here and struck through otherwise, and leaves "Send all". Enter moves to the next card and
never sends; Ctrl+Enter (⌘+Enter) opens the review. Picks live in memory only
(`stores/decision-set-store.ts`), shared by the Assistant and a manager chat's bar. Telegram keeps
one message per card.

A chip or "Open manager chat" opens that chat in a window of its
own without switching project (`open-manager-chat.ts` over `lib/open-chat-in-window.ts`, which
every button opening another project's chat shares: a `projectId: null` tab placed straight into a
new window panel by `openTabInNewWindow`, never through a grid, and the project's slash cache
hydrated); on a phone it switches project and opens the chat as a tab whose "‹ Assistant"
goes back. A session other than the main one (a notification, Settings) shows "One-off session
· Back to main". The session list lives in Settings → PPM Assistant.

**The main session** (`assistant.main_session`, `src/services/assistant/assistant-main-session.ts`)
is the one Assistant session Telegram follows. It must be a Claude Assistant session; a Codex one
stays usable for one-off questions. PPM sets it by itself twice: when an Assistant session is
created on Claude and none is main (`chatService.createSession`), and at the first start of an
install that never had one (`pickMainSessionOnStartup`, from the hub's startup), which prefers the
session the most recently used Telegram chat talks to, then the most recently active Assistant
session. The key being *absent* is what marks "never had one": deleting the main session writes
`null`, and the next start leaves it so (Settings offers to start one, and the next Claude session
created takes it). `PUT /api/assistant/main-session {sessionId}` changes it and announces
`assistant:main_session_changed`; Telegram chats bound to the old main move with it, and chats
bound to a one-off session stay. An unbound Telegram chat binds to the main session; with none, it
starts a session on the Assistant's provider as before, which becomes main when that is Claude. A
settings save never writes the key, so a pane opened before a change cannot put the old one back.

**Settings.** Everything not needed every day lives in Settings → PPM Assistant
(`src/web/components/settings/assistant-settings-section.tsx`, sub-tabs in
`assistant-settings-tab-store.ts`; `openAssistantSettings(tab)` in `open-assistant-settings.ts`
lands on one; the window's gear opens the pane). Sub-tabs, in order:
- *General* — provider, model, name and personality (`assistant-persona-settings.tsx`), instructions,
  MCP servers (`assistant-general-settings.tsx`). Its
  Save leaves out the keys the other sub-tabs own (`KEYS_SAVED_ELSEWHERE` in
  `lib/assistant-settings-api.ts`); each of those saves through `patchAssistantSettings`, which
  reads the stored row and sends it back whole with only its own keys changed, so an older draft
  never puts a value back.
- *Sessions & Telegram* (`settings/assistant/`) — the main-session picker (Claude sessions only,
  `{title} · since {date}`, `PUT /main-session`), "New session" (`openAssistantNewSession`: a blank
  chat in the Assistant whose first message makes a one-off session), the session list with Open
  / Set as main session / Use on Telegram / Delete, and the Telegram block, which follows the main
  session.
- *Digest & quiet hours* — switch and time for each. There is no zone field: every save sends the
  browser's `Intl…timeZone`, and the zone in force is shown as text.
- *Manager chats* — one row per project: the chat (opens through `openManagerChat`), its mode as
  text (changed in the chat's own composer), `.ppm/manager.md` with Edit and a "Change waiting"
  marker, Telegram detail (Full / Title only), the digest switch, and "Manager tools arrive the
  next time this chat starts" while the chat's live stream predates its assignment
  (`toolsPending`, from the provider's `liveStreamStartedAt`; recomputed each time the pane opens,
  since a stream restart is not announced). The row menu (right-click, long press, or ⋯) has
  Replace… and Unset; a project with none has Assign / create, which reuses the "Set as manager
  chat" dialog or calls the create route. The header sets the default mode for new manager chats
  (choosing bypass asks first); below the table, the template for new rules (16 KB, Reset to
  built-in, which stores an empty template). The rules dialog edits the whole file through
  `PUT …/rules`, lists "Added by the manager since" read-only, and shows a held change
  (`proposedDiff` on the rules view) with Approve change / Revert. The table becomes stacked rows
  below a 680 px pane, by the pane's own `@container` width.
- *Notebook* — the lines with source and date, "Unverified" with "Mark as verified", edit and
  delete, "Add line" (off at the cap) and the `used / 4,000 characters` meter; refetched on
  `assistant:notes_changed` and after a `/ws/global` reconnect.

## Manager chats

A project's **manager chat** is the one chat PPM Assistant talks to about that project
(`manager_chats`, migration 64, keyed by the project's folder in `projectKey` spelling, so a
renamed project keeps its manager). At most one per project and one project per chat; only a
Claude chat of that same project that is neither a design nor an Assistant session
(`src/services/assistant-managers/manager-chats.service.ts`; Codex is refused with "Manager chats
run on Claude for now"). A chat PPM holds no row for (started in the CLI) is accepted once Claude
finds it in the project's folder, and gets its rows then. The user assigns it from the session
row's menu (*Set as manager chat* / *Unset manager chat*, `adaptive-context-menu`, so a long press
opens it on a phone) through a dialog that states the consequence — PPM Assistant may message the
chat without asking, also while the user is away; in bypass mode nothing in it asks either — and
names the manager it replaces. Unassigning removes the row and nothing else; deleting the chat
unassigns it; a bulk delete of old chats keeps it, like a pinned one. What belongs to the project —
its digest switch, Telegram detail level and rules (approved, in force, held) — outlives the row:
it waits in `manager_project_settings` (migration 67) and goes back onto the project's next
manager row, so a re-assigned project keeps its approved rules and its privacy level.

The session list puts the manager first (manager, then pinned, then activity:
`compareSessionsByActivity`), injects it on page 1 like a pinned row and shows a *Manager* badge.
`GET /api/assistant/managers` lists every project's manager with its phase and mode; every change
is announced as `assistant:managers_changed` (the whole list) followed by `sessions:list_changed`
for each project it touched. `isManagerChat` and `managerFor` are answered from memory and dropped
on every change and on a session's rename (the chat lifecycle's `migrated`), because they are
asked on every turn. A project removed from PPM keeps its row, listed under its folder's name,
until it is unassigned.

A manager chat always gets the session-tools server (`ppm-sessions`) attached, whatever Settings →
Tools says (`prepareSendOptions`): it is how the chat will report to the Assistant. The tools it
lists still follow the switches like any chat's (`sessionToolOnFor` in the endpoint); the report
tool, once it exists, is the one kept on for a manager regardless. The tool list is fixed when a
stream starts, so a chat made a manager while its stream is live gets the server at its next start
(idle release, the warm-idle cap, a restart); nothing restarts it for this.

`POST /api/assistant/managers/:project/create` (Settings) makes a new Claude chat titled "QL
<project>" the project's manager, in the mode Settings → PPM Assistant gives new manager chats
(`manager_default_mode`), with the rules files below. No card: a person pressed the button.
`create_session` with `manager: true` takes the same default title when the Assistant gives none
(`defaultManagerTitle` in `src/shared/assistant-managers.ts`), so several manager windows open side
by side say which project each one runs.

The Assistant adopts an existing chat with `manager_assign` and takes the role away with
`manager_unassign` (both under "Running the user's chats"); `ppm manager list | assign <session>
[-p project] [--replace] | unassign [-p project]` does the same from a terminal through
`/api/assistant/managers` on the running PPM (`src/cli/commands/manager-cmd.ts`, server only:
with no PPM running it stops and says so). `assign` and `unassign` are refused from an AI chat
(advisory, keyed on the AI-chat mark) and point to the two tools.

### Manager rules

A manager chat works by `<project>/.ppm/manager.md` (`src/services/assistant-managers/manager-rules-*.ts`).
It is written from a template when the project gets a manager and has none — Settings' own
`manager_template`, else PPM's (`manager-rules-default-template.ts`), which carries the safety rules
inline — and `.ppm/.gitignore` gets `/manager.md` and `/.gitignore` appended (never `*`: `.ppm/` is
also a skill root), so git sees nothing new. Writes are atomic and retried on Windows' EPERM/EBUSY.

PPM's template opens with the manager's role: it manages the work and hands every piece of
hands-on work (investigating, code and tests, screenshots, posting an approved comment, merges,
releases, upgrades, disk or machine cleanup) to a child chat, keeping its own tool use to planning,
briefing, light checks of a child's claims, the task list and cards. It is a default, not one of
PPM's fixed rules: the user may edit or drop it like any line of the file, which is why it lives
here and not in the manager block below. A template is read only when a project's rules are first
seeded, so a change to it reaches managers set up afterwards; a project that already has a manager
keeps the rules it has (PPM never rewrites the user's file), and so does an install whose Settings
template is its own. For those, the project's rules dialog shows "PPM has a new default rule" with
the rule and an Add button whenever the rules in force lack its opening sentence
(`src/shared/manager-default-rules.ts`, which the template is built from too). Add saves the rule
as the user's own edit (`PUT …/rules`, no check, the usual `rules_edited` note), before the first
rule of the opening section and never inside a later one; it waits while the text has unsaved edits.

**How the rules reach the chat.** Never through the system prompt, which is fixed per Claude query:
changing it would restart the stream, cold-read the manager's whole context and kill its background
work. They ride the `<ppm-shared-context>` block as a PPM-owned entry (`managerContextEntry`), built
for every manager turn whatever *share provider context* says, left off only for a slash command,
and re-sent like every entry there: when it changes, after a compaction, after an error. The entry
holds the fixed manager block (the chat's role, who may authorize what, how to report), then
**Approved rules (authoritative)** — what the user approved, or the template — then, when there
are any, **Rules the manager added since**, labelled unreviewed and told it may only add caution.
Rules text has PPM's message-block markers broken, like every other door.

**The guard** (`manager-rules-guard.ts`) runs at every manager turn start, one rules operation per
project at a time, and keeps the file and the prompt in agreement. The file is read only when it is
a plain file of its own (not a link, not one name of a hardlinked file, inside a real `.ppm`) of at
most 16 KB (`RULES_FILE_MAX_BYTES`), and judged against the rules in force with an ordered line diff
(whitespace and blank lines ignored, so a moved line is a removal and an addition):
- unchanged: nothing to do;
- held for the user — any removed, edited or moved line; any added heading, fence, comment, quote
  marker, HTML tag, setext underline, link definition or hidden character; any added line with
  "ignore", "override", "exception", "no longer", "does not need", "instead of", "unless" or
  "except"; a file over the size limit (held whole, never cut);
- otherwise only plain lines were inserted, and one `completeOnce` call (Claude Haiku, no tools,
  15 s, `manager-rules-check.ts`) judges each one. Only "restriction" for every line accepts the
  change; a relaxing or missing verdict, an answer that is not the JSON asked for, an error, a
  timeout or no Claude account holds it (fail closed). One call per distinct change, never per turn.

A held change is kept off disk (`rules_proposed`, `rules_pending_hash`) and the file goes back to
the rules in force, so the manager never reads rules that are not in force. Writing the same change
again is put back without a second announcement. A missing file is written back. A file git tracks
is never read or written ("Untrack .ppm/manager.md (git rm --cached) to use it as manager rules"):
a cloned repository may ship one and `git pull` may rewrite it. A file that already exists when the
project gets its manager is untrusted the same way: the template goes in force and the old text
waits for approval.

Every outcome is a `managerRulesEvents` event (`rules_tightened` quoting the accepted lines
verbatim, `rules_loosen_pending` once per held change, `rules_restored`, `rules_unreadable` once per
reason, `rules_edited`, `rules_decided`), which the Assistant's cards turn into something the user
sees. `GET /managers/:project/rules` reads the rules; `POST …/rules/decision {action, hash}`
approves (the held text becomes approved and in force) or reverts, and is refused unless `hash` is
the change held now, so a stale card cannot apply a newer one; `PUT …/rules {text}` is the user's
own edit — approved and in force at once, no decision — and is always announced with its diff, so
a write the user did not make shows on their phone.

**What the guard does not cover.** PPM guards only `.ppm/manager.md`. A guide the rules point to
(nxsys's `manager-sessions-guide.md`, say) stays the manager's own working file and is not guarded;
the fixed block says the rules and the block win over any file they point to, and the safety rules
belong inline in `manager.md`. The guard targets text a model wrote or a repository shipped; a
process running as the same OS user can write the file and the database anyway, just as it can
read PPM's auth token ("PPM's password" in `CLAUDE.md`).

### Tasks

A project with a manager chat has PPM Tasks on: assigning a manager switches the project's task
store on and starts the manager's news from that moment, so a new manager is not handed the
project's whole past ([Data & Storage → PPM Tasks store](data-and-storage.md#ppm-tasks-store)). While
the store is on and the chat has the task tools, the manager block in its shared-context entry
(`MANAGER_TASKS_BLOCK` in `manager-context-entry.ts`) tells it the list lives in PPM, that it decides
itself what to create, close or re-prioritise (always with `reason` and the `revision` it read), to
set `working_session` when it hands a task to a chat and record the `result`, what the chats it hands
tasks to may and may not change (they cannot close a task or touch its urgency, importance, due date,
assignee, snooze or working chat, and propose closing instead — a news line "closing it as done
proposed", on which the manager checks the work and closes it itself; [AI chat → PPM task
tools](ai-chat-and-providers.md#ppm-task-tools)), and what to do when PPM reports trouble with
handed-off work. The PPM Assistant writes tasks of any project with Tasks on
directly, even one with a manager; the manager is told.

**Being told.** At the start of each manager turn, `ppmTaskNewsEntry`
(`src/services/ppm-tasks/ppm-task-manager-news.ts`) adds a news-once entry to the
`<ppm-shared-context>` block: one line per change made since the manager was last told by anyone but
a manager (its own changes are not news), plus the links whose live state changed, at most 20 lines,
labelled as data written by PPM. The cursor in `task_projects` moves only once the turn carrying the
entry is on its way, so each change is told once and a turn the chat never took leaves the news for
the next. Never the system prompt, for the reason the rules are not.

**"Tell the manager now?"** After the user changes a task of a project with a manager chat — in the
PPM UI, or with a Telegram status button — PPM asks whether to tell the manager now (the write's
`managerPrompt`; a decision already sent to the manager does not ask). Yes calls
`POST /api/tasks/notify-manager`, which runs `wakeManager` (`ppm-tasks-deliver.ts`): one turn into
the manager chat, origin `ppm_ui`, carrying the same lines the news entry would (and moving the same
cursor, so the next turn gets no entry for them). No leaves the news for the manager's next turn. The
Assistant asks the user with `AskUserQuestion` and calls `ppm_task_notify_manager` only on a yes; an
unattended Assistant turn cannot ask, so it never wakes the manager. Wakes are charged to their own
budget (`ppm-tasks-wake-budget.ts`): the same hourly, daily and per-manager limits as the Assistant's
unattended messages to managers (`assistant-send-guards.ts`), counted per project under sender
`ppm-tasks:<project key>` and kept in the config row `ppm_tasks_wake_budget_state`. Quiet hours do
not hold a wake, since the user asked for it; the user asking, or writing in that manager chat,
restarts the project's count and lifts its pause. A refused wake sends nothing and leaves the news
for the next turn. Only one wake of a project is on its way at a time.

**Checks of handed-off work** (`src/services/ppm-tasks/child-check/`). A task whose working session
is a chat other than the manager (handed off) and that has no result is checked by PPM code, not by
the manager: the manager scheduling a check of its own would be one full manager turn every interval
while any handed-off task is open. One unref'd timer ticks every minute; a task is looked at when its
project's interval has passed since its last check (30 minutes by default, 5 to 240, set in the
project's task settings or by `ppm_task_project_update`). A look reads the child's live state, the
bytes its transcript gained since the last look (one positioned read of at most 256 KB) and its
subagents' transcript times. It never sends the child anything: no turn, no answer to a card. Lines
are compared in a normal form with times, long hex runs and numbers stripped, so a wait loop printing
"memory 86% committed; waiting" is not progress. Each look puts the child in one of four states
(`child-check-classifier.ts`), stored in `task_child_checks`:

- **running** — a turn runs and wrote something new within the interval; also a chat that ended a
  turn less than five minutes ago, or has not started yet but was handed the task less than an
  interval ago;
- **waiting on a card** — a card is on screen in the child: the user is needed, not the manager;
- **stalled** — a turn runs and nothing new was written for a whole interval;
- **finished without reporting** — no turn runs, the last ended at least five minutes ago and the
  task has no result; or the chat never started on the task within an interval, or was deleted.

Only stalled and finished without reporting are told: once when the state starts, once more after
three intervals with no change, at most four times per hand-off; handing the task to another chat
starts a new count. A project's findings go out together as one wake of its manager, sent as an
unattended `watch` turn (nobody asked for it, so nothing in it may raise a card for the user, and it
enters only a quiet chat). Each finding names the task and the chat and quotes up to three of the
child's own latest lines — its words and tool calls, never tool output — redacted with the log
secret rules, cut to 200 characters and labelled as data (`child-check-findings.ts`); the wake ends
by pointing at `session_status`, `read_session_turns`, `send_to_session`, `ppm_task_update`
(`result`) and `report_to_assistant`. A busy manager is asked again each tick. When there is no
manager chat, its wake budget is spent, or it stayed busy for 15 tries, one Assistant card for the
project says the same instead ("N handed-off tasks need a look", `payload.detected` and
`payload.tasks`, with an Open chat per task on Telegram); its phone copy waits out quiet hours like
any card. Checks stop, and the stored check goes, once the task has a result, is closed or deleted,
or is no longer handed off. A snoozed task is not checked at all; the checks resume once it is back
from its snooze (whose return is a news line for the manager like any change). The task shows the last finding on its working-session chip ("stalled 40
min", "finished, no report").

**Writes nobody watched.** An Assistant turn PPM started (a watch, a wake) may write tasks. Each such
write is recorded `unattended`, shown as "while you were away" in the task's history, and listed on
one card per turn, posted when the turn ends (`src/services/ppm-tasks/ppm-task-unattended-card.ts`):
"PPM Assistant made N task changes while you were away", up to 25 changes each with the history id
that undoes it ("undo #…" to the Assistant, or Undo in the task's History). The card's provenance
line is "Written by the PPM Assistant" (`payload.byAssistant`, `reportProvenanceLine` in
`src/shared/assistant-cards.ts`), not a manager's. On Telegram it carries an Undo and an Open chat
per change it shows ([Commands, links and settings](#commands-links-and-settings)).

## Isolation

The Assistant inherits none of the user's own agent setup or of ordinary chats' settings.
Settings → AI & Accounts → **PPM Assistant** (`/api/assistant/settings`, config key `assistant`,
shape and validation in `src/shared/assistant-settings.ts`) holds its default provider, a model
and effort per provider, extra instructions appended after PPM's own, a persona, and its own MCP
servers. The persona (`src/shared/assistant-persona.ts`) is a name, a list of ways to address the
user — each what it calls the user, what it calls itself and when that fits — and a free-text
personality of up to 2,000 characters. `assistant-instructions-persona.ts` turns it into a
"Your persona" section placed after every rule and tool section and before the user's own
instructions, saying it changes only the Assistant's voice and none of its permissions,
approvals or limits; names and forms are single lines quoted with `JSON.stringify`, the
personality is quoted line by line. The name replaces "PPM Assistant" on the window's titlebar
and the Assistant's head (`assistant-name-store.ts`, refreshed by every settings answer this
browser gets), on approval cards and messages it sends into chats, and in Telegram's card
headlines and `/help` (`assistantNameForMessages()`); with no name everything reads as before.
A persona pasted into the instructions earlier stays there: nothing moves it.
Those servers' `env` and header values never reach a browser (the whole list is in
`SECRET_CONFIG_KEYS`), and a saved header is dropped when its server's URL moves to another
origin.

- **Claude**: the query runs with `settingSources: []` — no user or project settings, hooks,
  plugins, skills or `CLAUDE.md`, the way `completeOnce` runs — plus `strictMcpConfig`, so the
  MCP servers are exactly the Assistant's own (`assistantMcpServers`). The provider's
  *Additional Instructions* are not applied. Authentication is unaffected (it comes from
  `buildQueryEnv` and the CLI's credential store), but anything only `~/.claude/settings.json`
  provides is gone, its `env` block and `apiKeyHelper` included. The CLI is also started
  without `RIPGREP_CONFIG_PATH` (`buildQueryEnv(…, { assistantSession: true })`): Glob and
  Grep run the CLI's embedded ripgrep without `--follow`, so they skip every link below the
  folder they search (measured on the bundled CLI's ripgrep), and a ripgrep config file is the
  one thing that could turn following on. The policy still asks for Glob and Grep should the
  CLI's environment ever carry that variable; it judges the environment the CLI was started
  with, not PPM's own.
- **Codex**: a separate permission profile, `ASSISTANT_PERMISSION` (read-only sandbox,
  `untrusted` approvals), and mandatory developer instructions — a Codex too old to take them
  fails the session (`RequiredInstructionsError`) instead of running it uninstructed.
  - **A CODEX_HOME of its own.** No codex setting skips `$CODEX_HOME/AGENTS.md`
    (`project_doc_max_bytes = 0` and `instructions = ""` do not), and the same folder holds the
    user's `config.toml`, hooks, agents, plugins and skills. So an Assistant app-server runs on
    `<ppm dir>/assistant/codex-homes/<account folder>-<hash>` (`codex-assistant-home.ts`), which
    holds none of them and is joined to the account's home by two links: `auth.json` is a hard
    link to the account's file (a symlink where a hard link is refused) — codex rewrites it in
    place, so a token refreshed from either home lands in the one file instead of forking a
    rotating refresh token — and `sessions` is a junction (Windows) or directory symlink to the
    account's `sessions`, so the Assistant's rollouts are where PPM's history readers look and a
    resume finds them. The links are checked on every spawn and relinked if they no longer join
    the two files, writing a newer login found only on the Assistant's side back into the
    account's file first. Removing a Codex account deletes its Assistant home at once
    (`removeCodexAccount` → `removeAssistantCodexHome`), taking the links out before anything
    else so the delete never reaches the account's files; any home left behind is swept on the
    next Assistant spawn. Where the home cannot be set up — the account keeps no `auth.json`
    (a keyring login), or the file system refuses the links — the session runs on the account's
    own home, with a warning in the log (see Known limitations).
  - **Skills are switched off by name.** Skills under the user's home folder
    (`~/.agents/skills`) are found whatever `CODEX_HOME` says, so the catalogue is kept out of the
    prompt (`skills.include_instructions = false`), bundled skills are off, and each skill the
    app-server lists is disabled by name (`codex-assistant-skills.ts`, `skills.config`).
  - **The rest of the user's config.** `planAssistantCodexMcp` (`codex-assistant-mcp-guard.ts`)
    reads the effective config back with `config/read` — on the Assistant's own home that is
    only what codex finds outside it, and on the fallback the account's `config.toml` — and
    `assistantSessionConfig` (`codex-thread-params.ts`) disables each of those servers by name,
    turns off web search, apps, plugins, hooks and `notify`, and adds the Assistant's servers.
    An unreadable config refuses the session; so does a user server with the same name as one of
    the Assistant's, because Codex merges same-named tables key by key.
  - **Generated images** land in the Assistant home's own `generated_images`. The file guard's
    read exception for codex pictures (`isCodexGeneratedImagePath` in
    `fs-credential-path-guard.ts`) covers that folder as it covers an account home's, so the
    chat shows them; the home's `auth.json`, marker and `sessions` link stay refused.
- **Shared context**: the user's shared instructions and memories are not added to Assistant
  turns, whatever `share_provider_context` says. Only PPM's own entries ride in that block: the UI
  summary, the channel entry (a turn typed on Telegram says so on every message, and the first
  PPM message after it says the user is back on a screen — `TELEGRAM_CHANNEL_CONTEXT_ENTRY` /
  `BACK_ON_PPM_CONTEXT_ENTRY` in `chat.service.ts`), and a watch turn's news (below).
- **Shell**: an Assistant session's shell gets `PPM_HOME` naming this instance's folder
  (`assistant-shell-env.ts`, both providers), so a `ppm …` command the user approves reaches this
  PPM and not whatever `~/.ppm` holds.
- **External resources**: Assistant Markdown never makes the browser fetch anything by itself.
  `markdown-external-resources.ts` turns external images and embeds into links and holds the
  rest to an allowlist (`markdown-assistant-allowlist.ts`), because a rendered
  `![](https://x/?k=<secret>)` would send the secret with no click and no approval.

## Tools: `/api/assistant-mcp`

One endpoint serves both providers (`src/services/assistant-mcp/assistant-mcp-endpoint.ts`,
mounted before PPM's auth). It is built on the same `mcp-http-endpoint.ts` and
`mcp-session-tokens.ts` as the tab tools: a per-session capability token, held in memory and
revoked when the session is deleted. A token is honoured only while its session — followed
through a Codex rename — is still an Assistant session, checked on every request. A tool call
lifts Bun's 10 s idle cut for its request altogether (`ASSISTANT_MCP_HOLD_OPEN_SECONDS` = 0,
Bun's "no limit"), and the providers get the longest tool timeout each holds
(`ASSISTANT_MCP_TIMEOUT_MS`, 2^31 − 1 ms ≈ 24.8 days; Codex's `tool_timeout_sec` is the same in
seconds), because an approval waits as long as the user takes. Neither provider takes "no
limit": Claude clamps a server's `timeout` to that figure, the longest a JS timer holds, and
leaving it unset is worse — an HTTP server's call is then cut after five minutes of silence. The
Claude permission hook gets the same treatment (`PERMISSION_HOOK_TIMEOUT_SECONDS`): the CLI's own
default would stop waiting for it after ten minutes, with the provider's own card still up.

Every tool that takes a project checks it against the registered projects, and every tool
taking a `sessionId` proves the session belongs to that project and is not an Assistant
session. The names, in order, are `ASSISTANT_TOOLS` in `src/shared/assistant-tool-names.ts`
(Claude spells them `mcp__ppm-assistant__<tool>`, Codex `ppm_assistant:<tool>`).

- **Read, never ask**: `projects_list`, `chat_list_sessions`, `chat_search`,
  `chat_read_messages`, `db_list_connections`, `db_query` for a proven read, `ui_get_state`,
  `ui_read_tab` (see below), `ui_list_commands`, `chats_attention`, `ppm_cli_reference`,
  `chat_list_watches`, and the read half of the git, schedule and tunnel families
  (`git_status`, `git_log`, `git_diff`, `git_branches`, `schedules_list`, `schedule_get`,
  `tunnels_status`; see [Git, schedules and tunnels](#git-schedules-and-tunnels)).
- **Read PPM and the machine, never ask** (the `system` family,
  `src/services/assistant-mcp/assistant-system-*.ts`): `ppm_status` (version, install folder,
  pid, uptime, last restart, database profile and file name, whether a supervisor runs it),
  `ppm_logs_search` (`ppm.log` through the Logs window's reader, every line redacted with the
  Logs switches on and cut to 500 characters; literal text by default, a checked regex on request),
  `ppm_memory_report` (`mem-diag*.log` thinned to 40 rows per window plus a summary per run and the
  `[mem]` warnings), `system_resources` (RAM, commit and page files on Windows, drives, the top
  processes by name, pid and memory — never a command line or environment) and `jira_config_get`
  (per project: base URL, e-mail, whether a token is saved, watchers; `test: true` tries the
  saved login, 6 per 10 minutes, and answers ok or a status in PPM's words — never the token or
  Jira's body). These replace the shell scripts and log greps that used to raise most of the
  Assistant's cards.
- **Remember, never ask**: `chat_watch` and `chat_unwatch` — a watch only reads and reports, like
  setting a reminder (see [Watches](#watches)); `notebook_add`, `notebook_edit` and
  `notebook_delete`, which only touch the Assistant's own notebook (see [Notebook](#notebook)).
- **Navigate the chatting device, never ask**: `ui_open_tab`, `ui_focus_tab`, `ui_reveal_path`,
  `ui_switch_project`, `ui_move_tab`, and `ui_close_tab` for a tab that loses nothing. Each answers
  `previousProject`, the place a moved tab came from, or enough to reopen what it closed, so the
  agent can undo — there is no Undo of PPM's own. `ui_move_tab` (`assistant-move-tab.ts` on the
  device) moves a tab into an open panel, a new split beside one (right or down) or a new floating
  window through the store actions the user's own drag and drop and tab menu use (`moveTab`,
  `splitPanel`, `redockTab`, `popOutTab`), never layout logic of its own; a phone, which has no
  splits or windows, refuses, and so does the Assistant's own tab. A database table tab opens only for a relation `db_query` could read
  unasked (see Databases below); a view that does more than read is refused, not opened.
  `ui_reveal_path` shows a folder or file in the project's own file tree — the sidebar's Explorer,
  the navigation drawer on a phone — never the OS File Explorer window. The server
  (`assistant-reveal-path.ts`) takes a path relative to the project or absolute, and refuses one
  outside the project (lexically and after symlinks), one the editor's read rules refuse
  (`tabReadRefusal`, shared with `open_file`) and one in a store the Assistant treats as private
  (`isAssistantPrivatePath`). The device (`assistant-reveal-path.ts` → `explorer-reveal.ts`)
  switches project, opens the Explorer, and leaves the reveal pending in a store the tree applies
  once it shows that project with its root loaded (`use-apply-explorer-reveal.ts`), because the
  tree resets its state whenever it mounts; it then expands the parents (and a folder itself),
  focuses and selects the row, and answers. A path the tree leaves out (`.git`) is reported, not
  claimed as shown.
  `ui_open_file_browser` is the OS file browser's counterpart: any folder on this machine's
  drives, in a project or not, in the File Explorer window on a desktop and the full-screen sheet
  on a phone; a file opens its folder with the file selected. The server resolves the path with
  `resolveFileBrowserTarget` (`src/services/file-browser-target.ts`) — absolute only, PPM's own
  folder and `~/.cloudflared` refused (`tabReadRefusal`), the private stores refused, autofs roots
  (`/net`, `/Network`) refused, every disk call held to a deadline, and a dangling link judged by
  where it points so the answer never says which keys exist — and hands the device the folder and
  file it resolved (`assistant-open-file-browser.ts` on both sides). The same resolver serves a
  `/files?path=` link (`use-url-sync.ts`) and the paths in a rendered answer
  (`POST /api/fs/locate`, `markdown-local-paths.tsx`; Telegram through `telegram-path-links.ts`).
- **Ask first**: `db_query` for anything not proven to read, `chat_answer_approval` (always — even
  to deny, since a denial changes what that chat does next),
  `ui_run_command` for a command declared `changesData` and for every extension command,
  `ui_close_tab` for a tab that would lose work (unsaved editor text, unsaved SQL or table edits,
  a terminal), and `ui_read_tab` for an editor's unsaved text, a terminal's output or a database
  file's rows from outside every registered project or from a credential store (below) — a file
  tab itself answers with its path, and reading the file is the provider's read tool's call.
  Every git, schedule and tunnel tool that changes something asks too, stage and fetch included.
  `project_add` registers a folder as a project after a card naming it exactly
  (`assistant-project-add-tool.ts`). A drive, the home folder or any folder holding it, PPM's
  own data folder, the home folder's application-state area (`~/.config`, `AppData`, `Library`…)
  and any folder in or holding a private store are refused before anyone is asked
  (`project-folder-refusal.ts`), because a project is where the Assistant reads without asking.
  The user adds those from the project switcher. `project_update` (rename, move, colour) and
  `project_remove` are a route family (`assistant-project-*.ts`) over `/api/projects`; a move runs
  the same refusal. Every project route that writes announces `projects:changed` on `/ws/global`
  (`projects-broadcast.ts`), so every open PPM refetches its project list — whoever wrote, the
  `ppm projects` CLI included. The chat-list routes (create, rename, delete, bulk delete, pin,
  tag, bulk tag, fork, account) and every tag route that writes announce `sessions:list_changed
  {projectName}` the same way (`chat-list-broadcast.ts`), which is what lets `ppm chat` and
  `ppm tags` go through the server. `DELETE /chat/sessions/:id` answers 404 for a chat recorded
  under another project and uses the stored provider; with `?stopRunning=1` it stops a running
  turn first (chat-control server origin `delete`, which never sends or answers), waits up to
  10 s (`wait-turn-idle.ts`) and deletes nothing when the turn does not stop. `ppm chat stop` uses
  no route at all: it opens the chat socket like a browser tab and sends `{ type: "cancel" }`.
  No route sends a chat a message; `ppm chat send` still runs in the CLI's own process.

Opening and messaging the user's chats is not on this server: an Assistant session also gets PPM's
session tools (`ppm-sessions`, see [Running the user's chats](#running-the-users-chats)), under an
Assistant policy of their own.

**Reading a tab** (`assistant-tab-reader.ts`). A file tab answers with the file's absolute path
and its project, never the file: the agent reads it with its provider's own read tool, so one
rule decides every file read — Claude's `Read` under the Assistant policy (inside the projects
unasked, elsewhere and in credential stores with a card), Codex natively. What no read tool can
reach comes back from `ui_read_tab` itself, under the same rule: an editor's unsaved text, a
terminal's output, and the SQL and rows of a database tab on a SQLite file opened by path (no
saved connection, so no *Available to the AI* setting to consult) are returned unasked inside a
registered project and outside the private roots, and otherwise only after a card
(`readOutsideSummary`, which shows the path whole). A terminal is judged by the folder its shell
runs in, and an untitled editor, which has no path, by its tab's project: a registered one reads
unasked, none asks. PPM's own folder and paths on no local drive are refused outright — a file,
a database file or a terminal's folder alike — checked before the disk is touched.

Databases follow the user's per-connection choices: a connection with *Available to the AI
chat* off (`ai_access = 0`) is neither listed, queried, opened nor read through a database tab,
and a read-only connection never runs a write, approved or not. Every statement is audited with
`actor = "agent"`. Opening a table tab (`ui_open_tab`) runs the same read proof on
`SELECT * FROM <table>` first, because the grid's first page runs whatever a view does; the
first page that tab loads is audited as the agent's (`source: "grid"`), and the user's own
scrolling after it is not.

**Old values of a write** (`assistant-write-old-rows.ts`, `assistant-sql-write-target.ts`). An
approved UPDATE or DELETE answers `{ rowsAffected, columns, oldRows, oldRowsCapped }`: the rows it
changes as they were, read by `SELECT * FROM <same table> [AS alias] [WHERE <same condition>]` on
one query session, inside the write's own transaction (`BEGIN` / `START TRANSACTION` /
SQLite's `BEGIN IMMEDIATE`, which takes the write lock the UPDATE would take anyway, only first),
immediately before it; at most 200 rows. Only the plain single-table shape is read that way —
no `FROM`/`USING`/`JOIN` or comma list, no `ONLY`, `WITH`, modifiers, `WHERE CURRENT OF`,
`ORDER BY`/`LIMIT`, `RETURNING` or nested write — and the SELECT must be provable like an
unasked read (safe-listed functions, nothing more reached by the catalog), since it re-runs the
WHERE. A WHERE that may answer differently a moment later (`random()`; the clock on MySQL and
SQLite — Postgres fixes it per transaction) is not read either. Anything else runs as typed,
with `oldRows: null` and an `oldRowsNote` saying why. No locking clause is added, so on Postgres
and MySQL a commit landing between the two statements can make the rows differ from what the
write saw; a SELECT that fails (a login allowed to UPDATE but not to SELECT) rolls back and the
write runs on its own. Only the write is audited; the SELECT is PPM's own.

## The chatting device

Only the browser knows what it shows, so the screen tools are a round trip through a device
broker (`createDeviceBroker` in `tab-open-broker.ts`, keyed by `resolveMigratedSession`) over the
chat WebSocket (`assistant_ui` / `assistant_ui_result`, `src/shared/assistant-ui-protocol.ts`).
Delivery is **strict**: `deliverToChattingDevice(…, { strict: true })` in `src/server/ws/chat.ts`
sends only to the device that sent the session's latest message. If that socket has gone, only
the same browser tab reconnected qualifies, recognised by the per-tab `clientId` it connects
with (`src/shared/chat-client-id.ts`); otherwise the call answers `no-device`. It never falls
back to every device, unlike the tab tools, because switching project or running a git pull on a
screen nobody is talking from is not harmless. A message that arrives with no socket — typed on
Telegram, or a watch turn — clears the chatting device, so the screen tools answer `no-device`
even while PPM is open somewhere: the user is on their phone, and a PPM screen left open on a
desk is not where they are looking. The browser half is
`src/web/lib/assistant-ui/` (`answer-assistant-ui.ts` dispatches by `op`), and it answers only
for an Assistant session.

**The per-turn UI summary.** Each Assistant message carries a short picture of the sender's
screen, built in the browser (`ui-summary.ts`), validated, cleaned and capped on the server
(`assistant-ui-summary.ts`), and placed as one entry *inside* the `<ppm-shared-context>` block —
not a new tag — so the existing `stripSharedContext` keeps it out of history, titles and search.
It is sent regardless of `share_provider_context`, skipped for `/` commands, labelled as data,
and never includes tab content: the agent calls `ui_read_tab` when it needs that.

**Commands** come from one registry shared by the palette, the global keybindings and the
Assistant (`src/web/lib/commands/command-registry.ts`). Each command declares `changesData`; an
extension's command is always treated as changing data. `ui_run_command` reads that flag from
the device's own `list_commands` entry before anything runs, and only a run request built after
approval carries the `approved` marker the device requires. That request also names the project
the card showed (`approvedProject`): a device now showing another project refuses to run it.

## Approvals

**One card per session.** A session shows one approval card at a time, shared between the
provider's own approvals (Claude's permission hook; Codex's command and patch requests, and its
MCP tool approvals for the servers configured in Settings → PPM Assistant, which always ask) and
the endpoint's. They queue behind each
other instead of overwriting, and every way a card leaves goes through
`src/server/ws/chat-pending-approval.ts`, which finishes the request on whichever side waits for
it. Typing a message instead of answering, stopping the turn, or the turn ending withdraws an
endpoint request with that reason.

**The endpoint's broker** (`assistant-approval-broker.ts`) puts the card on every device showing
the session (it is a question, not a screen action), sends the usual approval notification, and
takes the first answer. A card waits until it is answered — shown or queued behind another,
with no time limit — or until the turn, the call or PPM itself goes away: a restart drops every
waiting request with the process, and an answer to one then gets "no longer valid" (below).
`PPM_ASSISTANT_APPROVAL_TIMEOUT_MS` sets an answer window for tests and e2e fixtures only,
counted from when the card is *shown* and held under the providers' own tool timeout. Outcomes
are approved, denied, withdrawn or unavailable (and timeout, only under that variable), and only
approved runs anything. The device broker under it arms no timer for an unbounded wait
(`createDeviceBroker`), since a delay past 2^31 − 1 ms would fire at once instead of never.

**What the card shows** is built by the server from the checked input, never from the agent's
own wording (`assistant-approval-summary.ts`): the full SQL, wrapped, with hidden and
bidirectional characters made visible. The session tools' cards (a message into a chat, a chat to
open) are built the same way (`collab-send-assistant.ts`, `collab-create.ts`) and state the mode
the chat will run in and where it comes from; a message's mode is checked again once the user
allows it, and nothing is sent if it changed. Every chat has its permission mode stored on the
server for this reason.

**Stale answers.** An `approval_response` for a request nothing holds any more — answered on
another device, ended, or from before a restart — gets `approval_stale` and "no longer valid",
never an `approval_resolved`, so a card from before a restart cannot look as if it ran.

## Proving a read

A read-only transaction is not proof that a query only reads: functions can still terminate
backends, take locks, write through another connection or sleep. So `db_query` runs unasked only
when two checks pass, and anything else goes to an approval card:

1. **The text** (`assistant-sql-safety.ts`): a plain read, no assigning `PRAGMA`, no locking
   clause, and every function called is on a short safe list (aggregates, string, date, math,
   JSON accessors, casts). A read that misses the list costs one question, by design.
2. **What the text reaches** (`assistant-sql-reach-check.ts`), asked of the catalog on the
   read-only path without planning or running the query:
   - **Postgres** (`assistant-sql-reach-postgres.ts`): views and row-level policies the query
     can reach, generated columns, domain checks, user casts, user functions named like any word
     of the query, and user operators, each judged by the same rules. `EXPLAIN` is not used, because
     planning runs user code; the file header records what was measured. Only Postgres's own
     `pg_catalog` functions are trusted: an installed extension's count as user functions, so on a
     database with citext `max(…)` asks (its aggregate shadows the safe-listed one). A user
     operator asks only where the query can make Postgres choose it, which goes by operand type:
     on that database `WHERE id = 1` and `SELECT id FROM t` run unasked, while reading a citext
     column (its output is extension code; also through `*`, a whole-row `t`, a view or a domain
     or array over it), writing the type (`::citext`, `CAST(… AS citext)`, `citext 'x'`) or using
     a user operator on a value of its type asks. An operator a built-in type can reach (one on
     `text`, a domain over a built-in, or a type with an implicit cast from one) still asks
     wherever its symbol, or a keyword standing for it (`IN`, `LIKE`, `BETWEEN`…), is written.
   - **MySQL/MariaDB** (`assistant-sql-reach-mysql.ts`): any view the query could name, or a
     stored function named like a safe-listed call, sends it to approval.
   - **SQLite**: no catalog read. A view can only call SQLite's built-ins, `load_extension()` is
     refused by bun:sqlite, and the file is opened read-only.

Any catalog error means asking, never running. A proven read then runs on the connection's
read-only path with a 60 s limit (`UNASKED_READ_TIMEOUT_MS`) and is stopped when the MCP call
closes (`src/services/database/query-stop.ts`). An approved query is the user's to run to the end.

## Running the user's chats

Three tools in `src/services/assistant-mcp/assistant-hub-tools.ts`, and PPM's session tools, let
the Assistant manage the user's working chats instead of only reading them. They are what PPMBot's
shell delegation was for, rebuilt as tools that ask.

**Opening and messaging chats: the session tools.** An Assistant session gets `ppm-sessions`
(`create_session`, `send_to_session`, `session_status`) beside its own server — the same tools
every chat has, through one delivery path (`deliverToSession` in `src/server/ws/chat-inject.ts`).
`resolveCaller` (`src/services/session-collab/collab-context.ts`) marks an Assistant session as a
caller of kind `assistant`, and `collab-caller-policy.ts` decides what it may do:

- It reaches a chat of **any** registered project, never an Assistant or design chat. The target's
  project travels on `CollabTarget`: delivery, the running limit, links and announcements all use
  it, so a chat nobody has open is started in its own folder, not the Assistant's.
- **Every create and every message asks**, on a card in the Assistant's session (and on Telegram,
  below), whatever `askBeforeCreate` says: `create` with `askedBy: "assistant"`, the project and the
  mode; `message` with the chat, its project, the mode it runs in and the whole message. These cards
  offer Allow once and Deny only. **The one exception is a message to the current manager chat of
  the target's project** (next section).
- `create_session` needs `project`; the chat is set up as one the user opens there
  (`createProjectChatSession`), at depth 0, in `providerDefaultMode` and the provider's default
  model unless `model` is given. It is **not** recorded as AI-created (no `spawned_by`): it notifies
  like a chat the user opened and stops counting against the running limit once its first turn
  ends. Its answer waits for a Codex rename (`awaitCanonicalSessionId`), so the Assistant is told
  the id later news names.
- A message to a chat waiting on a card of its own waits behind it (`queued`) and never answers it.
  The mode the card showed is checked again under the chat's lock (`expectedMode` in
  `deliverToSession`); a chat that would now run it in another mode gets nothing.
- Neither a create nor a message links the chat to the Assistant (no pair, no spawn): the Assistant
  belongs to no project, so a project chat's linked-sessions bar could only open it in the wrong
  one. The incoming bubble links back instead, and the Assistant's own linked-sessions bar is off;
  its tool cards open each chat in the project the result names (`project`).
- The message is delivered with origin `session`, and its from-session block carries
  `kind: "assistant"`: the receiving AI is told it is the Assistant, another AI, and that it cannot
  reply through the tools; the bubble reads "PPM Assistant" and opens the Assistant.
- In an unattended turn nothing is created, no chat but a manager is messaged, and no card is
  shown (`UNATTENDED_TURN_REFUSAL`, from the endpoint and again from the approval broker).

**Messaging manager chats** (`collab-send-manager.ts`). A message from the Assistant to the chat
that is, at that moment, its project's manager (`managerFor`, read live per send) goes without a
card. What stands in for the card:
- **Provenance.** Every such message carries a `<ppm-assistant-provenance-v1>` block between the
  text and the from-session block (`src/shared/assistant-provenance.ts`): who started the
  Assistant's turn (`user_ppm`, `user_telegram` or `ppm`), the user's first 200 characters that
  turn, and whether text the user did not write reached it (`untrusted`, with the reasons: watch
  `news`, a `forwarded` Telegram message, a `scheduled` script, a `read` — any tool call that can
  bring outside text, decided by an allowlist in `assistant-outside-text.ts`: only `projects_list`, `project_add`,
  `ppm_cli_reference`, the notebook tools, `TodoWrite`, `ToolSearch` and `AskUserQuestion` leave
  it clean, so Read, Glob, Grep, a shell command, the git, schedule and tunnel reads or any other
  MCP server all set it — or a session-tool result quoting another chat's last answer or reply).
  It covers that turn only, not what earlier turns left in the model's context, and the header
  says so. It is written by the server from
  `assistant-turn-provenance.ts`, which follows the chat lifecycle (a turn runs from the message
  that opened it to `turn_ended`; one PPM began stays PPM's after the user types into it), never
  from the tool's input. The bubble shows it as one muted line ("Asked by PPM Assistant · started
  by you on Telegram"). The block's markers, and those of the user-words block
  (`<ppm-user-words-v1>`, the user's own forwarded words, written later by the reply flow), are
  broken at every door like the from-session block's, and `deliverToSession` defuses every
  PPM-looking tag in a session-tool body (`neutralizePpmTags`), since a model reads them loosely.
- **Priority.** `next` (read at the manager's next step) only when the user started the turn and
  nothing untrusted reached it; otherwise `later` (after the manager's running turn, reported as
  `queued`).
- **Secrets.** A body that `redactSecretsForTelegram` would hide shows the ordinary `message` card in
  a turn the user started and is refused in one PPM started.
- **Duplicates.** The same text to the same manager within an hour is dropped ("Already sent").
- **Unattended turns** (a watch report, or a scheduled script posting into the Assistant, whose
  turn `deliverMessage` records as `watch`) may message managers only, to ask for status (the
  provenance says so, and the manager's fixed block makes it binding there), and are held to
  `UNATTENDED_SENDS_PER_HOUR`/`_PER_DAY` (6/20 per Assistant session, rolling, kept in the
  `assistant_budget_state` config row so a restart does not refill them and no settings save
  touches them), to the pair limit (`maxAutoMessagesPerPair`, counted only for these sends and
  restarted by any message the user writes in either chat, on PPM or Telegram), and to quiet hours
  (`quiet_hours` + `timezone` in the `assistant` row: nothing is sent). A budget running out pauses
  the Assistant's unattended messaging until the user's next message to it, and raises one
  `assistantBudgetEvents` `paused` event (the budget card). Every refusal is written to the
  session trace (`assistant_send_refused`).

Other chats keep the card, and only in a turn the user started. `create_session` with
`manager: true` (`collab-create-manager.ts`) asks once — "Create the manager chat for {project}",
the mode from `manager_default_mode` with the bypass warning, the task if given, and "After this,
PPM Assistant can message this chat without asking, also while you are away" — and is refused when
the project has a manager or in an unattended turn. On Allow the chat is created as one the user
opens there, assigned with `assigned_by: "assistant"` (which writes its rules files) and given the
task with the turn's provenance; if the assignment fails it stays an ordinary chat and the tool says
so. The assignment is compare-and-set (`assign(..., { onlyIfNone })`): a manager the user set while
the card was open is never replaced. The budget card itself is the Assistant's card service's
(`assistantBudgetEvents` is its source); until then the refusal text is what the Assistant tells
the user. `session_status` with
no ids lists every manager chat, and each Assistant turn's shared context carries the list (project
→ session id, title; `assistant-managers-context.ts`), re-sent when it changes.

An existing chat becomes the manager through **`manager_assign`** (`project`, `sessionId`, optional
`providerId`, `replace`), and stops being it through **`manager_unassign`** (`project`); the
instructions tell the Assistant to adopt a chat the user points at rather than create a new one.
Both are the `manager` tool family (`assistant-manager-{tools,write-tools,tool-definitions}.ts`,
names in `src/shared/assistant-manager-tool-names.ts`, card in
`assistant-approval-summary-manager.ts`). They reach no route: they call `managerChats`, the
service behind the session row's *Set as manager chat* / *Unset manager chat*, so the rules files,
`assistant:managers_changed` and the badges are the screen's; the row is written with
`assigned_by: "assistant"`. Refused before any card: an unattended turn, a chat that is not this
project's (missing, another project's, an Assistant chat — `resolveAssistantSessionTarget`), a
Codex chat, a design chat (the service's own `checkAssign`), the chat already being the manager,
and a project that already has one unless `replace: true`. The card shows the project, the chat
(title and whole id), its provider, its last activity (the transcript's mtime), its mode (which
assigning leaves as it is, flagged in bypass), the chat that stops being the manager when replacing,
and the consequence in the dialog's words plus the rules-file note. After the answer both tools read
the chat and the project's manager again and change nothing if either moved; an assignment with
nothing to replace is still compare-and-set (`onlyIfNone`). A running turn does not block either:
the route does not require it, and a live stream simply gets the manager tools at its next start.


- **`chats_attention`** (`src/services/assistant-hub/chat-attention.service.ts`) answers "which
  chats need me": chats waiting on a card or question, running, whose card was lost (an unread
  approval with no live card — PPM restarted under it), stopped by an error, finished unread, and
  finished and read. It has to merge three sources, because none sees everything: live cards are
  only in memory (`chatControl().listLive()`), unread marks are in the database (so a chat never
  opened since the restart still counts), and how a turn ended is in the session trace
  (`src/services/session-trace/turn-ends-query.ts`). Assistant sessions are left out. Titles and
  card text come back labelled as data from those chats, not instructions.
- **`chat_answer_approval`** answers another chat's waiting card. Its confirmation card copies the
  target card's deciding input (below) verbatim, the turn re-checks that the card is still there
  before answering, and an answer that lost the race reports that it was answered elsewhere. It
  refuses Allow when the target's deciding input is incomplete or a question is secret: the
  confirmation card always fits on Telegram, so wrapping an incomplete card in it would turn
  "cannot be reviewed here" into a one-tap Allow. Deny still works.
- **`ppm_cli_reference`** (`src/services/assistant/ppm-cli-reference.ts`, regenerated by
  `scripts/generate-ppm-cli-reference.ts`) teaches the `ppm` CLI on demand instead of pasting it
  into every message as PPMBot did. Its header matters more than the reference: how to invoke
  *this* instance's CLI, which commands go through the running server and which open the database
  themselves, and — on a server running a non-default database profile — a warning not to run
  data commands at all, because only `ppm start` can choose a profile and every other command
  opens `ppm.db`, another instance's data. Git, schedules and tunnels have tools of their own,
  which the header lists first (`TOOLS_INSTEAD_OF_CLI`); extensions and the git operations those
  tools leave out are done through `ppm …` in the shell, which always asks.

**The deciding input** (`src/services/chat-control/approval-deciding-input.ts`) is what a person
must see to decide a card: the whole command and its folder, the URL and prompt, every byte a
write puts down, every edit, a patch's whole diff, an MCP call's full arguments, an Assistant card's
headline, facts and body. One builder serves every place a card is shown away from its chat —
the confirmation card, Telegram, relayed cards, `chats_attention` — so no surface can approve
something other than what runs. It escapes and never strips: the older screen-summary cleaner
removed `<`, `>` and backticks, which turned `echo x > ~/.bashrc` into a different command. It
answers `complete: false` when PPM does not hold all of it (a Codex patch whose full diff it never
got).

**One question shape** (`src/shared/approval-questions.ts`). Claude's AskUserQuestion keys answers
by the question's text, Codex's `requestUserInput` by an id and sends its input as a string. Cards
now carry normalised questions, every surface answers by question id (`answersById`), and the
server converts to each provider's form; the older web shape is still accepted. This is also what
gave Codex questions a working form on the web (it was empty). A secret answer is shown and traced
as `(hidden)`.

## Git, schedules and tunnels

Three tool families do what Source Control, Settings → Schedules and Port Forwarding do (names in
`src/shared/assistant-{git,schedule,tunnel}-tool-names.ts`, spread into `ASSISTANT_TOOLS`; code in
`src/services/assistant-mcp/assistant-{git,schedule,tunnel}-*.ts`). Before them the agent typed
`ppm …` in a shell: the card was one command line the user had to decode, and `ppm schedule`
writes the database directly, so an open PPM never heard of the change.

| Family | Read, never ask | Ask first |
|---|---|---|
| Git | `git_status`, `git_log`, `git_diff`, `git_branches` | `git_stage`, `git_discard`, `git_undo`, `git_commit`, `git_sync`, `git_branch`, `git_stash`, `git_history` |
| Schedules | `schedules_list`, `schedule_get` | `schedule_save`, `schedule_delete`, `schedule_run_now`, `schedule_propose_script` (card allowed only in PPM) |
| Tunnels | `tunnels_status` | `port_forward_start`, `port_forward_stop`, `public_link_set` |
| Projects | (`projects_list`) | `project_update`, `project_remove` |
| Chats | (`chat_list_sessions`, `chats_attention`), `chat_changes` | `chat_stop`, `chat_delete`; `chat_organize`, `chat_changes_answer` (see below) |
| Database connections | (`db_list_connections`), `db_connection_test` | `db_connection_save`, `db_connection_delete` |
| Manager chats | (`session_status`, the shared context) | `manager_assign`, `manager_unassign` (see "Running the user's chats") |
| Settings | `settings_get`, `settings_history`, `settings_install_status` | `settings_set`, `settings_undo`, `settings_install` (see [Settings tools](#settings-tools)) |

The connection family (`assistant-db-connection-*.ts`, names in
`src/shared/assistant-db-connection-tool-names.ts`) reaches only the connection list, one
connection, its password-free config, create, edit, delete and the saved connection's Test; the
internal route app gates `/api/db/*` to exactly those (`isDbConnectionPath`: a numeric id, so never
`export`, `import`, `folder` or `file`). `db_connection_save` refuses a URL holding a password
(in the login or a `password` parameter, `src/shared/db-url-secret.ts`) before any card, judges a
SQLite file by its real path (refusing what `sqlite-path-guard.ts` refuses for everyone, plus what
the Assistant keeps private: its private roots and the home folder's application-state area unless a
registered project holds the file), shows that real path on the card and saves it. It never sends
`readonly` or `aiAccess`, so a new connection is read-only and available to the AI chat (the
route's defaults); only the user makes one writable, in PPM. An edit sends the form's own settings
back unchanged, refuses to point a connection with a saved secret at another server or login, and
touches only connections available to the AI chat. `db_connection_test` runs unasked, at most 10 a
minute per session, and answers the server (and SSH host) it went to. Through the shell the
Assistant could still reach any route with `ppm db`; there the shell card is the control.

`terminal_type` (`assistant-terminal-type-tool.ts`, definition in
`assistant-terminal-type-tool-definition.ts`) types one line, at most 400 characters, into a new
terminal for the user to run, through the ordinary chats' `run_in_terminal` machinery (see
`ai-tab-tools.md`). There is no card: nothing runs before the user presses Enter, and the line is
checked to be exactly what they see. Instead it is gated: it follows the user's `run_in_terminal`
switch (Settings → Tools), and is refused in an unattended turn, in a turn whose provenance at the
call is unknown, untrusted (any reason) or not started by the user in PPM — a Telegram-started
turn would open the terminal on every device showing the chat. The project must be a registered
one (never the Assistant's own) and `cwd` a folder inside it. The terminal keeps the AI-chat mark
and docks in the project the device shows; the answer names that project and the shell's. Its
answer holds only PPM's words, so the call does not mark the turn untrusted.

`git_history` (`assistant-git-history-{plan,tool}.ts`, cards in
`assistant-approval-summary-git-history.ts`) merges, cherry-picks, reverts, tags, and aborts or
continues an operation that stopped part way, one action per call. It names a commit only as the
history route lists it (the newest 1000 of every branch; a merge commit is refused), a merge
source only as the refs route lists it, and refuses a dirty tree, a conflict, or an operation
already under way. After Allow, HEAD's branch and commit, the operation and a merge source's tip
must be what the card showed. A merge, pick or revert that stops on a conflict answers with the
conflicted files rather than an error. The card names the repository's own hooks the action can
run (`src/services/git-workflow/git-hooks-present.ts`: `git rev-parse --git-path hooks`, which
follows `core.hooksPath`, read through Husky 9's `.husky/_` stubs): they run inside PPM, and a
tracked `.husky` folder means the branch being merged can bring its own. They are disclosed, not
switched off, because commits from Source Control run them too. `git_branch` `delete` takes a local
branch other than the current one, shows its last commit, re-checks it after Allow, and answers with
it so the branch can be made again.

The project family reaches only `GET /api/projects`, `PATCH /api/projects/:name`, its `/color` and
`DELETE /api/projects/:name`; the internal app gates the rest of that router (clone, image upload,
settings, `reorder`), and the name `reorder` is reserved because its route is matched before `:name`.

The chat family (`assistant-chat-*.ts`) reaches one chat session (`PATCH`, and `DELETE` with
`stopRunning` and `providerId`), its `pin`, `tag`, `read` and `unread` marks, and the project's tag
list, plus its file-changes review (below). The internal app's project gate (`isProjectFamilyPath`) lets exactly those through beside
`git/`: never the session list, a transcript, an upload or a draft. A chat must be proven to belong
to the named project (`resolveAssistantSessionTarget`), and Assistant chats are never a target.
- `chat_stop` asks, then stops through `chatControl().cancelTurn(…, "assistant")` — only if the
  turn the card showed is still running (`LiveChatState.turnId` and `runningSince` unchanged).
- `chat_delete` asks; a manager chat and a chat with branched versions are refused. The card says
  "Pinned: Yes", or "Until <time> (unpinned by the Assistant)" when the Assistant took the pin off in
  the last 24 hours (`assistant-recent-unpins.ts`, memory only), and "Running now" when the delete
  will stop a turn first. After Allow it re-reads the chat (project, pin, manager, running) and calls
  the delete route with `?stopRunning=1`, whose 409 it passes through.
- `chat_organize` (rename, pin, tag, mark read or unread; up to 20 chats) runs without a card only in
  a clean turn: started by the user in PPM or on Telegram, with no outside text recorded yet. The
  endpoint reads the turn's provenance *before* the call marks it (`ToolContext.provenanceAtCall`),
  so an earlier read in the turn — `chat_list_sessions` included — means one card for the whole
  call. It is refused in a turn PPM started on its own, and marking a chat read is refused while
  that chat shows a card. A manager chat is renamed like any other (the role belongs to the session,
  not the title), and on a card its line says "the manager chat of <project>" in warning tone, since
  that name is how the user picks which chat to type into; a rename of a manager announces `assistant:managers_changed` too
  (`managerChats.retitled`, from `renameChatSession`), so Settings → Manager chats and the manager
  chips show the new name. The result lists each chat's `previous` title, pin and tag, which is how
  a change is undone. These refusals are advisory guards; the card and the routes are the controls.
- `chat_changes` reads a chat's review as its Review tab does (`assistant-chat-review-*.ts`): the
  turns route (`GET …/file-changes/turns`, the newest 20, with the paths the chat's calls name),
  then the list with those paths; with `path`, one listed file's blocks and a diff of at most 400
  lines. Its answer is outside text, so it marks the turn.
- `chat_changes_answer` sends every answer at the versions it just read; the route answers a file
  moved since as `stale`. `keep` follows the `chat_organize` rule (no card only in a clean turn, one
  batched card otherwise); `reopen` needs no card; `revert`, `revert_turn` and `undo` always ask.
  `revert_turn` previews (`revert-turn` without `apply`), shows that preview, and applies it at the
  preview's versions, so a file touched in between makes the route write nothing. `undo`'s card names
  the files from the answer's journal (`session-undo-record.ts`). Every action is refused in a turn
  PPM started on its own. The project gate lets through `file-changes` and its `answer`, `undo`,
  `revert-turn`, `diff` and `turns` only — never `reviewed` or `count`.

Stage, unstage, fetch and pausing a schedule ask too: the rule is that every change of state, and
everything that reaches the network, asks.

**The UI's own routes, called in-process.** A tool runs neither git, the scheduler nor cloudflared,
and does not call the services behind the routes either, because what matters lives in the routes:
the discard's Undo copy, clearing the shared commit message, the `?repo=` check that follows
symlinks, `git:changed` after every git POST. `createRouteCaller` (`assistant-route-call.ts`) hands a
`Request` to a Hono app that mounts only the seven routers the families use, at the paths and in the
order `src/server/index.ts` mounts them, imported on first call (a static import closes a cycle
through the chat routes while the server starts). That app has no `authMiddleware` — the caller
already proved itself with the session's MCP token — so the allowlist is the whole boundary:

- **One list per family**: `GIT_ROUTES`, `SCHEDULE_ROUTES` and `TUNNEL_ROUTES`, each beside its
  handlers in `assistant-<family>-tools.ts`, bound by `routeCallerFor` (`assistant-tool-family.ts`).
  A git tool cannot reach a schedule or tunnel route even by building the path itself, and the list
  names only the routes the tools call — nothing for merge, branch deletion or named-tunnel setup.
- **Templates, never regular expressions** (`allowRoute` in `assistant-route-rules.ts`, a leaf
  module that imports nothing, so a family file cannot close an import cycle): literal segments,
  `:name` placeholders of exactly one segment, and the query keys the route may be sent. A rule that
  cannot be enforced as written is dropped, refusing its calls rather than widening them.
- **Refused before any router runs**, with `route_not_allowed`: a path a router would read
  differently from the template (dot segments raw or encoded, encoded slashes or backslashes, double
  encoding, control characters, a non-canonical form, a second `?`), an unlisted or repeated query
  key, a body on GET or DELETE. A project segment must be a registered project's exact name, so
  `__assistant__` and unregistered names answer `project_not_found` without reaching the router.

The settings routers (`/api/settings`, `/api/notifications`, `/api/speech`, `/api/assistant`,
`/api/accounts`, `/api/lsp`, `/api/remote-desktop`) are mounted for the settings family behind a gate
of their own: only the exact paths in `settings-tool-routes.ts` get through (the password, UI
preferences, MCP servers, account sign-ins and exports never do), and `config-key` only for the
catalog's two keys. A rule written wrongly still cannot reach `/api/fs`: that router is not
mounted.

**Cards** are built by pure functions (`assistant-approval-summary-{git,schedule,tunnel}.ts`) from
state read through the same routes. What decides the card — a file list, a commit message, a
schedule's prompt, a cron, a port, an address — sits in the body verbatim and escaped, because a
fact is cut at 200 characters. A commit card lists the files *before* the message, with a count, so
a message cannot pose as the list. Every write goes through `ask`, so a watch turn changes nothing,
and a card too long for Telegram is decided in PPM like any other.

**Re-checked after Allow.** A card can wait for hours, so where what it showed can move the tool
reads the state again and answers `stale` without running if it changed: a commit (staged files and
HEAD), a push (branch, HEAD and upstream), stash apply/pop/drop (index and hash), an undo (the route
answers 409), every schedule save, delete and run-now, stopping a forward (still this PPM's), and
switching the public link on (login still on). The instructions tell the agent not to retry a stale
call by itself.

**Git.**
- *Which repository*: `resolveGitRepo` (`assistant-git-repo-scope.ts`) asks discovery
  (`GET /git/repos`). A project folder that is a repository gets no `repo` parameter, so every URL is
  what the UI sends; one repository below it is used; several with none named is an error listing
  their `relative` paths — never a guess. A named repository must be one discovery listed, and goes
  out as discovery's absolute path, because the route resolves `repo` against the server process's
  directory, not the project's. Every card names project, repository and branch.
- *Remotes by name only.* A remote URL can carry a token (`https://user:token@…`), and git repeats it
  in stderr, so route errors pass through `hideRemoteUrls` (`assistant-git-tool-helpers.ts`).
- *Never a force push*; a push while behind warns it will likely be refused. A branch with no
  upstream goes to `/git/publish`.
- *Undo*: a discard keeps the route's one-day copy and `git_undo` restores it, as Source Control
  does; an unpushed commit can be undone, a pushed one is refused before any card. Commit and stash
  save refuse while `/git/changes` is truncated, since the card could not list every file.

**Schedules.**
- Reads see every schedule; writes only those whose folder *is* a registered project (real path,
  case-insensitive on Windows). The tools take project names, because the route itself accepts any
  raw path.
- With no mode given, a schedule runs in `bypassPermissions`, as the Settings form creates it; the
  card warns that every run executes every tool with nobody watching, and the instructions have the
  agent propose `default` or `acceptEdits` — while saying that a `default` run waits on cards nobody
  is there to see. A new schedule is sent with every value explicit, so what is stored is what the
  card showed.
- The stale check cannot rest on `updated_at`: the scheduler bumps it after every run and when a run
  opens its session, so a schedule firing every few minutes could never be approved. An unchanged
  `updated_at` passes; a changed one compares the fields the card showed (`unchangedSince`).
- **`schedules:changed`**: a middleware in `src/server/routes/schedules.ts` broadcasts it on
  `/ws/global` after every successful write, whoever made it, and the scheduler sends it again
  when a run finishes (`onRunFinished`); `use-schedules.ts` re-reads the list and the open run
  history. Tunnels get no event: the Port Forwarding panel already polls every 10 s, and a slow
  process scan keeps the forwards this PPM started in the list (`withCurrentPpmTunnels`).
- Run output comes back capped and labelled as another chat's data, not instructions.

**Tunnels.** `assistant-tunnel-host.ts` answers what only this process knows (the forwards it
started, PPM's own ports, the database profile, whether login is on), loaded lazily.
- A Cloudflare forward card says that anyone with the address can open the port and PPM's login
  does not protect it; a Tailscale one names the tailnet.
- PPM's own port is never forwarded: a second public address for PPM would outlive anyone's memory
  of it, and `public_link_set` is the managed one.
- `port_forward_stop` stops only forwards this process started, checked before
  `DELETE /api/tunnels/:pid` is called — that route kills any cloudflared on the machine not marked
  protected, and once took down a production tunnel.
- `public_link_set` refuses on a non-default database profile, which shares `.supervisor-cmd` and
  `status.json` with the instance owning the folder and would restart *its* tunnel; and refuses to
  switch on while PPM's login is off. Switching off warns that whoever reaches PPM through that
  address loses it, Telegram's Open in PPM buttons included; Telegram itself keeps working, so it
  can be switched back from there.
- `tunnels_status` returns a field whitelist: no masked token, certificate state, sign-in link, IP,
  OS user, device name or device DNS name (the name is the DNS name's first label, which the
  tailnet beside it would complete), and a tailnet named by an email address is replaced by its MagicDNS
  suffix or left out. When the process scan for other programs' tunnels fails it says so
  (`forwardsIncomplete`, from `GET /api/tunnels?detail=1`) rather than reporting none; the
  forwards this PPM started are always listed.
- The Tailscale Service and the named tunnel are read, never changed: both need a sign-in or an
  admin's approval only the user can give, in Settings → Remote Access.

## Settings tools

`settings_get`, `settings_set`, `settings_history`, `settings_undo`, `settings_install` and
`settings_install_status` (`src/services/assistant-settings-tools/`, names in
`src/shared/assistant-settings-tool-names.ts`) let the Assistant change PPM's own Settings instead of
opening a pane and telling the user what to click (ppm/52). They are offered only while
`assistant.settings_tools` is true — the "PPM has new features" question
`assistant-settings-tools-2026-11`, or the switch in Settings → PPM Assistant → **Changes**; absent
means not chosen, which is off. The endpoint hides them from `tools/list` (`assistantToolOff`) and the
handlers refuse a call that arrives anyway.

- **The catalog** (`settings-catalog-core.ts`, `settings-catalog-ai.ts`) is the whole list of what may
  change: a key, the pane's label, a value spec checked strictly, a tier, an in-process read and the
  pane's own route for the write. A key in no list is "not offered". `settings-catalog-refused.ts` names
  what the Assistant may only point at, with the reason and a `/?openSettings=<category>` link: every
  secret (answered as `{ set: true|false }`, never a value — not read, not written), PPM's password,
  `port`/`host`, MCP servers, account sign-ins, Tailscale and named tunnels, the vault, and the
  switch itself. `UNCOVERED_CATEGORIES` says why each other pane is out (a test pairs both with the rail).
  The voice word lists are keys too (`settings-catalog-voice-words.ts`): `voice.learned.<project>` and
  `voice.learning.<project>` for the Assistant and every registered project, each a list of "heard → meant"
  items, `direct`. A list may only lose items — Undo on a learned word, "Don't learn" on a pair being
  counted, both of which move it to the undone list — or get back ones taken out earlier, which is what
  the log's Undo writes (`restoreBlocked`). Anything else, and taking out one of two pairs that teach the
  same word (both buttons act on the word), is refused before any card by the entry's `validate`.
- **Tiers**: `direct` changes with no card in Full mode (voice, theme, notifications, model and effort,
  quiet hours, digest, file filters, log level); `card` asks even in Full mode, its reason on the card
  (login, every permission switch of the Assistant and of other chats, the Assistant's instructions,
  persona and manager template, design instructions, account rotation, the Telegram bridge). A
  `direct` setting can ask in one direction only (`cardWhen`, the user's choice of 2026-11-21): the
  session-trace and query-log limits ask when lowered (that deletes history Undo cannot bring back;
  raising one, or setting the same value again, does not ask), and the "Needs approval" alert asks
  when switched off, never when switched back on. An undo is judged the same way by its direction. Ask mode asks for everything. A turn PPM started is refused as for every write.
- **Writes** go through the settings family's route caller, so validation, logs and `settings:changed`
  (now also `voice`, `assistant`, `design`) are the pane's; the internal app mounts the broadcast
  middleware too. One card covers a call of up to 10 changes; after Allow every value is read again and
  a moved one makes the call `stale`, writing nothing. `PUT /api/assistant/settings` replaces the
  object, so a write sends the required fields as stored and leaves out every key the route keeps by
  itself unless the change touched it.
- **The change log** (`assistant_setting_changes`, migration 79, 90 days): one row per change, install
  and undo, with before and after as JSON and as text, where the turn was typed and how it was allowed
  (`full`, `card`, or the user's own `user` Undo). No secret reaches it. Undo
  (`undoSettingChange`) is compare-and-set: refused when the value moved since, claimed before it
  writes (two presses at once undo once), and an undo row is not itself undoable. The user's Undo needs no card — from the chat card (`settings-tool-card.tsx`), the
  Changes tab (`/api/assistant/settings-changes`) or Telegram; the agent's `settings_undo` asks like
  `settings_set` would. `assistant:settings_changes_changed` refreshes open Changes tabs.
- **Installs** (`settings-installs.ts`): Whisper and a model, a language server, a database driver, the
  WebRTC relay — always a card naming the pinned download and where it goes. Whisper and the relay run
  in the background: the chat card polls their status route, and a Telegram turn gets one message
  edited in place (`settings-install-watch.ts`). Removal keeps no old copy.
- **Telegram** (`assistant-telegram-settings-changes.ts`): the changes a Telegram turn made come back
  when the turn ends as one card, before → after and how it was allowed, with an Undo per setting and
  Open in PPM (`/?openSettings=assistant:changes`); a long value is shown as its start and length,
  so the card stays under Telegram's message limit. A `card`-tier change is the ordinary Telegram
  approval card. Browser-only preferences (`voiceEngine`, `lspEnabled`, Remote Desktop's) are not in
  the catalog.

## Server-side chat control

Telegram and watches act on chats with no browser attached, so everything a browser could do to a
chat is exposed inside the server by `chatControl()` (`src/services/chat-control/chat-control.ts`),
which `src/server/ws/chat.ts` registers: send a user message, answer a card, stop a turn, read a
chat's live state. Each runs the same core the WebSocket handler runs, so the first answer to a
card still wins and nothing gets a second rule set. There is no HTTP route to it, and callers must
carry a person's decision — a button pressed, a message typed.

Origins say who acts. `telegram` is the user typing elsewhere: like a typed message it supersedes a
waiting card. `watch` is never the user: it is refused with `busy` while the chat has a card or a
running turn, rather than cancelling or steering either. `assistant` only answers cards and stops
turns: the Assistant's messages into chats come through the session tools' door
(`deliverToSession`) as origin `session`, like any other session's, so the guards main keys on that
origin (waiting for a starting consumer, the from-session block decoding) hold for it too. That door
emits the lifecycle `user_message` and sets the chat's `turnOrigin` the way a typed message does.
`ppm_ui` is PPM Tasks sending what the user chose on its own screens; it only ever sends a message
([AI chat → PPM task tools](ai-chat-and-providers.md#ppm-task-tools)). These are trace origins too (`TraceOrigin` in `src/shared/session-trace.ts`).

Only a message that owns a turn sets `turnOrigin` (`src/server/ws/chat-turn-origin.ts`): one that
opens a turn, or the user typing into a running one. A scheduled script posting into an Assistant
session opens an unattended (`watch`) turn, but never turns the user's running turn into one; it,
and a `later` message, queued behind the running turn own only the turn they open.

`chatLifecycle` (`src/services/chat-control/chat-lifecycle.ts`) is the bus the rest listens on; the
event names and payloads are `ChatLifecycleEvents`. It is emitted whether or not a browser is
connected — the socket layer drops events when no client is there, and a turn started from
Telegram has none. Listeners run on the chat's hot path, so they only record or enqueue, and one
that throws is logged, never felt by the chat. Every way a card can leave
(`src/server/ws/chat-pending-approval.ts`) emits `approval_resolved` with its reason, so a card
answered or withdrawn anywhere loses its buttons everywhere.

`addNotificationSuppressor` (`notification-suppressor.ts`) lets the bridge and the watch service
hold back a push that would repeat what the user was just told; the unread mark is still set.

The binding and watch tables (migration 62) are behind `src/services/assistant-hub/assistant-hub-db.ts`,
which reads every id through `resolveMigratedSession`, because Codex renames a new session during
its first turn.

## Watches

"Tell me when that chat is done" (`chat_watch`, `chat_unwatch`, `chat_list_watches` in
`src/services/assistant-mcp/assistant-watch-tools.ts`; service
`src/services/assistant-watch/assistant-watch.service.ts`). A watch is a database row, so it
outlives a restart, and it covers one run of the target chat.

- **What wakes the Assistant**: the watched run finishing, stopping on an error, being interrupted
  by a restart (the watch was armed while the chat ran and the trace has no end for that run —
  `watch-turn-end-reader.ts`), or the watch expiring. Each wakes the Assistant session that set it
  for one short turn so the report arrives as a message in the conversation.
- **A card does not wake it.** A card in the watched chat only raises `watch_decision`
  (`watch-events.ts`) and is relayed with buttons (see Telegram). A model turn per card would cost
  a turn per tool call, and would invite the model to act on a card the user never saw. Every
  watch relays its chat's cards whatever `notifyOn` says; `notifyOn` only picks which ends of the
  run (`done`, `stopped`) wake the Assistant.
- **Wake turns cannot change anything.** Such a turn carries another chat's words, and a card in
  it is one tap on a phone at a moment the user did not choose — the shortest path from injected
  text to an action. So everything that would ask is refused without a card
  (`UNATTENDED_TURN_REFUSAL`, checked by `isUnattendedTurn`): the endpoint returns that reason, the
  session tools refuse to create or message anything, and the provider's own approvals are denied
  outright. A message the user types into the turn makes it theirs again.
- **The news is not a message.** The turn's message is the fixed `WATCH_OPENER`; what happened is
  an entry in the shared-context block (`watch-event-text.ts`), which `stripSharedContext` keeps out
  of history, titles and search. `<ppm-…` tags typed by a user into an Assistant session are
  neutralised so nobody can fake one.
- **Caps.** Active watches per session and the expiry are constants in `watch-state.ts`. Report
  turns are started by the wake queue (below), whose hourly cap counts every kind of news; news
  beyond it, or arriving while the session is busy, waits and goes into the next turn together.
- **Delivered means answered.** A report counts as delivered only when its turn ends with text.
  A failed or silent turn is retried; after `MAX_REPORT_ATTEMPTS` a push names the chat instead. A
  turn the user stopped is closed with no retry and no push.
- **Who hears it.** A session bound to Telegram reports through that chat (the mirror below). An
  unbound session gets a push naming the watched chat in place of its generic "Chat completed",
  and the relay sends the report to every connected Telegram chat.

Deleting an Assistant session deletes its watches. Asking to watch a chat whose run already ended
after the user asked answers with how it ended instead of creating a watch.

## Reports and cards

What needs the user becomes a **card**: built by PPM from records, never from a model turn, stored
in `assistant_cards` (migration 65) and announced on `/ws/global` as `assistant:card` and
`assistant:waiting_changed`. Code in `src/services/assistant-cards/`, shapes in
`src/shared/assistant-cards.ts`, routes in `src/server/routes/assistant-cards.ts`.

- **Two sources.** A project's manager chat files `report_to_assistant` (`manager-report-tool.ts`):
  `needs_decision`, `urgent`, `done` and `failed`; a `digest` answer makes no card of its own and
  goes to the morning digest while its ask is open (see [Morning digest](#morning-digest)). What PPM
  sees in the manager chat itself (`manager-signals.ts`) adds an `approval` or `question` card
  mirroring its own request, and a `failed` card for a turn that failed with no report within
  `FAILED_CARD_GRACE_MS` (a stop the user asked for, a rate limit or an overloaded provider is
  skipped). A report may carry `images`: ids from `design_screenshot` of the manager's own
  project, checked when the card is filed; the card shows them, and on Telegram they go just
  before the card as one photo or one album (`assistant-telegram-card-photos.ts`), each captioned
  with its number (no link: the photo is the picture), under the same quiet hours and silence as the card, and
  not at all for a project whose cards reach the phone by title only. Rules events become `rules_note` / `rules_change` cards, and the Assistant pausing its
  own messages a `budget` card (`assistant-event-cards.ts`). Every other chat of a project,
  watched or not, gets the same `approval` / `question` mirror (`ordinary-chat-cards.ts` says
  which: not the Assistant's own, not a manager, not an extension's turn; a Design chat's card is
  a link to its design, `payload.answerInPpm: "design"`, answered only beside the canvas; the chat's
  project is found by its folder, not the spelling of its name),
  carrying `payload.chat` (its name and provider) and `payload.expiresAt` for a card that gives up
  by itself (a session tool's, after an hour): such a card used to wait only in its chat and run
  out while the user was away. A chat a manager opened, at any depth, is mirrored like any other:
  it used to be left to the manager to relay, which it learned of only when it next looked, often
  after the card ran out. A manager's `needs_decision` or `urgent` report about such a card (named
  by `chat`, or by naming exactly one such chat's session id with no `draft`) is folded into the
  mirror: nothing is filed and the call returns the mirror's id, its note saying how to file a report
  that only named the chat but is about something else (`manager-report-tool.ts`). A mirror's
  Telegram copy says when it expires; when it does, `approval_resolved` carries reason `expired`,
  the copy says so and one line under it tells the phone. A session tool's card is answered from
  Telegram or from the mirror (origin `telegram` / `assistant_card`, once, never "for the
  session"; `chat-collab-approval-relay.ts`). A `db_execute` or vault card is only named
  (`ppm_only_card_shown`, `payload.answerInPpm`): no Allow or Deny anywhere but its chat, and no
  Telegram copy beyond the notice `assistant-telegram-db-notices.ts` already sends. Every card a
  chat waits on is mirrored, not only the one in front (`chat-waiting-card-signals.ts`): a card
  queued behind another (`approval_queued`: a provider card in `approvalQueue`, or a session tool's
  card held in its broker) gets a mirror with `payload.queued` and nothing to press (the answer
  route refuses it with 409), and Telegram is sent nothing until it reaches the front, when the same
  card is made answerable (change `shown`) and goes out as a new card would. A card left on a
  chat's screen for `APPROVAL_OVERDUE_MS` (3 minutes; `chat-approval-overdue.ts`) is
  `approval_overdue`: its mirror says "waiting since hh:mm" (`payload.waitingSince`), and Telegram
  gets one more message with a sound whether or not the user is at PPM (`sink.overdue`), or the
  card itself if it never went out. A turn a schedule started (`scheduledTurn`) rings through
  quiet hours too, since nobody is at that chat and its schedule is stuck behind the card. An MCP
  server connected at a chat's previous init that needs a sign-in at the next
  (`mcp_sign_in_needed`, never one that needed it from the start) gets one link-only card per
  project and server (`answerInPpm: "mcp_sign_in"`), settled when it is signed in to from any
  screen. Every send to Telegram, and every silent skip in the relay, is logged, and the mirror
  says whether it was sent, held for quiet hours or skipped (`card.outbound`). A schedule's
  `ctx.ai.chat` answers `busy` with `waitingOn` when its chat is stopped on a card. A turn another chat or PPM opened is one the user did not
  watch, so the block PPM puts in every manager turn (`MANAGER_USER_ACTION_RULE` in
  `manager-context-entry.ts`) tells the manager to report anything that turn leaves the user to do
  or decide; nothing detects such a turn on its own, since every turn a child's progress message
  opens would then make a card.
- **Never-sent waiting cards.** An approval or question card made while nothing could carry it
  (`pending`: the bridge was not running; `skipped`: no chat connected) goes out under one "Still
  waiting for you" header once a chat can be reached — at bridge start and on every binding change
  (`cardOutbound.catchUp`) — if it still waits; in quiet hours it is held like any card. A manager
  chat's card on Telegram is headed "Manager chat “…” in … is stopped, waiting for your answer"
  (or decision), so it is not read as one more line of the conversation.
- **Who may report.** The tool is listed by the session tools' endpoint for a project's current
  manager chat only, whatever Settings → Tools says, and every call checks the live table again.
  Any other chat, the Assistant included, is refused.
- **Report text is untrusted.** Titles lose leading emoji and openers that imitate PPM ("PPM",
  "Allow", "Approval"), hidden characters are shown as `⟨U+XXXX⟩`, and the server-only block
  markers are broken in every field (`card-text-cleaning.ts`). A draft is only neutralized, so the
  text the user approves is the text sent; it carries `sha256(to + "\n" + text)`. Every report card
  carries a server-written line, "Written by the {project} manager AI" (or "Marked urgent by…").
  A body (and the manager's answer to a reply) is Markdown: the browser draws it with the chat's
  renderer in its card mode (`MarkdownRenderer card`: no raw HTML, the Assistant's no-fetch rules,
  no image loaded at all — not even a local one — and every non-file link in a new tab), and
  Telegram gets it through `markdownToTelegramHtml`, which escapes before it adds a tag. The title,
  the draft and the rules diff stay plain text: a draft is what would be sent, character for
  character. The manager is told to write bodies that way (short sections, bullets, bold, code).
- **Caps.** No limit on how many reports a manager files: an hourly cap (20) refused the 21st
  report outright, so a decision past it was lost, and real managers reached it while the user was
  answering every card. What stops a manager stuck in a loop is that a report identical to an open
  card of the same manager — kind, title, body, draft, options, images, compared as stored
  (`sameReport`) — is not filed again: the call returns that card's id with a note, and nothing is
  sent to Telegram twice. Once that card is answered, dismissed or resolved, the same report makes a
  new card. 2 urgent per manager per quiet window, after which an urgent report becomes a decision
  held for the morning; the same urgent title collapses into one card
  (`src/shared/assistant-limits.ts`). Each refused or merged report is logged at INFO with its kind,
  project, session and reason, never its text.
- **Withdrawing and replacing cards** (`card-withdraw.ts`, switch `report_withdraw` in Settings →
  Tools → Cards, on by default with no feature introduction, so an upgrade asks nothing). A manager takes
  back a card a newer one replaced (`report_to_assistant { supersedes: [ids] }`) or that the user
  handled elsewhere (`report_withdraw { cards, reason, superseded_by? }`; with no `cards` it lists
  the manager's open cards). The Assistant has `card_withdraw`: any project's report cards in a turn
  the user started, only its own (`byAssistant`) in a turn PPM started. Only `needs_decision`,
  `urgent`, `done` and `failed` reports of the caller's project (a previous manager chat's included),
  never a chat's approval/question mirror, a rules change, a budget card, or an open card carrying an
  answer (one reopened because the user's words did not arrive); at most `WITHDRAW_PER_TURN` (5) per
  turn of the withdrawing chat, counted by the chat's live turn id (else the last 10 minutes). A
  withdrawn card is `dismissed` with `answer.withdrawn` (`sessionId`, `reason`, `supersededBy`,
  `turnId`) and `answer.by` `manager`/`assistant` — no new status, no migration. The user's Restore
  (`POST /cards/:id/restore`, withdrawn cards only) puts it back to `open` and sends it to Telegram
  again (change `restored`). PPM shows "Replaced by …" / "Withdrawn: …" on the card, Restore and Show
  new card under it, "Replaces …" on the new card, and one toast with Undo in every tab that showed
  it waiting; Telegram rewrites the old copy's end line and sends the replacing card as a reply to
  it. A reply to a withdrawn card is asked about ("send anyway?"), never refused, so the user's words
  are not lost; an OK pressed late is told to answer the new card. Reminders, all only while the
  switch is on: every report's answer lists the manager's other open cards; the manager's rules gain
  `MANAGER_WITHDRAW_RULE`; the digest ask gains `DIGEST_ASK_WITHDRAW_TEXT` (fixed text — the manager
  looks its cards up with `report_withdraw`, no model text is pasted into the ask). A report may name
  the task it is about (`task`, stored as `payload.aboutTask`); when that task closes
  (`card-task-closure.ts`, on `ppmTasksEvents`) its `done`/`failed` cards are cleared by PPM, a card
  that waits only gets `payload.taskClosed` ("Task … was closed"), and the close tool's answer lists
  those waiting cards for the closer to withdraw if settled. PPM never closes a card that waits on
  the user by itself.
- **Answering.** `POST /api/assistant/cards/:id/answer` answers the exact request an approval or
  question card mirrors, through `chatControl().answerApproval` with origin `assistant_card`; Allow
  is refused when the card does not show everything that would run. A question card is answered with
  the chat's own question form (`chat/question-card.tsx`, drawn inside the card): the same options,
  "Other" field, several choices, tabs, Submit and Skip, so a question looks and answers the same in
  the chat and outside it; Skip declines it as Skip in the chat does. Only the card's frame (who
  asked, Open chat) is its own, and a secret is answered in the chat. `POST …/reply` may carry
  `images` (at most five PNG/JPEG/GIF/WebP as base64, each at most 5,000,000 base64 characters,
  the composer's inline cap, and under 2000 px on its longer side): the server checks the type
  against the bytes and the pixel size, writes its own copy under the uploads folder and forwards
  them with the words as a composer message does (inline for Claude, by that path for Codex); it
  takes no path from the browser, and a line of the user's text that looks like an attachment
  marker is defused wherever it is. `confirmAge: true` confirms only a card's age (the "send
  anyway?" asked of a day-old card) and is refused with `already_answered` once the card no longer
  waits; `force` sends to a closed card. On Telegram a reply to a card that was decided (an OK, a
  choice, an Allow or Deny, dismissed, resolved, gone) is refused in one line ("Not sent: this card
  was already decided or closed"); a card answered only in words still takes more, after "send
  anyway?" (`force`), so the conversation under the card goes on; and "Send anyway" for a card still
  waiting sends `confirmAge` (`cardDecided` in `assistant-telegram-card-replies.ts`). A Telegram photo (or an
  album, gathered by `media_group_id`) sent as a reply to a card goes the same way, the largest copy
  under those limits, and so does a voice message, once read: its transcript goes as the words and
  the server writes the voice part (`voice` on the reply: from the Telegram channel, or from PPM's
  screen with the upload route's receipt for that recording; see `ai-chat-and-providers.md` →
  Voice messages). `POST …/dismiss` takes reports
  and the budget card. Status changes are compare-and-set, so a second answer gets
  `already_answered`; a request answered anywhere else resolves its card; a request that no longer
  waits resolves it with nothing run.
- **After a restart**, an approval or question card whose request no live chat shows is marked
  `gone`; news not yet told to the Assistant is still pending on its card.

### The wake queue

`src/services/assistant-wake/assistant-wake-queue.ts` is the one door through which PPM starts an
Assistant turn on its own. Its sources are the watches, the card news (`done`, `failed`, `urgent`,
the morning digest; for the main session), late manager replies (`manager-wake-sources.ts`) and
restart news (below). It starts
at most `WAKE_TURNS_PER_HOUR` per Assistant session, never while that session runs a turn or shows
a card, and during quiet hours only when something urgent waits; news held back goes into the next
turn together. An item marked `capExempt` (only restart news is) is not held by the hourly cap: once
the cap is reached a turn may still start, carrying only such items, and it counts toward the cap,
so the other news still waits for the hour to pass. Quiet hours still hold it unless it is urgent. The turn opens with a fixed sentence and carries the news in the shared-context
entry ("Manager news", `wake-news-text.ts`): quoted data, capped at `NEWS_QUOTE_MAX` per field. A
card that only waits for an answer wakes nothing.

A **late reply** is the end of a manager turn that took an Assistant message nothing waited for
(or whose wait gave up first): its final text becomes news, with no card. These live in memory; after
a restart the answer is still in the manager chat.

A wake turn whose whole answer is `[no reply]` sends nothing to Telegram (`WakeTurnGate`) and no
push; a turn carrying only manager news never sends "Chat completed", since its cards are the news.

**Known limitation:** a manager's subagent calls the tool with the manager's own token, and an MCP
call carries nothing that ties it to the CLI's tool call, so PPM cannot label a report as a
subagent's. The manager rules tell the manager not to report on a child's say-so.

### Restart news

After every server start (upgrade, health-check kill, crash, `ppm restart`, machine boot) the main
Assistant session gets one wake turn saying what restarted, which chats were cut off mid-turn and
which chats between turns had their background work stopped, so it can have each project's manager
chat resume them. Code in `src/services/restart-news/`.

- **Why it started.** The supervisor decides at every spawn and hands it to the server as
  `PPM_START_REASON` (`boot | upgrade | manual | watchdog | recycle | crash | unknown`) plus
  `PPM_START_DETAIL` (exit code and signal, a note) — `start-reason.ts`; every decision (what an exit
  means, the first start, resume, revive, failed self-replace) is a pure function in
  `supervisor-start-reason.ts`, table-tested, which `spawnServer` in `supervisor.ts` calls. A health-check kill is `watchdog` whichever exit code it ends with; a first spawn
  within 10 minutes of the machine starting is `boot`. `ppm restart --reason <text>` (a kind by name,
  or free text as a `manual` note) leaves `.restart-reason` in the PPM folder — only once the command
  is about to ask, and removed again when its ask fails — which the supervisor consumes once at its
  next manual spawn and ignores after 5 minutes (every spawn deletes one that old, unread); an external RAM watchdog that
  says nothing shows up as `manual`.
- **Who asked.** `ppm restart`, `ppm stop` and `ppm upgrade` first append one `[restart-caller]`
  line to `ppm.log` (`restart-caller.ts`): the command's pid, its parent, grandparent and up to two
  more ancestors with their command lines (one PowerShell CIM walk on Windows, `/proc` on Linux,
  `ps` on macOS — `restart-caller-process-chain.ts`), the working folder, `PPM_AI_CHAT`,
  `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PID`, `CODEX_THREAD_ID`, `AI_AGENT`, and the `--reason`. Command
  lines go through `redactLogText` plus a rule for `--token value`-style arguments first. A short
  form (`ppm restart (pid N) under <name pid> ← …, from an AI chat (session …)`) rides as
  `requestedBy` in the Windows command file and in `.restart-reason` — now written by every
  `ppm restart`, `--reason` or not; one with no reason keeps the supervisor's own words and only adds
  the asker — and reaches the server as `PPM_START_REQUESTED_BY`, so the supervisor's
  "Windows command: restart server only" / "SIGUSR2 received" line, the server's "Server run started"
  line and the restart news all say who asked. A command the supervisor receives with no
  `requestedBy` is logged as "no caller recorded": a hand-written `.supervisor-cmd`, a bare signal or
  an older `ppm`. Git Bash (MSYS) processes report a Windows parent that has already exited, so the
  walk often stops at the shell; `CLAUDE_PID` and the session id still name the chat.
- **The run log.** The server records `{pid, version, startedAt}` at boot and `stoppedAt` with the
  trigger on a graceful shutdown (`restart-news-run.ts`, config row `server_run_log`, last 20 runs —
  a row of the database the server runs on, so a dev server never reads the live one's runs). The next
  start compares: a version change becomes `from → to`; a run with no stop is a dirty stop; and with
  no supervisor-given reason a dirty stop reads as a crash of unknown cause (`server-run-log.ts`).
  On Windows the supervisor ends the server with TerminateProcess, so the server never writes its
  stop: before every stop it orders (restart, stop, upgrade, health check, its own shutdown) the
  supervisor leaves `.server-stop.<pid>.json` with the reason (`ordered-stop-note.ts`), the next
  start consumes the note matching its previous run's pid, and the news says "stopped on purpose
  by PPM" instead of "did not shut down cleanly" — which is kept for a stop nothing explains.
  `ppm stop --kill`, `ppm down`, `ppm stop --all` and `ppm restart`'s dead-supervisor recovery
  TerminateProcess the supervisor itself, so `stop.ts` writes the same note for a server still
  running before it kills anything. When the health check's kill fails and the server answers
  again, the supervisor deletes its note, so a later real crash of that server is not excused.
- **Cut-off chats** come from the session trace (`interrupted-chats.ts`): among rows written during
  the previous run (at most 24 h back), a chat whose last top-level turn has no `done`,
  `run_failed`, `turn_aborted`, `run_closed` or final `error`. That includes a turn no message
  opened: the Claude CLI carries on by itself when a background task it ran ends, so turn work
  (`tool_use`, `text`, `thinking`) written after the last turn's end is a turn cut off too. Rows
  with no `turn_id` are a turn nobody opened, listed with `continued` and no prompt; rows with one
  are a follow-up queued while the previous turn ran, whose message was written before that turn's
  end, listed with that message as its prompt. An approval request is not turn work here, since a
  background agent asks for one between turns. A cut-off chat whose background work the shutdown
  killed (the window below) carries it as `killedTasks`, and the news names it in one line ("Its
  background work … was killed at shutdown"), so the Assistant tells the chat when asking it to carry
  on; the background scan finds these for chats it skips (`killedInCutOff`, attached by
  `withKilledTasks`). Before this, a
  reboot that killed a chat's shell and then PPM, seconds apart, read as "no chat was cut off".
  Left out: chats the new run already
  wrote to, the Assistant's own and design sessions, API proxy streams, a turn started by the
  `ppm chat` CLI (its process outlives the server and usually still drives the session) or by an
  extension (its AI budget is the extension's to spend) — browser, Telegram, schedule, scheduler,
  Jira, session-tool and Assistant turns stay listed — and any session this
  database does not place in a registered project — `session-trace.db` is one file per PPM folder,
  shared by `ppm.db`, `ppm.dev.db` and the `ppm chat` CLI, so without that check a dev restart would
  report live chats (and hand their prompts to the dev Assistant). Each entry carries project,
  title, provider, the turn's first prompt line, what it was last doing, an approval it was waiting on
  (`approval_request` with no `approval_resolved`), how many cards about it were open, whether it is
  its project's manager and the chat that opened it (`spawned_by`). At most 30 are listed.
- **Chats whose background work stopped** (`background-work-chats.ts`): a chat between turns can
  still have a `run_in_background` shell, a backgrounded agent, a Monitor or an agent woken by
  `SendMessage` running in its CLI. PPM tracks that only in memory (`hasBackgroundWork`), and on
  Windows nothing runs on the way down, so it is read back from the trace: a `task_started` in the
  previous run with no terminal `task_updated`/`task_notification` and no `run_closed`, `run_failed`
  or `turn_aborted` after it (each closes the CLI). A task that ended `failed` or `killed` in the
  last minute of the previous run (`SHUTDOWN_KILL_WINDOW_MS`) counts as still running when no
  `done` came after it: a shutting-down machine kills the shells before PPM, and the CLI reports
  them failed before the trace stops. The run's end is its recorded `stoppedAt`, or for a run that
  wrote none its last trace row other than a `ppm chat` process's (another instance writing to the
  same trace file can still move it later, which only misses kills). Same filters and cap as the cut-off list, and a
  chat already listed there is not listed again (across two restarts, the later one's entry wins;
  a chat whose background work two restarts stopped keeps the tasks of both, each once).
  Each chat carries up to 5 tasks with the tool, what it was for — or, only when nothing says, its
  command's first line with credentials taken out (`background-command-text.ts`: `-p…`, `user:pass`,
  `--password`, `*_TOKEN=`, `Authorization:` on top of the log redaction) — and when it started,
  plus what became of it: `alive` when its `<claude temp>/<folder>/<session>/tasks/<task>.output` was written after
  the restart (`task-output-file.ts`; asked again when the news goes out), `stopped` for work that
  ran inside the CLI (agents), `unknown` otherwise — the shell ended with the server, but what it
  started outside PPM (a container, a detached process) may still run.
- **Delivery.** `startRestartNews()` runs in the hub startup before the cards start the wake queue
  and adds this start to the `restart` wake source (`restart-news-source.ts`, config row
  `assistant_restart_news`, so a crash before delivery keeps it). The first run a database ever
  records (a new install) has no previous run and queues nothing. Everything not yet told is one
  item: a restart before delivery (waiting in the queue, or carried by a turn that never ended with
  an answer) merges its restarts, cut-off chats and stopped background work into it, each chat once;
  a delivered or stopped turn clears only what it carried; three failed turns drop it. The item is
  never held by the wake queue's hourly cap (`capExempt`): the 15/11 16:47 restart waited 8 minutes
  behind it while two chats stayed cut off. The merge is what keeps a restart loop to one turn at a
  time, and the turn still counts toward the cap for every other kind of news. Each listed chat is checked again when the news goes out (it can wait hours: a busy
  Assistant, the hourly cap, no main session yet): one deleted since, or with a trace row after the
  restart that found it, is dropped, and urgency is worked out from what is left. A restart pending
  for more than 24 h is dropped with a log line (`RESTART_NEWS_MAX_AGE_MS`). It is urgent — passes quiet hours — only when a chat was cut off
  or had its background work stopped (`RESTART_NEWS_URGENT_WHEN` in `assistant-limits.ts`). Settings → PPM Assistant → Digest & quiet
  hours → Restarts ("Tell the Assistant after PPM restarts", `restart_news`, default on) gates the
  news only — switching it off also drops news already waiting — and the run log is always written. Nothing goes to Telegram directly.
- **What the Assistant does.** The entry (`restart-news-text.ts`) lists the restarts, then the steps,
  then the cut-off chats and then the chats whose background work stopped, each by project with
  manager first and the chats it opened under it (the steps come before the lists so the
  14,000-character cap cuts chats, never the steps), and asks for one card-free message per affected
  manager naming its listed chats, and a line to the user for projects with no manager. For
  background work the state decides: `stopped` may be started again if still needed, `alive` is only
  checked on, and `unknown` is never started again until the user says so — the manager reports
  `needs_decision` first, naming the task and that it may still run outside PPM, because some work
  (a deploy, a migration) does harm when it runs twice. A manager treats a PPM-started turn as a status ask. The server adds the provenance
  reason `restart` only to a message to a manager whose project has chats listed in the news that
  wake turn carries (cut off, or with background work stopped), and puts those chats' session ids in
  the block (`restartChats`, at most 60, written from the news by `restartChatsCarried`, never from
  the Assistant's text; `restart` without the ids is refused on decode). Any other
  message of that turn reads as a plain status ask. The manager rules allow one thing on it: tell
  only the chats listed in the provenance block to carry on with their own task
  (`manager-context-entry.ts`), with the same three rules for background work. Messages to those same managers pass quiet hours in the urgent turn
  (`assistantQuietNow` in `assistant-send-guards-live.ts`); every other message still waits, and the
  hourly and daily budgets and the pair limit still apply.
- **Quoting a title is not a secret.** A message to a manager that looks like it holds a secret is
  refused in a turn PPM started (`looksLikeSecret` in `assistant-send-guards.ts`). Chat titles go
  into the news as written, so a title like "Reset password: BE …" matched the named-field rule
  (`password: …`) and the Assistant's messages quoting it were refused twice on 16/11. The check now
  leaves out a match that sits word for word in text PPM itself put into the restart news that wake
  turn carries for that same project (titles, prompts, task descriptions and commands:
  `restartTextCarried`, wired as `restartNewsText` in `collab-env.ts`; control characters are taken
  out of the message first, as the redactor does), and only a match of a rule
  that knows a secret by the name in front of it (`SECRET_RULES.named` in `log-redact.ts`, and
  `pwd=`). A key known by its shape (`sk-`, `ghp_`, a JWT, a PEM key, `AKIA…`, a bot token, a URL
  password) refuses wherever it sits, the quoted title included. The rules themselves are unchanged,
  because the same rules hide secrets in logs and reports.
- **e2e.** `tests/e2e/assistant-restart-news-e2e.mjs` restarts the Assistant fixture on one PPM
  folder (SIGKILL for a crash, SIGTERM for a clean stop, `PPM_START_REASON` as the supervisor sets
  it) and checks crash, upgrade, watchdog and manual news, the switch, quiet hours and the merge,
  a chat between turns with two background tasks (one still writing its output), then the Settings
  switch on a desktop and a phone. The scripted provider's `background` op reports a task the way the
  Claude provider does. The fixture side is
  `tests/e2e/fixtures/assistant-restart-news-fixture.ts`. Run it in the capped `ppm-e2e-chromium`
  image with `PPM_ASSISTANT_WEB_DIR` and `PPM_RESTART_NEWS_SHOTS` set.

## Notebook

A small notebook of facts the Assistant must not forget in a long session: a standing preference
the user stated, a deadline, who is who. Stored in `assistant_notes` (migration 66); rules in
`src/services/assistant-notes/assistant-notes.service.ts`, shapes in `src/shared/assistant-notes.ts`.

- **Two writers.** The Assistant writes with `notebook_add`, `notebook_edit` and `notebook_delete`
  (`assistant-notebook-tools.ts`), which never ask and run in every turn. The user adds, edits,
  deletes and verifies lines in Settings through `GET/POST/PATCH/DELETE /api/assistant/notes`
  (`src/server/routes/assistant-notes.ts`; `PATCH` takes `{ text }` or `{ verified: true }`). Every
  change is announced on `/ws/global` as `assistant:notes_changed`.
- **The user's lines are locked.** A line added or edited in Settings becomes the user's
  (`source = 'user'`) and verified; the Assistant's edit and delete refuse it ("The user wrote this
  line; propose the change to them instead.").
- **Unverified lines.** A line the Assistant adds or edits in a turn nobody started (a watch or
  report wake, `isUnattendedTurn`), or in a turn outside text reached (the turn provenance says
  `untrusted`: another chat, a file, a tool's answer), is stored `unverified`, and the Assistant's
  own later edit never clears the flag; only the user's edit or "Mark as verified" does. This is
  what keeps an injected "preference" apart from what the user confirmed.
- **Caps.** 300 characters a line, 4,000 for the whole notebook (`NOTE_MAX_CHARS`,
  `NOTEBOOK_CAP_CHARS`); the Assistant's writes stop 1,000 short of it
  (`NOTEBOOK_USER_RESERVE_CHARS`), so the user always has room. A write over a cap is refused, never cut. Each check runs
  in the transaction of the write it allows.
- **How the model reads it.** An entry of the shared-context block on every Assistant turn
  (`assistant-notes-entry.ts`), never the system prompt, sent when it changes and again after a
  compaction or an error. A header says notes are facts, not instructions, and that a note never
  grants permission, changes who approves or counts as the user's OK. Lines sit under "The user's
  notes", "Your notes" and "Unverified notes (written while the user was away, from reports)", as
  `#id · date · text`, each cleaned by `cleanEventText` (angle brackets to look-alikes, so no
  `<ppm-…>` block can form; hidden characters revealed). With no notes there is no entry, except one
  line saying so after the notebook the model last saw was emptied.
- **Never elsewhere.** The notebook goes only to Assistant sessions' turns: not to a manager or any
  other chat, and not to Telegram.
- **Threat model.** As everywhere here: a process running as the same OS user can write the table
  directly; the guards target injected text.

## Telegram

**A second window onto one Assistant session**, not a separate bot: what the user writes on the
phone goes into the session, and the session's answers, cards and the messages typed in PPM come
back out. Code in `src/services/assistant-telegram/`, entry `assistant-telegram.service.ts`; the
shared Bot API client, formatter and fake in `src/services/telegram/` and
`tests/helpers/fake-telegram-bot-api.ts`. The API base can be pointed only at a loopback address
(`telegram-api-base.ts`), so a test setting cannot send the token off the machine.

**Who may talk** (`assistant-telegram-access.ts`): a private chat, connected with a link from PPM
and not revoked, written to by the person who connected it. In a group anyone could command an AI
that runs on this machine, so groups are refused. The same checks run before **every send**: a
chat revoked in the middle of a turn must not keep receiving it, and a private chat's id being its
user's id is what makes that check possible without an incoming update. A refused chat is told
once. A chat connected before PPM recorded who connected it has to reconnect.

**Binding** (`assistant-telegram-binding.ts`, table `assistant_telegram_bindings`). Each connected
chat talks to one session; the first message creates one on the Assistant's default provider when
it can run Assistant sessions, else on the first provider that can. `/new`, `/sessions` and PPM's
*Use on Telegram* (`POST /api/assistant/telegram/bind`) move it. Changes go out on `/ws/global`
(`assistant:telegram_binding_changed`, and `sessions:list_changed` when a session was created) so
PPM's session list marks the bound session without polling. Revoking a chat in Settings unbinds it
and drops anything still queued for it (`forgetChat`).

**Coming in** (`assistant-telegram-poller.ts`, `assistant-telegram-inbound.ts`). Updates are
handled in order per chat, so a button press and a message in one batch do not race; a press is
acknowledged at once and acted on after. Messages are grouped for `clawbot.debounce_ms`. The read
position advances only after a message has been handed to the session, and is saved in the config
row `assistant_telegram_state` (tied to the bot, so a new token does not inherit an old offset).
A message sent while PPM was off and older than `BACKLOG_AGE_MS` asks *Run* / *Skip* instead of
running unannounced. A forwarded message is wrapped as someone else's words and never read as a
command. Photos up to `MAX_PHOTO_BYTES` reach the session; other files do not. `/start <token>`
goes to the connect code before any access check, since it is how a chat becomes allowed.
A message sent as a reply to anything but a card the card path takes (a reply to a card still
answers that card, as before) carries what it replied to, as Telegram's quote does
(`assistant-telegram-reply-quote.ts`): who sent it (the Assistant, a card of which kind, project
and state, or the user), when, what it carried (a photo, a file and its name, a caption) and its
first `QUOTE_MAX_LINES` lines. It goes as the message's `ppm-reply-v1` block, after the user's
words and labelled data only, through `sendUserMessage`'s `replyTo`, which only a `telegram`
message may carry and only for the chat it is sent to. The old text is old content, so its block
markers are broken, its `<ppm-…>` tags defused and the user-words header marked as quoted before
it is quoted, and each of its lines is prefixed `> ` so none passes for the quote's own header. A
bot message counts as the Assistant's own words only when the mirror recorded it as an answer of
the chat's current session from a turn that stayed trusted (`assistant-telegram-own-answers.ts`,
in memory); every other bot message — a watch report, another chat's card, a notice, a list, an
answer PPM no longer remembers — is quoted as text relayed from elsewhere. Such quotes, cards and
messages the user forwarded or sent through an inline bot (`OUTSIDE_QUOTE_PREFIXES` on the block's
`messageId`) mark the turn `forwarded` in its provenance, as does any reply, in PPM too, whose quote
holds a forwarded part; a message typed through an inline bot is itself wrapped like a forward. A
file's name is quoted as coming from the file, never from the user. A burst of messages answers at most one
message: a reply to another one sends what was gathered first. A card with no manager chat (a
digest — its items — a rules or budget card) still sends its reply to the Assistant, now with the
card quoted; a reply to a card that waited while PPM was off keeps its quote for when *Run* sends it.

**Going out** (`assistant-telegram-mirror.ts`, `assistant-telegram-turn-renderer.ts`,
`assistant-telegram-send-queue.ts`). For each bound session the mirror streams the answer by
editing one message, shows a message typed in PPM as `🖥 (PPM) …` and a watch turn with a 🔔 line,
and hands cards to the card module; tool names appear only when `clawbot.show_tool_calls` is on,
and tool input and output are never sent. Telegram does not notify on an edit, so a turn longer
than `LONG_TURN_MS`, and every watch turn, ends with a **new** message and the draft is deleted.
A `send_to_session` or `create_session` call with `wait: true` that runs past `WAIT_NOTE_AFTER_MS`
(30 s) adds "⏳ Waiting for the chat “…” in … to answer…" under the draft until it returns
(`assistant-telegram-wait-notes.ts`): an edit, never a new message, so it notifies nobody in quiet
hours and spends no send budget.
Each chat has its own send lane: it honours `retry_after` without holding up other chats, never
drops a final answer, splits long answers before Telegram's limit, and re-sends without its URL
button when Telegram refuses the button. After a restart, drafts that were being written say the
answer was cut off and open cards lose their buttons.

**What leaves the machine** goes through `redactForTelegram` (`telegram-html-format.ts`): known
secret shapes (tokens, keys, PEM blocks, cloud and chat-service keys) are hidden. Unlike the log
redaction it keeps PPM's own tunnel or Tailscale address, because that link is how the user gets
back, and it still needs PPM's login. Markdown is escaped before it is converted to Telegram HTML;
PPMBot's formatter did not, and one `<` in an answer made Telegram refuse the whole message.

**Read and quiet.** When a final answer reaches the phone the session is marked read, and its
"Chat completed" / "Waiting for approval" push is held back only if a message to that chat was
actually *sent* within `SUPPRESS_WINDOW_MS`. Basing it on successful sends rather than on polling
means a blocked bot or a failing send still lets the push through.

**Quiet while the user is at PPM** (`assistant-telegram-silence.ts`, switch
`clawbot.quiet_while_in_ppm`, on unless set to false). The user counts as at PPM when a message was
typed in PPM, or a PPM tab saw real input (`presence-tracker.ts`), within `QUIET_WINDOW_MS`
(5 minutes). Then:
- A turn typed in PPM is still mirrored in full, but every message of it goes out with
  `disable_notification`, and its final answer is edited in place rather than re-sent as a new
  message (the re-send exists only to buzz). If the user has been gone for 5 minutes when the
  turn ends, the final answer is re-sent with a sound as before.
- A turn PPM started (a watch, another session), a card, a manager's card, a watch report and a
  `db_execute` notice go out silently too.
- An `urgent` manager card always rings, and so does a card the user asked for with `/status`.
- A turn typed on Telegram, and replies to commands and buttons, are unchanged.

A card that waits on a decision and went out silently (a session's approval or question, a
watched or manager chat's, a manager's `needs_decision`, a `db_execute` approval notice) gets
**one** reminder with a sound if it still waits `clawbot.card_reminder_minutes` later (5 by
default; `CardReminders` in `assistant-telegram-card-reminders.ts`, on the Assistant clock). Cards
of one Telegram chat coming due within 3 minutes of each other (never more than half the delay early) share one message, a line per card
(project · title, a link into PPM when PPM has a public https address); a single card keeps the
reply to the card itself. A card is reminded about once, ever. Quiet hours hold the reminder and,
once they end, one message lists whatever still waits (nothing is sent if every card was answered
or withdrawn meanwhile). `clawbot.card_reminders` turns reminders off (Settings → PPM Assistant →
Telegram, or `settings_set assistant.telegram.card_reminders`); the delay is
`assistant.telegram.card_reminder_minutes` (1–240). A reminder whose `sendMessage` times out is not
sent again: it may have arrived (`assistant-telegram-send-queue.ts` sends any message again at most
once after a timeout, after 30 s, and a reminder never). The quiet switch is changed in Settings, by `/quiet` on the
phone or by the bell in the Assistant window; each change goes out as
`assistant:telegram_quiet_changed` on `/ws/global`, so the three stay in step. Off, everything goes
out with a sound as it did before. Reminders live in memory: a restart drops them, as it drops the
cards' buttons. `PPM_TELEGRAM_QUIET_MS` shortens the window for a demo or an e2e.

**The pinned card desk** (`clawbot.card_desk`, off until the user answers the
`telegram-card-desk-2026-11` question; Settings → PPM Assistant → Sessions & Telegram, or
`settings_set assistant.telegram.card_desk`). Each Telegram chat gets one message, pinned once and
then only edited, that lists every card still waiting there (urgent first, then oldest first, at
most 10 lines) and shows one of them whole with its own buttons; numbers (‹ n / N › past eight)
move between cards, and "↩ Go to the card's message" sends a line quoting the card.
`assistant-telegram-cards-desk.ts` keeps it, `-desk-draw.ts` draws it, `-desk-store.ts` keeps its
message id in the `assistant_telegram_card_desk` config row. Three things are load-bearing:

- **The card part is the card's own view.** Every module that puts a waiting card on the phone
  (`AssistantTelegramCards`, the manager cards, the `db_execute` notices) `put`s it with its HTML and
  its buttons once Telegram has the message, and `remove`s it when it ends; an entry is also asked
  `stillWaiting()` at every draw. The buttons are the card's own codes, so a press on the desk is a
  press on the card, Allow included only where the card offered it. When the card and the list do
  not fit in 4096 characters the list shrinks to a count, and a card that still does not fit is shown
  without its buttons.
- **A reply to the desk answers the card the phone showed when it was written, or nothing.** The
  desk moves by itself (a card answered in PPM, a new urgent one), so the card it is about to show
  is not the one the user read. `shown` is set only once Telegram confirmed an edit, and
  `deskReplyFor` (`-desk-reply.ts`) routes a reply (`throughDesk` in the inbound router, by the
  message's date) only when that card was up before it was written and either the user moved the
  desk there by pressing on it or it had been up a minute (`DESK_REPLY_SETTLE_MS`); otherwise, and
  for a card too long to show or a desk `/cards` moved, the reply is not sent and one line says so.
  A press on the desk is spent by the next move, so a later move the desk makes by itself never
  counts as the user's.
- **Edits never ring**, so new cards still arrive as their own messages; with the desk on, a card's
  reminder is one line with a sound replying to the desk. The desk is always sent silently.
- **Codes and restarts.** Every five minutes (`DESK_TICK_MS`) the listed cards' code groups are
  renewed (`ButtonCodes.renewGroup`) and ages redrawn; a draw identical to the last is skipped. After
  a restart the stored message is edited, and the manager's open cards come back on it with fresh
  codes (`restoreDesk`); approvals do not, their request ended with the chat. A desk the user deleted
  is sent again and pinned again. A send that may have arrived is not repeated: its codes are dropped
  and the next change sends a fresh desk. `/cards` unpins the old desk, edits it to "moved down" and
  pins a new one at the bottom (a pin leaves a "pinned" line the bot cannot delete, so it pins only
  then). Switched off, a pinned desk is unpinned and says so.

### Cards and the Allow rule

A session's card appears on Telegram as the same card: whichever answer comes first, in PPM or on
the phone, wins, and the other copy loses its buttons. **Allow is offered only when the card's
whole deciding input is on the card** — escaped and within `REVIEW_FIT_MAX`
(`assistant-telegram-card-format.ts`), measured on the text before anything is hidden. Otherwise
the card shows a preview marked "Too long to review here" with Deny and Open in PPM only. Once a
secret-looking value had to be hidden, no card offers Allow — a command, a file write or edit, an
MCP tool call and a prompt sent to another chat alike — because the hidden part could be the very
thing that runs; the card says how many values it hid and offers Deny and Open in PPM. Only a
question card keeps its choices, since answering one runs nothing by itself. Allow is a promise
that the person saw what they allowed; a phone screen that shows half a command cannot make it.

**The session tools' cards** (a message the Assistant wants to send, a chat it wants to open) are
PPM's own approvals, answered over HTTP in PPM; in an Assistant session they are also told to the
lifecycle bus (`chat-collab-approval-relay.ts`), so they reach Telegram under the same Allow rule
(their deciding input is `collab-deciding-input.ts`). A press settles the card that Assistant session
is showing, through the session tools' broker, as Allow once or Deny; nothing settles them "for the
session", and the Assistant answering a card never does.

Questions show their choices as buttons. One question with one choice is answered by the press.
Anything else — several questions, or a question that takes several choices — is asked one
question at a time in the same message (`assistant-telegram-question-wizard.ts`): "Question k/n"
with only that question's buttons, a pick moving on, ticks (✓) plus Next for a question that takes
several, Back from the second step on, and a summary with Send and Back at the end. Each step edits
the message; only Send answers the card, every question at once. A card with a question that
only takes typed or private text is shown whole and points to PPM. Buttons carry random codes bound
to the chat they were sent to (`assistant-telegram-button-codes.ts`), all made when the card is
shown: a step only chooses which to show, and a button left over from another step changes
nothing but redraws the current step. A step that cannot be drawn ends the card on Telegram ("answer
it in PPM"), and a full code store evicts whole cards, never part of one.
Answering spends every code of that card, and after a restart every code is "no longer valid", so
nothing pressed on an old card can run.

**Relayed cards** (`assistant-telegram-relay.ts`). A watched chat's card goes to the chats bound to
the Assistant session that set the watch, or to every connected chat when that session is
unbound. Pressing a button answers the watched chat directly, with no model turn — safe because a
person pressed it, and the Allow rule guarantees they saw what it allows. The relay also sends
reports of unbound sessions' watches to every connected chat. A card is shown once per chat, even
when two watches and `/status` all want it. In quiet hours a watched chat's card is held
(`assistant-telegram-quiet-hold.ts`) and sent when they end, to the chats bound then, only if that
chat still shows the request; one answered meanwhile is skipped. The hold is in memory: a restart
drops it, and the card itself stays in PPM for as long as the chat shows it.

**Database notices** (`assistant-telegram-db-notices.ts`). A chat's `db_execute` waiting for
approval, the reminder 5 minutes before it gives up, and a connection nobody has logged in to
(`db-attention-events.ts`, see [AI database tools](ai-chat-and-providers.md)) reach every
connected chat as notices: project, chat, connection and database, and for a change the SQL
(redacted, then cut at 600 characters) and the AI's reason, with an *Open in PPM* link and no
other button. A script or reason that mentions a password is not shown at all: SQL spells a
password literal in too many ways for a pattern to be trusted with it. Answering takes PPM's password and logging in takes the database's, and neither is
asked for or taken on Telegram; every notice says so. In quiet hours the approval's notice is held
like a watched chat's card and sent at their end if the change still waits; the reminder and the
login notice are dropped.

### Manager cards, replies and quiet hours

**Cards on the phone** (`card-outbound.ts`, `assistant-telegram-manager-cards.ts`,
`assistant-telegram-card-kinds.ts`). Every card the Assistant stores goes to every connected chat
once the gate lets it. A manager's approval or question goes out as the relay's own card (same
Allow rule, answers the manager chat directly); every other kind is formatted per kind. A project's
`telegram_detail` (`full` or `title`) decides how much: at `title` the phone gets the kind, the
project and the title only — no body, draft or diff, no OK, and an approval offers Deny alone. A
project's level is read from its manager row, else from the one kept since its last manager; a
card of a project PPM has no level for goes at `title`. A card Telegram refuses for good (a 400)
is not retried; the reason is kept in `assistant_cards.outbound_error` (migration 68). The
message ids are stored on the card as `(chatId, messageId)` pairs (`telegram_refs_json`), because
Telegram counts ids per chat. When a card stops waiting, every copy loses its buttons and says how.
The "Waiting for approval" push for a manager chat's request is held back while its card reaches
the phone; no other push changes.

**OK** (`card-ok-rule.ts`, `card-reply-actions.ts`). A needs-decision card offers "OK, send" ("OK"
with no draft) only when its title, body and draft fit `REVIEW_FIT_MAX` whole, nothing in them
was hidden as a secret, and the whole card fits one Telegram message as it would be shown (hidden
characters revealed; `TELEGRAM_CARD_ROOM`) — Allow's bar, the same in PPM and on Telegram. A
decision too long for that goes out as a preview without the button. A held rules change offers
Approve change only when its card carries the whole change (every added and removed line, in file
order, uncut and unaltered: `rulesComplete`); otherwise it is reviewed in Settings. `POST /cards/:id/ok
{draftSha256}` (and the button, whose code carries the hash it showed) must name the card's draft;
the card goes `open → answered` by compare-and-set first, so the first OK on any surface forwards
and a later one is told "Already answered on Telegram at 22:41". A forward that fails opens the
card again.

**Choices** (`options` on `report_to_assistant`). A needs-decision or urgent card may offer 2 to 6
choices (`{id, label, description?}`, never with a draft) instead of an OK: one stacked button per
choice in PPM (`card-choices.tsx`) and one inline button per row on Telegram, numbered as the text
lists them. They meet the OK's bar (labels and descriptions are read by `cardOkOffered`); a card
that misses it lists the choices with no button. `POST /cards/:id/choose {optionId}` (the Telegram
button's code keeps the id on the server) looks the choice up on the stored card, answers it the
same compare-and-set way and forwards `I choose: <label>` with `choice: {id, label}` in the
user-words block; a card with choices takes no OK and a card without takes no choice. A report
whose title or body lists choices as text ("(1)… (2)…", "A) … B) …") without `options` gets a note
back and a warning in the log (`card-choices-in-text.ts`); PPM never builds buttons from the text.

The answer carries `delivery`: words that started or joined a turn are `delivered`;
words queued behind the manager's running turn stay `pending` until a `turn_started` names their
client id (`card-delivery.ts`). A card still pending two minutes after the turn it waited on
ended, or at startup, is opened again with "Your answer did not reach the manager chat; send it
again." — on Telegram as a new copy.

**The user's own words** (`forward-verbatim.ts`, `src/server/ws/chat-user-words.ts`). A reply —
`POST /cards/:id/reply {text, force?}` from the reply-to bar in PPM, or a Telegram message sent as
a reply to a card's message — goes to the card's manager chat **word for word**, followed by a
`<ppm-user-words-v1>` block (`src/shared/user-words-block.ts`) that names the card by id, the
channel and the time, and for an OK the draft's hash and recipient. Its header reads "Typed by the
user, forwarded word for word by PPM". Only `forward-verbatim.ts` builds one; every other door,
the forwarded text included, breaks its markers, and a unit test checks the source for any second
writer. A card that stopped waiting or is older than `STALE_REPLY_MS` asks "send anyway?" first
(on Telegram a card that was decided is refused instead, see Answering above). A
reply to an approval or question card refuses that request, as typing in the manager chat would,
unless the question on screen takes typed text: then the reply is its answer, as the message after
the card's "✏️ Other" button is (`assistant-telegram-typed-answers.ts`; a card asked step by step
still answers only with Send, and any other button, Cancel or ten minutes end that wait);
any other forward waits behind a pending request. Forwarding resets the pair counts, leaves a line
for the Assistant's next turn (no turn is started for it) and records the device and fetch site, or
the Telegram chat, in the session trace. A card with no manager (digest, rules, budget) takes no
reply in PPM; a Telegram reply to one goes to the Assistant as an ordinary message.

**Telegram replies** are matched after the access and backlog checks, with the chat's gathered
messages flushed first and the reply never merged into them. A forwarded message, or one sent
through an inline bot, is someone else's words and never answers a card.

**The manager's answer to a reply** (`card-reply-followup-tracker.ts`, `card-reply-followup.ts`,
`assistant-telegram-card-followups.ts`, `assistant-telegram-followup-format.ts`). A reply is often
a question, or agrees on a wrong premise ("go ahead, it won't cost much quota, right?"), and its
answer used to stay in the manager chat, which a user on their phone never opens. Two parts:

- The block every manager turn carries says such a reply is **not an OK**
  (`MANAGER_CARD_REPLY_RULE` in `manager-context-entry.ts`): do nothing yet, open a new
  needs-decision card **first**, then answer and correct the premise with the numbers as the
  **last** thing in the turn, no tool call after it. It also says the answer goes to the user's
  phone, so it is a few lines under a report's limits (no client personal or tax data, ticket ids):
  redaction catches secret-shaped strings, never a client's name or tax figures.
- PPM follows the turn the reply opened and sends that turn's answer back. A text reply (never an
  OK) is sent under a `card-<uuid>` id chosen before the send, so the turn a provider names with it
  (`turn_started`) is the one, however many turns run in between or the words wait in a queue.
- **A reply pushed into a running turn is never named.** The bundled Claude CLI runs
  `UserPromptSubmit` only for a prompt that opens a turn; a push folded into a running turn becomes
  an attachment PPM never sees. Such a reply is judged **once**, against the first turn end after
  it went in: after a 3 s grace it is answered only if its own turn has not been named meanwhile,
  the chat is idle, and `liveState().turnId` is still the turn that ended (and the one running when
  the words went in). If a turn PPM started (a schedule, the Assistant, another chat's message)
  opened in between, nothing is sent: that turn may be answering someone else, and later turns are
  never judged for the reply (its own `turn_started` can still claim it). `turnId` moves only for
  prompts PPM pushed (`claude-prompt-turn-binder.ts`), so a task-notification or CLI-continuation
  turn in between goes unseen — but what is sent is always the snapshot taken at the first turn
  end, so no later turn's text can leak. Queued words are never judged this way.
- The answer is the turn's top-level text **from the reply on**, gathered per reply as blocks split
  at each top-level tool call (no tool output, thinking or subagent text). With no tool call it is
  the whole text, however short. Around tool calls: a line that only confirms the call ("Card
  sent.", "Đã gửi card.", "Done.": `isConfirmationBlock`) is dropped when the turn opened a card.
  A turn that opened no card sends every block, in order ("Không ạ, đắt lắm." → mail tool → "Done."
  sends both lines). In a turn that opened a card, another short line
  (one line, under 40 characters, no digit, no question mark) is dropped only when a longer real
  block is there, and with none the last remaining block is the answer — so "card first, then
  'Được anh.'" arrives, and so does an answer written before the card. The rest is joined. Within
  1500 characters the last real block (the answer, since the rule puts it last) stays whole: earlier
  blocks go first, the one beside the answer cut with "…"; an answer longer than that on its own is
  cut by the follow-up with "see the chat". At most one follow-up per reply, nothing for a turn
  that wrote only confirmations.
  It is kept on the card as `card.followUp` (beside `answer`, never in a made-up one: a done report
  nobody answered keeps `answer: null`), cut to `CARD_FOLLOWUP_MAX_CHARS` = 1500, and shown under
  it in PPM. Nothing is kept or sent when the card waits again (its words were reported lost).
  Beside it, `followUp.reply` keeps the start of the user's reply for the folded card's preview:
  the words go from `forwardUserWords` to the tracker with the reply, are scrubbed whole by the
  vault scrubber, then cut to plain text of `CARD_REPLY_PREVIEW_CHARS` = 160; they are never handed
  to the Telegram bridge. The Telegram copy of the card is not edited to add the answer: the answer
  already goes there as its own message under the card, and editing a message makes no sound.
- **A turn that is stopped or fails** has no answer: its partial text is never sent or kept. That
  includes a Stop reported as a normal end: on the first turn of a fresh Claude subprocess an
  aborted turn ends with `done`, so `turn_ended` carries `outcome: "done"` with `cancelledBy` set,
  and `followupOutcome` reads `cancelledBy` as stopped. A reply typed on Telegram gets one line, "The manager's turn was stopped before it answered; see
  the chat.", with the link; a reply typed in PPM gets nothing.
- On Telegram it goes **under the card's message**: redacted before the cut, hidden characters
  shown, escaped through the Markdown formatter, "… see the chat for the rest." past 1500
  characters, and an Open in PPM link. A project at `title` detail gets only "the manager
  answered" and the link. A reply typed on Telegram is answered in that chat with a sound whatever
  "quiet while I'm at PPM" or quiet hours say, for `CARD_FOLLOWUP_LOUD_MS` (30 min) after the reply
  — the user is holding the phone; a later answer (the reply started a long task) comes silently
  while the user is at PPM or in quiet hours. A reply typed in PPM goes under each Telegram copy of
  the card: silent while the user is at PPM, and not at all in quiet hours (nothing is saved up for
  the morning: the answer is already under the card in PPM).
- **A turn that opened a card answers with that card, and its text is never passed on** — not to
  Telegram, not under the card in PPM. The two used to arrive side by side and read as the same
  message twice (the rule tells the manager to put the answer in the card's body and end with one
  line pointing to it). The card (any kind but a relayed approval or question) goes to Telegram as
  a **reply to the user's own message** (`messageId` on the follow-up origin, else the card they
  replied to), with a sound for `CARD_FOLLOWUP_LOUD_MS`, and is not held by quiet hours in that
  window (`answersPhone` in `card-outbound.ts`); the bridge marks it threaded
  (`AssistantTelegramManagerCards.threadedIn`) the moment it is handed over, before any await, so
  the follow-up that comes at the turn's end sends nothing. A card that did not go under the reply
  (refused, or an approval relayed on its own) is named in one line, "↩ The manager answered with a
  new card: <title>", under the card replied to. A reply typed in PPM gets nothing on Telegram
  either way: the card goes out by itself, as every card does. In PPM, `card.followUp` keeps
  `newCards` and an empty `text`, and the old card shows "The manager answered your reply with a new
  card" with Show while that card waits. Who answers is asked of `cardReplyFollowups.answering`, a
  pure query, so the order of the listeners that ask it does not matter.
- Only a card the manager **reported itself** (`isAnswerCard`: a `REPORT_KINDS` kind, not a
  failure PPM detected) is the answer, and only one made after the reply (`createdAt >= repliedAt`)
  is threaded under it or let past quiet hours. An approval or question PPM mirrors from the chat in
  that turn leaves the text answer as it was, and a card held overnight that goes out while a later
  reply's turn runs is not threaded under that reply.
- If the card under the reply is refused after the follow-up already counted on it, the one-line
  pointer goes out from its `onDropped` instead. (That exposed a send-queue bug, now fixed: a task
  queued from inside `onDropped` started a second loop on the lane and was sent twice; `pumping`
  in `assistant-telegram-send-queue.ts` keeps one loop per lane.)
- **Late-reply news for that turn says the user has the answer.** An Assistant message a manager
  had not answered yet makes its next turn end news for the Assistant (`expectReply`). When that
  turn also answers a card reply, its answer already reached the user, so the news carries
  `userHasAnswer` and tells the Assistant not to repeat it — it still hears it, since the same turn
  may answer its own message too (`answersCardReply`, asked before the follow-up tracker's own
  `turn_ended` listener forgets the reply, since the signals start first).
- The answer's Telegram message is recorded as one of the card's messages, marked `followUp`, so a
  reply to it reaches the same manager like a reply to the card (the card is answered by then, so
  it asks "send anyway?"; a card that was decided rather than answered in words is refused). That holds for a bare OK too, and for an OK to the "stopped" notice: it
  is never routed to a new card the answer named. Routing it there once let an "ok, noted" approve
  a card the user never saw (one named only by title, held back in quiet hours, or behind a notice
  that named nothing), so a decision on a new card is taken only on that card. A follow-up is never
  rewritten when the card changes, nor answered under as one of the card's copies, and follow-up
  refs are capped apart (the newest 5) from the card's own copies (20), so many replies cannot push
  the card's copies out. The acknowledgement says "If the manager answers, it will
  come here." — no promise, since several of the cases above send nothing.

**Quiet hours** (`quiet_hours` and `timezone` in Settings → PPM Assistant). Inside the window every
card but an `urgent` one, or one answering a reply typed on Telegram within the last 30 minutes, is
`held` in the database; past two urgent reports per manager per window
an urgent report is already a held decision. A clock timer at the window's end — or the bridge
starting after a window that ended while PPM was off — sends "While you were away: N items" and
the held cards, oldest first, skipping any that stopped waiting meanwhile. The end is worked out in
the user's zone, corrected once for a clock change inside the window. The user's own conversation
with the Assistant is never held, and wake turns are held by the wake queue itself. A watched
chat's approval or question is held too (see Relayed cards above): only `urgent` reaches the phone
in quiet hours.

### Morning digest

`src/services/assistant-digest/`. Once a day, at `digest.time` in `timezone` (Settings → PPM
Assistant; on by default at 08:00, the zone being the one the browser saved, else the server's),
PPM asks every manager chat whose digest switch is on (`PATCH /api/assistant/managers/:project
{digest}`) for a short status, and puts the answers on one "Morning digest" card.

- **One timer.** `digest-next-fire.ts` works out the next `HH:MM` on the zone's clock from `Intl`
  offsets (a time a spring-forward night skips becomes the first minute after it), and the service
  arms one timer on the injectable clock for it. A Settings save re-arms it. Tests move the clock.
- **The ask** is fixed PPM text (`DIGEST_ASK_TEXT`), delivered through the session door with origin
  `session`, the main Assistant session as sender, a provenance block (`startedBy: "ppm"`, nothing
  untrusted, reason `morning_digest`), and priority `later`: it waits for a running manager turn to
  end and never joins it. With no manager switched on, or no main session, nothing runs.
- **The run** lives in the config row `assistant_digest_state` (`digest-state.ts`) and is written
  **before** the first ask, so a crash loop finds it and never asks twice for the same date. It
  records which chats were asked, each ask's client id, which asks a turn took (`turn_started`
  naming that id, or an answer), and the answers.
- **Answers** arrive as `report_to_assistant` with kind `digest`: cleaned like every report field,
  at most 12 items, one answer per asked project (a second replaces the first). An answer from a
  chat that was not asked, or after the digest was put together, is refused with a hint to report
  it as `done` or `needs_decision` instead.
- **The card** is made when every asked project answered or `DIGEST_ANSWER_WINDOW_MS` (60 min)
  passed: kind `digest`, no project, payload `{date, projects: [{name, state, items, titleOnly?, waiting?, waitingMore?, waitingMine?}],
  resurfaced?}`, where `resurfaced` is PPM's own "Back from snooze today" section — the tasks of
  any project with Tasks on that came back from a snooze that day (`digest-resurfaced-tasks.ts`, the
  sweep run first), by code and title, listed first on the card and on Telegram; a snoozed task is
  in no project's waiting list;
  title "Morning digest · N projects, M items", provenance "Put together by PPM; each item was
  written by that project's manager AI". A project with no answer shows "No answer yet (busy)";
  nothing is retried that day. The card goes out through the quiet-hours gate like any other
  (held, then sent at the window's end) and wakes the main Assistant session once, with the items
  (prefixed by project, at most 12) as quoted news. On Telegram a project at the `title` detail
  level shows only how many items it has.
- **Waiting tasks.** Under the manager's items each section lists the project's waiting tasks, read
  by PPM itself from the task store when the card is made (`digest-waiting-tasks.ts`), so this part
  is never a model's words: code, title, on whom and until when, the user's own first, at most
  `DIGEST_WAITING_MAX` (8) with the rest counted. On Telegram a `title`-level project gives only the
  count. The managers are not asked to word waits themselves, so nothing is listed twice.
- **Restarts.** At startup a run past its deadline is put together at once; before the deadline,
  an ask no turn took (a `later` message dies with the CLI's input queue) is handed over once more,
  and never a second time. A digest whose time passed while PPM was off runs at startup when it is
  less than `DIGEST_CATCH_UP_MS` (3 h) late, and is skipped otherwise.

### Commands, links and settings

Commands are `BOT_COMMANDS` in `assistant-telegram-commands.ts` (`/new`, `/sessions`, `/status`,
`/tasks [project]`, `/cards`, `/stop`, `/quiet [on|off]`, `/help`, plus `/start`). `/quiet` alone shows the
quiet switch with a button that flips it. `/status` is `chats_attention` in a message
(`assistant-telegram-status.ts`), followed by the cards it lists with working buttons. There is no
`/restart`: a restart is a change, and the Assistant can run `ppm restart` in a shell, which asks.

**`/tasks`** pages the open tasks of every project with Tasks on (or one named project) in "what to
do first" order, one task per card, with no AI turn (`assistant-telegram-tasks-deck*.ts`,
`assistant-telegram-task-actions.ts`, card wording in `assistant-telegram-task-card.ts`). A deck is
a snapshot of task ids held in memory beside the button codes, gone after a restart like them; a
task whose project was switched off or that was deleted drops out when it comes up, and so does one
snoozed since. Snoozed tasks are not in a deck; a line under each card ("💤 N snoozed") says how many
were left out. A waiting task's card carries the app's waiting line ("✋ **Waiting on you** · Due
tomorrow", "⏳ Waiting on Việt · for 2 days"), its due date moved onto that line. The status
buttons are that project's own statuses. A press writes the task as the user (`via: telegram`)
against the revision the card showed, so a change made elsewhere in between is never overwritten:
the card is redrawn as "Changed elsewhere". After a status change in a project with a manager chat
the card asks "Tell manager now / Next turn" once per task per deck and moves on only when answered
(the same wake and budget as [Tasks](#tasks)); otherwise it moves to the next task after two
seconds. Undo of the last press stays on top of the next card, "Show open children" lists a task's
open children, and a project filter narrows the deck. Every redraw mints a new group of button codes
and drops the old one, so a press on an old keyboard is "no longer valid". A project whose details
stay off the phone (`telegram_detail: title`) shows title, project and urgency only.

**A task from a plain message.** Creating a task is a message to the Assistant, which guesses the
project and asks only when it is unclear. A task it created in a turn the user wrote from Telegram
comes back as a card of its own when the turn ends (`assistant-telegram-task-created.ts`): the task,
what came of the manager ("was told" once the manager's news moved past the creation, else "will see
it on its next turn" — the card never asks again), and buttons for urgency, importance, due date,
Undo and Open in PPM (`/project/<name>?openTask=<id>`). The buttons act as the user against the
revision the card last showed. `assistant-telegram-task-card-extras.ts` adds Open chat per task to
the handed-off work card and Open chat plus a real Undo per change to the "while you were away"
card, only for changes whose line the Telegram copy actually shows.

**Writing about a task.** A `/tasks` card and a created-task card carry "💬 Message about this task"
(`assistant-telegram-task-message.ts`). It arms the chat: the user's next message goes to the chat
working on that task — its handed-off chat, else the project's manager chat — instead of to the
Assistant. The bot names the task and the chat, offers Cancel, and stops waiting after ten minutes;
commands still go to the Assistant. "🤖 Ask manager" beside it arms the chat the same way for the
project's manager chat, whichever chat the task was handed to; a reply to its "next message goes
to…" line, or to the manager's answer, goes to the manager again. A task not handed off shows Ask
manager alone (both would reach the manager chat), and a project with no manager chat keeps Message
about this task alone (`taskWordsButtons`). A reply to a task card (or to that "next message goes to…" line)
does the same for one message with nothing to arm. Before this, a reply to a `/tasks` card reached
the Assistant as an ordinary message with the card quoted (`reply_to_message` → `quoteOf`), never
the task's chat. The words go through `forwardUserWordsAboutTask` (`forward-verbatim.ts`): word for
word, with a user-words block that names no card and — only when they go to the manager chat — the
task block the server renders from the store (a handed-off chat works on that one task, so its words
carry no task block; the bot's "✅ Sent to …" and the answer it brings back still name the task),
behind any request the chat has open rather than answering it, and with no chatting device
left behind. A forwarded message is refused (someone else's words), a photo is not sent, and a
title-only project shows the task's ref and title but never its chat's title.

**The chat's answer comes back.** The bot's "✅ Sent to …" is not the end: the turn that reads the
words is followed like a card reply's (`task-words-followup.ts`, a second instance of
`card-reply-followup-tracker.ts`, bound to the turn named by the words' `card-…` client id, never a
later one) and its final text goes back to Telegram **as a reply to the user's own message**
(`assistant-telegram-task-followups.ts`): which chat answered and which task, the answer redacted
and escaped and cut to one message with an Open link, or — on a title-only project — only that it
answered, with the link. A turn that stops on an approval, a question or a PPM-only card says so
once ("⏳ The alpha manager chat is waiting for your approval…"), so the phone never goes quiet; a
turn stopped or ended by an error says that (the error's first line, on a project that shows
details). Words queued behind a card that is already showing are told so at once. A turn that wrote
nothing, or one PPM cannot tell apart from another that ran first, points at the chat rather than
staying silent. A card the manager makes in that turn goes under the user's message like a card
reply's answer (`repliesBeingAnswered`), and is not named again. The detail level is read when the
message goes, so a project switched to titles only mid-turn shows no content. A reply to that answer
is about the same task. It rings within `CARD_FOLLOWUP_LOUD_MS` of the user's message.

"Open in PPM" links point to `/assistant?session=<provider>/<id>` (`notificationPath` in
`src/services/notification-format.ts`, parsed by `src/web/lib/assistant-deep-link.ts`), which
opens the Assistant on whatever project is on screen; the old `/project/__assistant__?openChat=…`
form opened the first project's chat instead and is redirected. A link is a button only when it is
public https — a tunnel or Tailscale Service address — because Telegram refuses a whole message
whose button points at localhost or a LAN address (`assistant-telegram-links.ts`); otherwise it
sits in the text.

**Settings → PPM Assistant → Sessions & Telegram** (the Telegram block is
`src/web/components/settings/assistant-telegram-settings.tsx`) holds the Assistant's own bot token
(the `ppmbot_telegram` row, separate from the Notifications bot, so a chat connected for alerts
cannot command the Assistant), the switch, the connected chats with the session each talks to,
the Connect link, "Quiet while I'm at PPM" and the two display settings. The old settings id `ppmbot` opens it
(`assistant-settings-tab-store.ts`). The REST surface stayed where PPMBot had
it, under `/api/settings/clawbot*` in `src/server/routes/settings.ts`, now taking only `enabled`,
`show_tool_calls`, `debounce_ms` and `quiet_while_in_ppm`; `/api/assistant/telegram` (`src/server/routes/assistant-telegram.ts`)
lists chats and their sessions with `quietWhileInPpm`, binds, and lists PPMBot's old memories. The Assistant's session
list marks the bound session and offers *Use on Telegram* (`settings/assistant/assistant-session-row.tsx`, `src/web/hooks/use-assistant-telegram-binding.ts`).

**From PPMBot** (`ppmbot-migration.ts`, once): only the user-written `system_prompt` is copied into
the Assistant's instructions. Memories PPMBot's AI wrote for itself (`clawbot_memories`) are not:
the instructions are the most trusted text a session gets, and an AI-written memory could have
been planted by what it read. Settings → PPM Assistant → General lists them for the user to copy by
hand. PPMBot's old tables are left in place, unused.

## Secret vault

Things the user wants an AI to be able to use without pasting them into every chat (an NI number,
an address, a passport number). Three tiers kept apart on purpose (`src/shared/vault.ts`,
`src/services/vault/`, migration 73):

| | Public | Secure | Sealed |
|---|---|---|---|
| Stored | plain text in `ppm.db` | ciphertext, its own data key | ciphertext, a second data key |
| Password | none | vault password (12+ chars) | its own (16+ chars), never the Secure one |
| AI reads | at once | card: tick items, once or a 5/10/15 min window for that chat only | card per item; shown to the user by default, given to the AI only when ticked |
| From a Telegram turn | yes | refused, no card | shown to the user in PPM only |
| Wrong passwords | — | 5 free, then 30 s doubling to 15 min | 3 free, then 60 s doubling to 1 h |

- **Keys.** Each locked tier's random data key is wrapped by scrypt(password, N=2^17, r=8, p=1) +
  AES-256-GCM; every item is AES-256-GCM under the data key, its additional data naming tier and
  item id, so swapping ciphertexts or editing the `tier` column fails to decrypt. No password hash
  is kept: the wrapped key's tag is the check. Keys live only in memory, in grants
  (`vault-grants.ts`); a restart locks both tiers. Forgetting a password loses that tier for good.
- **Cards** (`vault-unlock-broker.ts`, tool `ppm:vault`) sit in the chat's one approval slot and
  are answered only by `POST /api/vault/cards/:requestId` with the tier's password: never over the
  socket, from Telegram or by the Assistant (`answerApprovalCore` refuses them). One card per chat;
  10 secure and 3 sealed an hour.
- **Tools** `vault_list` / `vault_read` / `vault_propose` ride on the session server
  (`/api/sessions-mcp`): always for the Assistant, for an ordinary chat only once turned on in
  Settings → Tools (off by default), never for design or extension-bound chats.
- **Leaks blocked.** Values handed to an AI are held per chat for a day, or until the chat is
  deleted (`turn-secret-scrubber.ts`; values under 4 characters are not matched): the session trace stores a locked read as withheld item names and
  scrubs repeats (`vault-trace-filter.ts`); the notebook and every session-tool call refuse text
  holding one; Telegram text and every notification are scrubbed. Nothing in `/api/vault` logs a body.
- **Multi-line values** (an address, recovery codes, a key; still at most 8,000 characters, line
  endings stored as `\n`). The field is a textarea drawn as discs while hidden
  (`-webkit-text-security`, in Chromium, Safari and Firefox 150), else a block of dots that opens on
  Show. The scrubber and the history rewrite also hold each distinctive line of such a value (8+
  characters with a digit, or 12+, less a list marker), since an AI often repeats one line. The
  trace keeps a read's item names only when they are names of real items (a value line starting
  `- ` once read as one). Telegram text is scrubbed before Markdown is turned into HTML and before
  a long message is cut, so neither a bullet nor a cut can change a value's shape.
- **Files** (migration 78, `vault-attachments.service.ts`). A Secure or Sealed item may hold up to
  10 photos or PDFs (JPEG, PNG, WebP, PDF, told from the first bytes; 10 MB each, 200 MB in all).
  Each is AES-256-GCM under the tier's data key, additional data naming tier, item, file and part,
  written once to `<PPM dir>/vault-files/<random>.bin` (`vault-files.dev/` beside `ppm.dev.db`) and
  never changed. The original name and checksum are encrypted in `vault_attachments`; lists, Settings
  and `vault_list` show the user's label, the type and the size. No AI reads a file. The browser
  shrinks a photo to 2,000 px and redraws it, which drops its EXIF, unless "Keep the original" is
  ticked. `POST /api/vault/files/:id/content` answers the decrypted file to the page that unlocked it
  (`no-store`, `nosniff`, `sandbox`); the viewer revokes its object URL on close and after 60 s.
  Moving an item re-encrypts its files under the other tier's key; Public cannot hold files. A
  removed file is moved to `vault-files/retired/` and deleted after the next snapshot has kept what
  it needs (at the latest after 7 days); a start-up sweep retires files no row names. The folder is
  inside the PPM directory, so every filesystem door refuses it; an AI's own Read tool can open it
  but finds only ciphertext under random names.
- **Backups** (`db-backup-vault-files.ts`). After each snapshot the files it names are hard-linked
  (copied across drives) into `<backups>/vault-files/`, where one copy serves every snapshot;
  retention drops files no kept snapshot names, and `ppm restore` puts back the files the restored
  database names, reporting any it cannot find. Deleting a tier does not reach into backups: older
  snapshots keep its encrypted items and files until they age out (about four weeks), still opening
  only with that tier's password at the time of the snapshot (a password change re-wraps the key,
  not the files).
- **Telegram notice** (`assistant-telegram-db-notices.ts`). A card is announced with the item names,
  the tier and the ask ("asks to open the Sealed item Passport", "proposes saving …"), never a value,
  the AI's purpose or a file. Two link buttons: Open in PPM (the chat holding the card) and Open
  Vault (`/?openVault=<item id>`, Settings → Vault scrolled to the item). The links carry an id only
  and go through PPM's sign-in; the tier's password is asked for on the page. Push and ntfy still
  say only "Unlock needed in the PPM vault", since they can land on a lock screen.
- **Settings → Vault**: the Secure tier stays open five minutes (Lock now) for the one page that
  typed the password: the page sends a random handle kept in memory, so PPM's auth token alone never
  reaches an open tier, and moving an item out to Public always asks for the password. Every Sealed
  action asks for its password. Checking a new password against the other tier counts as a try on it.
- **Who started the turn.** An open window answers without a card only in a turn a person started in
  PPM; a turn another chat or the Assistant started gets a card; scripted, watch, schedule, extension
  and unknown turns get nothing from the locked tiers. Vault cards never reach Telegram `/status`,
  watches or `chats_attention`. The CLI has only `ppm vault status` and `ppm vault lock`.

- **History files.** After a turn that handed out a Secure or Sealed value, once the turn has ended
  and the file has stopped growing, `transcript-redactor.ts` rewrites the provider's history on
  this machine — Claude's session transcript and its subagents', Codex's rollout — replacing each
  value with `[vault:<name>]`. Only lines holding a value change; each stays one JSON record with
  its `uuid`/`parentUuid` links intact; the new file is written beside the old and renamed over it
  only if the old one did not move meanwhile, else it is tried again. The running CLI or app-server
  is not restarted, so its prompt cache stays.

**Limits.** A chat that is still open keeps a value it was given in the provider's memory until it
is reopened, and what was sent to Anthropic or OpenAI cannot be removed. The scrubber is a
fallback: a value spelled out differently gets past it. The Public tier is not protected at all.
While a Secure window is open, a process that can read PPM's memory can take that key (the Sealed
tier never stays open). JavaScript strings cannot be wiped. Deleted items and files stay in older
backups until they expire. Losing a tier's password loses its files too, backups included. Verify
with `tests/e2e/vault-canary-e2e.mjs` (Docker, capped), which checks every storage place for the
marker values, and `tests/e2e/vault-attachments-e2e.mjs` for multi-line values, files and the
Telegram notice.

## Startup

`startAssistantHub()` (`src/services/assistant-hub/assistant-hub-startup.ts`) starts the watch
service, the restart news (before the cards, so the wake queue's first tick finds it), and the cards
(signals, rules and budget cards, the wake queue's manager sources, the restart sweep), the morning digest (its timer, and whatever a restart left of a run), carries
PPMBot's settings over, then starts the Telegram bridge when it is switched on and
has a bot. `src/server/index.ts` and the e2e fixture call the same function, so a test exercises
the wiring the server runs. A Telegram failure (bad token, Telegram unreachable) is logged and shown
in Settings, never stops the server or the watches. Settings calls `syncAssistantTelegram` after a
change. Telegram allows one `getUpdates` reader per bot, so while the bridge reads a bot it tells
the connect-link poller to leave that bot alone (`assistantBridgeReading` in
`src/services/telegram-connect.service.ts`).

## Threat model

The guards here protect against model drift and injected text: words a model read in a chat, a
ticket, an email, a report or a Telegram forward. They do **not** protect against a process running
as the same OS user. Such a process — a bypass-mode chat included — already has the user's power: it
can read PPM's auth token from `ppm.db` ("PPM's password" in `CLAUDE.md`) and the MCP bearer tokens
on the CLI's command line, so it can call any route this page describes, write `.ppm/manager.md` and
the database directly. That risk is accepted, and nothing here claims more. The cheap speed bumps:
every rules write through a route posts a `rules_note` with its diff, and the reply, OK and rules
routes record the device and `Sec-Fetch-Site` in the session trace.

**Full mode trades the injected-text guard inside the user's own turns for fewer cards.** In Ask
mode a card is where the user can catch an action that text from a web page, a Slack message, a
file or another chat talked the Assistant into. In Full mode, inside a turn the user started, no
such card comes: a message the Assistant sends to a chat — and a chat running in bypass mode runs
whatever the message says — goes straight through, and so does a new chat with a task, a schedule
or a commit. The user chose this knowingly (ppm/42), and the confirm on switching says it. What is
left between injected text and harm:
- *Turns PPM started never act* (watch reports, the digest, restart news, wake-ups, schedules),
  in Full mode as in Ask; those are the turns that carry other chats' words with nobody watching.
- *Leaving the machine still needs the user*: a push, the public link, a public port forward, a
  post or upload or mail from a command or a user MCP tool. The command part is a denylist over
  text (`assistant-outbound-action.ts`) and a spelled-around command gets past it; PPM's own push
  and tunnel tools are hard limits.
- *Secrets*: the vault's locked tiers keep their password cards, private folders keep asking.
- *Volume*: 10 actions a turn, 30 an hour, then cards again — a runaway loop stalls on a card.
- *Afterwards*: every action Full mode let through is an `assistant_auto_approved` trace row, and
  the Assistant reports what it changed; most changes undo the usual way (session review, the
  discard journal, task undo).

**Commands that run without a card.** The classifier, not the model, decides; what it has to
withstand is a model talked into a command that looks like a read:
- *Parser differential* — PPM reading a command differently from the shell that runs it. PowerShell
  is judged on its own parser's tree, with the node count checked against the parser's and any
  value the helper could not serialise refused; bash goes through a lexer that refuses rather than
  guesses. Where Windows PowerShell 5.1 passes a native argument other than as written (empty,
  `"`, trailing `\`, leading `~`, `--`, `-x:v`), it asks.
- *Side doors in reading programs* — `find -exec/-fls/-follow`, `rg --pre/-f/--ignore-file`,
  `git -c/--output/--ext-diff/--textconv`, signature placeholders (`%G?`, `%(signature)`, which run
  `gpg.program`) and `--pretty=<name>` from config, `sort -o/-T`, `--files0-from`,
  `sqlite3` dot-commands, `-A`, `edit()`/`readfile()`/`load_extension()` and non-SELECT SQL,
  `ps` command-line and environment columns, docker's `-H/--context`, `Get-Content -Stream/-Wait`,
  provider drives (`Env:`, `HKCU:`, `Cert:`), methods that act (`Kill()`, `Delete()`, `MoveTo()`),
  and members that carry secrets (`CommandLine`, `StartInfo`, `BinaryPathName`, `MainWindowTitle`).
  Each is a flag or member not on an allowlist, so it asks; never widen an entry by its name alone.
- *Secrets outside the private roots* — a process's command line, a window title, the environment,
  `docker inspect`, `git remote -v` URLs, `ppm.db` itself (`sqlite3 -readonly ~/.ppm/ppm.db` asks:
  the PPM dir is private). What runs unasked can reach Telegram in the answer, so these ask.
- *Residuals, same exposure as any approved command:* configuration the repository or the user
  already has runs inside an allowed read — a repo's `core.fsmonitor`, a textconv or
  `diff.external` driver on plain `git diff`/`git status`, `~/.sqliterc` for every `sqlite3`, and
  an alias or function in the shell snapshot Claude's Bash or Codex's `bash -lc` loads, shadowing
  an allowed name (`-l` reads the login profile), and a function in a PowerShell profile, should
  the shell running the command load one (PPM's own parser helper starts with `-NoProfile`; what
  the provider's shell loads is not PPM's to set). Codex's own trusted read-only set (Known
  limitations) is unchanged: it runs those without asking PPM.

Two message blocks are written by the server only — `<ppm-assistant-provenance-v1>` (how the
Assistant's turn started) and `<ppm-user-words-v1>` (the user's own words, by card id). Every other
door breaks their markers: a `send_to_session` body, every `report_to_assistant` field, Telegram text
(the user's forwarded text included), notebook text and the rules file.

## Setting up a manager chat (worked example)

A project whose manager already works from a guide file of its own (a work board, a sessions guide)
and runs in bypass mode:

1. Settings → PPM Assistant → *Sessions & Telegram*: check the main session, and that Telegram is
   connected if the phone should get cards.
2. *Digest & quiet hours*: the digest time and quiet hours, saved from a browser in the user's zone.
3. In the project, right-click (long-press) the chat → *Set as manager chat*. Its mode stays what it
   was; in bypass mode the dialog says "This chat runs without approval prompts." Asking the
   Assistant ("make Quản lý the Nxsys manager") does the same through `manager_assign` and a card,
   and `ppm manager assign <session> -p <project>` from a terminal.
4. *Manager chats* → the project's row → *Edit* in its Rules column. Keep two things in `.ppm/manager.md`: a pointer
   ("read and follow `<path to the guide>`") and the safety rules **inline** — only what is inline is
   guarded; the guide stays the manager's own working file.
5. *Telegram detail*: *Title only* keeps client data off Telegram.
6. The manager tools (`report_to_assistant`) arrive at the chat's next stream start; then ask it once
   to report through `report_to_assistant` instead of answering in its own chat.
7. Watch a day: the counts on the rail and the dock, and the next morning's digest.

## Rules the hub keeps

- Telegram changes nothing about what asks: an Assistant session is still forced to ask, the cards
  are the same cards, and PPMBot's bypass path no longer exists anywhere.
- Every chat the Assistant opens and every message it sends into a chat is asked on a card first,
  answered once; it never reaches an Assistant or design chat. The one exception is a message to a
  project's current manager chat, which carries a provenance block instead and is held to the
  budgets, the pair limit and quiet hours when PPM started the turn.
- Manager rules reach the model through the shared-context block, never the system prompt: no
  stream is ever restarted for them. A change that removes, edits or could loosen a rule is held
  off disk until the user decides; a check that fails holds it too.
- Cards are built by PPM from records, never from a model turn; a report's text is data, shown as
  plain text with a server-written provenance line.
- An unattended turn (a watch or news turn) never asks and never acts: it creates and messages no
  chat, except a status question to a project's manager chat. Every such turn starts through the
  wake queue. A card that only waits for the user never starts a model turn.
- Allow appears only where the whole deciding input is visible; everything else is Deny or PPM.
- Private chat, still connected, the right person — checked on receipt and on every send.
- No tool input or output is sent to Telegram; text is redacted before it leaves.
- Every session key goes through `resolveMigratedSession`; cards wait until answered or until PPM
  restarts.

## Known limitations

- **A waiting tool call holds its connection with no idle limit.** That is what lets an approval
  wait for the user, but a provider that vanishes without closing its TCP connection leaves the
  request waiting until the turn ends or PPM restarts; the card goes when the turn does.
- **Codex runs commands it deems safe without asking.** Under `untrusted`, its trusted read-only
  commands (`cat`, `ls`, …) run unasked and can read outside the registered projects; there is no
  per-path rule to give it. With Codex, what keeps that content on the machine is that every way
  out (web, shell beyond that set, writes, messages, MCP) asks or is off, and the read-only
  sandbox has no network (not checked by hand on Windows).
- **Codex on the account's own home gets the user's `AGENTS.md` back.** That is the fallback
  when the Assistant's home cannot be set up (an account with no `auth.json`, such as a keyring
  login, or links the file system refuses): losing the login would be worse. On the Assistant's
  own home, anything only the user's `config.toml` provides (a custom model provider, proxy
  settings) does not apply to Assistant sessions.
- **Codex skills.** If the skill list cannot be read, the catalogue still stays out of the
  prompt, but a skill the user names with `$name` in a message loads.
- **SQLite reads cannot be stopped.** bun:sqlite runs a statement synchronously with no
  interrupt, so the 60 s limit and the abort apply only before a statement starts.
- **MySQL/MariaDB**: the reach check's catalog query has been verified only by unit tests over
  sample rows, not against a live server; the Postgres one has an integration test
  (`tests/integration/assistant-sql-reach-postgres.test.ts`). The MySQL check also does not see
  loadable functions, which only an administrator installs.
- **Telegram keeps what it is sent.** Bot chats are not end-to-end encrypted: every answer, card
  (with its full command, file content or diff) and report the Assistant sends is stored on
  Telegram's servers. Redaction hides only secret shapes it knows; a password written in prose,
  or a key in an unknown format, goes out as written.
- **Not tried against real Telegram before handoff.** No bot token was available, so the bridge is
  tested only against the fake Bot API. What only a phone shows is unchecked: that the final
  message of a long turn and a card make the phone notify, how Telegram renders the HTML, and that
  an Open in PPM button reaches PPM through the tunnel or Tailscale.
- **Long content can only be decided in PPM.** A write, edit or command whose deciding input does
  not fit on a card, and a Codex patch whose full diff PPM does not hold, get Deny and Open in PPM
  on Telegram, and `chat_answer_approval` refuses to Allow them.
- **A restart ends what was in flight.** Cards, button codes and turns live in memory: after a
  restart the phone's drafts say the answer was cut off, its cards lose their buttons, and messages
  sent meanwhile ask Run or Skip. Watches survive; the hourly wake count does not (it restarts at
  zero).
- **A refused call in a watch turn reaches the provider as a plain denial.** Claude and Codex are
  not told why; the model knows from its instructions and the turn's context. The endpoint's own
  tools do return the reason.
- **Codex and the `ppm` CLI.** A Codex Assistant runs in a read-only sandbox; an approved
  `ppm …` command that writes PPM's data asks to leave it, and after Allow it runs (verified with a
  real Codex: `ppm projects add` wrote the project, and the running server listed it without a
  restart and kept it through its next save — `config-projects-sync.ts`). Separately, on a server
  running a non-default database profile, CLI data commands would open another instance's
  `ppm.db`; `ppm_cli_reference` warns the agent not to run them.
- **Telegram is text, photos up, and buttons.** No files, no images sent down; a question that
  takes only typed text is answered in PPM. One program may read a bot at a time: a second reader
  of the same bot (another PPM, another tool) breaks one of them.
- **A Codex secret answer** is kept out of PPM's session trace but stays in Codex's own rollout.
- **Git, schedules and tunnels do less here than in PPM.** No rebase (other than a pull's),
  worktrees, block-level staging, pushing tags, picking or reverting a merge commit, or naming a
  commit older than the newest 1000, and never a force push; the Tailscale Service and the named
  tunnel are read only. Those stay in Source Control, the
  Git Graph and Settings → Remote Access, or `ppm …` in the shell behind a card. In a working tree
  too large for `/git/changes` to list whole, commit and stash save are refused.
- **`schedules:changed` misses CLI writes.** `ppm schedule …` writes the database directly, so
  an open Settings → Schedules shows those on its next read.
- **Manager chats run on Claude only.** A Codex chat cannot be assigned, and the main session must
  be a Claude session; Codex managers need the Codex side of the session tools' forced attachment.
- **A manager's tools arrive at its next stream start.** A chat made a manager while its stream is
  live gets `report_to_assistant` when that stream next starts (idle release, a restart); nothing
  restarts it. Rules, by contrast, apply from the next turn.
- **A restart drops what is held in memory.** Late-reply news, the quiet-hours hold of a watched
  chat's card and the hourly wake count live in memory; approval and question cards whose request
  no chat still shows are marked gone. Report cards, held outbound cards and the digest run are in
  the database and survive.
- **Only `.ppm/manager.md` is guarded.** A guide the rules point to is the manager's own file.
- **A subagent's report looks like its manager's.** An MCP call carries nothing that ties it to the
  CLI's tool call, so PPM cannot label it.
- **The read-only badge is live only.** A result's `autoApproved` reaches the browser as it streams
  and on a replay of the running turn; after a history reload — or on a device that opens the chat
  once the turn is over — the result comes from the provider's transcript, which does not carry it,
  so the badge is not shown (the trace row stays). Seen in the e2e: a phone opened mid-session
  showed turn 1's results without it.
- **Commands that act on the current folder ask.** No working directory is trusted, so `git
  status`, `ls`, `find`, `grep -r` with no path ask; with `git -C <project>` or a path they do not.
- **No Windows low-memory events.** `system_resources` and `ppm_memory_report` do not read the
  Windows event log; they say so instead.
- **A mode change restarts an open Assistant chat when it is idle.** Edit/Write and the mode's
  instructions section are fixed when the CLI starts, so a save that changes acting on its own or
  Full (`startupPermissionsChanged`) marks every open Assistant session for the same restart an
  extension binding change uses (`chat.ts`, reason `assistant_permissions`): at once when idle,
  otherwise at the end of the running turn, never across a card or background work. Until then a
  running turn keeps the tools it started with. The next message cold-reads the context once.
  Everything else about the mode — PPM's own cards, the provider-tool rules, the hard limits —
  is read on every call and changes at the next action.
- **Full mode's outbound list reads command text.** A push or upload spelled through a variable,
  an alias or a script file is not recognised (`assistant-outbound-action.ts`), and a user MCP
  tool is judged by its name's first word.
- **Codex follow-ups queued behind a turn do not act on their own.** The turn they start was not
  opened by a message the tracker saw, so it gets the read-only policy.
- **Recursive walkers and links were checked on one Windows host.** PowerShell 5.1 `-Recurse`,
  Git Bash's `grep -r`, `du`, `find` and `ls -R` did not walk into a junction to `~/.ssh` (phase-06
  probe); PowerShell 7 and other MSYS builds were not tried, and `-FollowSymlink`, `-L`, `-R`,
  `-follow` ask everywhere.

## Verify

`PPM_PLAYWRIGHT_MODULE=<playwright>/index.mjs node tests/e2e/assistant-e2e.mjs` runs the
Assistant on the production bundle, on a desktop and a phone viewport, against a scripted
provider (`tests/e2e/fixtures/assistant-server.ts`) that calls the real endpoint with each turn's
token and an isolated `PPM_HOME`. The header of the test file lists its scenarios and options.

`node tests/e2e/assistant-readonly-commands-e2e.mjs` runs the read-only-command policy through the
**real** Claude CLI and PPM's real hook (`fixtures/assistant-readonly-commands-server.ts`), the CLI
talking to `fixtures/bash-script-anthropic-api.ts`, which turns `RUN:` (Bash), `PS:` (PowerShell)
and `EDIT:` (Read then Edit) lines into tool calls and records the tools each request offered.
The bash leg (POSIX; run it in the capped `ppm-e2e-chromium` image, command in the file's header)
checks in a browser that `git -C`/`ls -la` run unasked, badged and traced, that `rm`, a private
key, `sqlite3` on `ppm.db`, `git -c`, `; touch` and `$(…)` each raise one card with nothing run
before the answer, that the switch off makes a read ask, and that Edit is not offered until *act on
its own* is on (then a new session edits with no card); it saves screenshots of the Permissions
block, its confirmation on a desktop and as a phone bottom sheet, and a badge beside a card. The
PowerShell leg (`PPM_RO_LEGS=powershell`, Windows only) drives a bare chat socket:
`Get-Process | Select-Object …` unasked, `… | Out-File` asks. The Codex half is
`tests/integration/codex-assistant-command-approval.test.ts` (recorded approval payloads, real
settings, classifiers and PowerShell parser); the classifiers' corpora are
`tests/unit/services/readonly-shell/adversarial-{bash,powershell}-corpus.ts`, PowerShell's trees
recorded by `bun scripts/record-powershell-ast-fixtures.ts` on Windows.

`PPM_ASSISTANT_WEB_DIR=<web build> node tests/e2e/assistant-manager-loop-e2e.mjs` runs the
manager-chat loop end to end in eleven steps on one desktop: a manager assigned from the chat menu
and one created by the Assistant behind a card, a card-free ask, a decision card on both surfaces
and its counts, a Telegram reply forwarded word for word, an approval allowed in PPM, wake turns
answered `[no reply]`, the rules guard (held removal, approval with no stream restart, a held
"Exception:", an accepted restriction), a forged user-words block and the send budget, quiet hours,
the digest with a busy manager, and the notebook. The fixture runs with
`PPM_ASSISTANT_MANAGER_LOOP=1` (`tests/e2e/fixtures/assistant-manager-fixture.ts`): a clock the
script moves forward, a scripted rules check, and a route that types into a project chat. It runs
on Node 20 in the `ppm-e2e-chromium` image.

`PPM_ASSISTANT_WEB_DIR=<web build with Monaco staged> node tests/e2e/ppm-tasks-e2e.mjs` runs PPM
Tasks end to end in the same image: desktop, handed-off work checks and phone plus Telegram steps
(`tests/e2e/ppm-tasks/steps-*.mjs`), each on the state the previous ones left. It starts the same
fixture with `PPM_ASSISTANT_MANAGER_LOOP=1 PPM_ASSISTANT_TASKS=1 PPM_ASSISTANT_FAKE_TELEGRAM=1` and a
fake Bot API; `tests/e2e/fixtures/ppm-tasks-fixture.ts` gives the checker a clock the script moves
and never starts the live checker or the link-state refresher, so no Jira or GitHub is asked.
Screenshots go to `PPM_TASKS_SHOTS`; with `PPM_TASKS_VIDEO=<dir>` the run is also recorded as the
walkthrough video, cut by `tests/e2e/ppm-tasks/video-cut.mjs`.

`PPM_PLAYWRIGHT_MODULE=<playwright>/index.mjs node tests/e2e/assistant-telegram-e2e.mjs` does the
same for Telegram, with a fake Bot API in place of the phone. It needs Node 22.5+, Bun and a web
build with Monaco staged (`dist/web`, or `PPM_ASSISTANT_WEB_DIR`); `PPM_ASSISTANT_TG_ONLY=s1,s5`
runs a subset, and its header lists the rest.

The hub is covered below the browser: `tests/integration/assistant-telegram-bridge.test.ts` and
`assistant-telegram-relay.test.ts` run the bridge against the fake Bot API
(`tests/helpers/fake-telegram-bot-api.ts`) and the real chat socket layer with a mock provider, and
`tests/integration/assistant-watch-flow.test.ts` runs watches end to end;
`assistant-cards.test.ts`, `assistant-telegram-manager-cards.test.ts`, `assistant-digest.test.ts`,
`manager-rules-routes.test.ts` and `session-collab-assistant.test.ts` cover the manager chats on a
fake clock; the unit tests are in
`tests/unit/services/assistant-telegram/`. The git, schedule and tunnel families run against their
real routes in `tests/integration/assistant-{git,schedule,tunnel}-tools.test.ts` (a scratch repo with
a bare `file://` remote, a scratch database, and `tests/fixtures/fake-cloudflared.ts` in place of
cloudflared); the allowlist itself is `tests/unit/services/assistant-mcp/assistant-route-call.test.ts`.
