# HTMi privacy policy

Effective 11 November 2026. This covers the HTMi Chrome extension, the HTMi plugin for
Hermes Agent, the command line and the VS Code extension.

## What HTMi collects

Nothing. HTMi has no server, no account, no analytics and no telemetry. It does not
collect, sell or share personal data, and it sends nothing to its authors.

## What the Chrome extension does on your computer

- It runs only on `github.com`. There it reads the HTML file or the issue or pull request
  description you are viewing, with your own signed-in GitHub session, the same way
  GitHub's own pages read them.
- It shows that HTML as a page inside a sandboxed extension frame that makes no network
  requests and runs none of the page's own scripts.
- When you write a comment, it puts the text into GitHub's own comment box. Nothing is
  posted until you press GitHub's Comment button yourself.
- It uses Chrome's `storage` permission only to keep comments you prepared on a file page
  until the issue or pull request page they go to has opened; then it removes them. This
  stays in your browser.
- It stores no GitHub token or password.

## The plugin, the command line and VS Code

They run on your computer. Comments you write are saved in `.htmi/annotations.jsonl` in
your own repository. When you ask them to work with GitHub, they use your GitHub CLI
login (`gh`) to read and write the issues and pull requests you name. The Hermes plugin
does this only in your repository's origin and repositories you list, and asks you before
it creates an issue or changes a description. `git` and `gh` are started with a minimal
environment, so API keys you keep in your environment are not passed to them.

## Contact

Open an issue at https://github.com/Thamirawaran/htmi/issues.
