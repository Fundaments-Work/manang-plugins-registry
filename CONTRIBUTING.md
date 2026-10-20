# Contributing a plugin

To list a plugin, open a pull request that adds one file, `plugins/<id>.toml`.
Everything about the submission process is in [docs/publishing.md](docs/publishing.md):
preparing the manifest, building the `.manangplugin`, creating the GitHub release,
the entry format, what reviewers check, and how updates and removals work.

Before you open the pull request:

* run `pnpm install --frozen-lockfile` and `pnpm run validate` and fix what it reports;
* make sure your release has exactly one matching `.manangplugin` asset and that the
  manifest's name equals `<id>`;
* ask only for the permissions you need and say why in your plugin's README.

Changes to the tooling (`schema/`, `scripts/`, `worker/`) also need `pnpm test`
to pass. Use Conventional Commits. There are no listed plugins yet, so expect the
first submissions to shape these guidelines.
