<p align="center"><img src="assets/logo.png" alt="HTMi" width="300"></p>

# HTMi for Hermes Agent

Review rich documents with Hermes the way you review code: on the page itself.

Agents write more and more of their work as documents: plans, designs, comparisons,
reports as HTML pages, Markdown with Mermaid diagrams, long issue and pull request
descriptions. Reviewing them in chat is clumsy. You describe where something is ("the
second table, the risk about failover"), the agent guesses, and after an edit nobody
knows which comments still apply.

With HTMi you read the document as authored and comment on the exact element, passage,
diagram part or image region. Each comment is pinned to its target and to the version
you saw. Hermes is told about new comments at the start of its next turn, reads one with
exactly the context it needs, changes the source through checked edits, and replies. A
comment survives the edit, or says plainly that its target changed or is gone.

## What it adds to Hermes

|           |                                                                                                                                                                                                                                                                      |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tools     | `htmi_list_documents`, `htmi_read_document`, `htmi_list_targets`, `htmi_list_comments`, `htmi_comment_context`, `htmi_apply_edit`, `htmi_reply`, `htmi_validate`, `htmi_pull_comments`, `htmi_publish_description`, `htmi_open_review`                               |
| Hook      | `pre_llm_call`: when people left new review comments since the last turn, Hermes gets a short notice naming them (id, document, target, author). The comment text is not put into the prompt; Hermes reads a comment with `htmi_comment_context` when it acts on it. |
| Command   | `/htmi open [document]`, `/htmi comments`, `/htmi stop`, `/htmi init`, `/htmi status`                                                                                                                                                                                |
| Skill     | `htmi:document-review`: how to write a document for review and act on comments                                                                                                                                                                                       |
| Dashboard | a **Review** tab in `hermes dashboard` that shows the running review pages in place                                                                                                                                                                                  |

## Use

1. Install and enable the plugin, then start Hermes in a git repository:

   ```sh
   hermes plugins install Thamirawaran/htmi/hermes --enable
   hermes gateway restart   # only if a gateway is already running, so it loads the plugin
   ```

2. Ask for a document, for example "write the cache plan as an HTML page I can review".
   Hermes writes it, checks it with `htmi_validate` and opens the review page.
3. Open the address it gives you (or run `/htmi open docs/plan.html`). Click an element,
   select a passage or draw a region on an image, and write your comment.
4. Back in Hermes, say "go through my comments". Hermes reads each one with its context,
   answers questions, edits what you asked for, and replies on the comment. You resolve
   comments; Hermes cannot.

Comments live in `.htmi/annotations.jsonl` in your repository, next to the documents,
so they travel with the repository through git.

## Requirements

- Hermes Agent 0.23.0 or newer.
- Node.js 20.11 or newer. Hermes installs one; HTMi uses it, or else the `node` on your PATH.
- git. GitHub descriptions (`github:owner/repo#7`) also need the GitHub CLI `gh`, signed in.

## What it does on your computer

Hermes asks plugins to say this plainly.

- **Shell commands.** Every tool runs `node bundle/htmi.mjs <command>` in the session's
  repository. The engine runs `git` to read revisions, and `gh` only for GitHub issue or
  pull request descriptions. The plugin also runs `git rev-parse` to find the repository.
- **Files outside the plugin.** HTMi reads documents in the session's repository and the
  files they use (stylesheets, images). It writes `.htmi/annotations.jsonl` when comments
  or replies are added, `.htmi/config.json` and `.gitattributes` on `/htmi init`, and a
  document when `htmi_apply_edit` changes it (only the named part; the edit is refused if
  anything else would change).
- **A background process.** `htmi_open_review` and `/htmi open` start `htmi serve` for the
  repository: a web server on `127.0.0.1` only, on a port the system picks. It keeps running
  so you can keep commenting while Hermes works, until `/htmi stop` or a restart. Its
  address and process id are kept in the plugin's data folder. Only local pages (the
  dashboard's Review tab) may show it in a frame.
- **Network.** HTMi reaches GitHub only for GitHub descriptions, always through your own
  `gh` login: `htmi_publish_description` creates an issue or sets a description,
  `htmi_pull_comments` reads its comments, `htmi_reply` posts a reply to a comment that came
  from there, and reading or editing a description reads and writes that description. Nothing else leaves your computer.
- **Credentials and telemetry.** None stored, none sent. The review page uses a random
  token held in memory to accept comments from its own page only.

## Inside

The engine is HTMi itself, bundled into `bundle/htmi.mjs`: one unminified ES module built
from `src/` of [the HTMi repository](https://github.com/Thamirawaran/htmi) by
`npm run bundle:engine`. A test in that repository fails if the bundle differs from what
the source builds. The Python files only translate between Hermes and the engine.

Tests: `uv run --no-project --with pytest pytest hermes/tests` from the repository root.
They run the real engine in a temporary git repository.

## License

MIT, see [LICENSE](LICENSE).
