# Security Policy

## Reporting a vulnerability

Report privately through GitHub's
[private vulnerability reporting](https://github.com/schubydoo/claustodian/security/advisories/new)
(the "Report a vulnerability" button on the repository's **Security** tab), or by
email to <schuuby@proton.me>. Do **not** open a public issue for a security report.

Expect an initial response within a few days. Once a fix is ready we will coordinate
disclosure and credit you, if you would like.

## Supported versions

Only `main` is supported. The published dataset is regenerated from `main`, so a fix
reaches consumers on the next deploy; there are no maintained release branches to
backport to.

## Scope & threat model

Claustodian is **static data**. It publishes JSON, YAML and TOML to GitHub Pages —
there is no server, no database, no authentication, and no user input at runtime. The
site is a single hand-written HTML page that fetches those files. That rules out most
of what a security policy usually covers.

What is actually in scope:

- **Dataset integrity.** The realistic harm is a record that asserts something false
  in a way that misleads a tool or an agent consuming it — for example a symbol marked
  available in a version where it does not exist. If you find one, that is an ordinary
  [issue](https://github.com/schubydoo/claustodian/issues), not a security report, and
  the dataset-correction template asks for the evidence needed to fix it.
- **Provenance violations.** Data derived from anything other than Anthropic's
  publicly published artifacts — a leak, a source-map mirror, an unofficial API —
  would compromise the whole dataset's trustworthiness. Report that privately.
- **Supply chain.** The pipeline downloads official release binaries over HTTPS and
  verifies checksums. Weaknesses in that verification, in the GitHub Actions workflows
  (which use pinned SHAs and OIDC rather than stored credentials), or in a dependency
  are in scope.
- **The published site.** XSS in `site/index.html` via rendered dataset content is
  plausible in principle, since descriptions come from upstream text.

Out of scope: findings that require write access to this repository, and reports that
the data is incomplete — incompleteness is expected and documented, and
`first_seen` is explicitly a lower bound rather than a claim of origin.

## What this project deliberately does not do

It uses only material Anthropic has publicly published and distributed. It does not
use leaked or otherwise non-public material, and it does not redistribute Claude Code
binaries — only facts extracted from them. See
[CONTRIBUTING](CONTRIBUTING.md#provenance-policy-the-important-part).
