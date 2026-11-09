# WordPress publishing: Relaunch72 Publisher & SEO

This package adds a third website destination type, `wordpress`, beside `github_static` and `content_api`. It ships a reusable, site-configurable WordPress SEO plugin, **Relaunch72 Publisher & SEO** (`wordpress-plugin/relaunch72-publisher/`, installable ZIP in `wordpress-plugin/dist/`).

It reuses the signed content-API v2 model (009B), exact-version approval, pause controls, the immutable publication snapshot, reconciliation and the independent public evidence system. It adds no SQL migration, job kind, payload stage or state enum. Existing `content_api` and `github_static` destinations keep their exact v2 rules.

## Protocol (explicitly versioned)

| Item | Existing content API v2 | WordPress (`r72-wordpress-1`) |
|---|---|---|
| Capability object | `contractVersion: 2`, strict roots: `{origin}/{root}`, `/{root}/{slug}`, `/{root}/category/{slug}` | Same object, plus `urlContract: "wordpress-permalinks-1"` with declared same-origin patterns |
| Who may use the URL extension | Refused: an unknown `urlContract` fails the check | Only `parseWebsiteCapabilities(…, {urlContract})`, which only `WordPressPublisher` passes |
| Signature | HMAC over `ts.METHOD.path.sha256(body)` | Same HMAC, signing scheme `path-query-1` (header `X-R72-Signing`); the string covers **path and query** |
| Connection check | `GET {endpoint}/status?check=1` | `GET …/status?check=1&brand=<uuid>&destination=<uuid>`. The plugin binds to that brand and destination on first success and refuses any other brand afterwards |
| Publish payload | v2 payload | v2 payload plus a `wordpress` block: protocol, brandId, destinationId, robots, social preview, public citations |
| Reconciliation | `GET …/status?article&version` → `present` / `absent` / `other_version` | Same, plus `wordpress.{postId, postStatus, manualEdit, detached}`. Returns 503 while a write for that article is in progress |
| Sitemap repair | Adapter-specific | `repair.sitemap: false`; the sitemap belongs to the active SEO plugin or WordPress core |

### Declared URL rules (`wordpress-permalinks-1`)

- **One root.** Its `path` is a single segment: the Posts page slug (for example `investor-insights`), otherwise a one-segment permalink prefix, otherwise `posts`.
- **`indexUrl`** is a same-origin URL with no query or fragment: the assigned Posts page, or the home page.
- **`articleUrlPattern`** is `{origin}{prefix}/{slug}[/]`. It has exactly one `{slug}`, as the final segment.
- **`categoryUrlPattern`** is `{origin}{categoryBase}/{slug}[/]`, with at least one prefix segment. Its trailing slash must match the article pattern's.
- **Eligibility.** `targetEligibility` checks that the canonical URL matches the article pattern exactly, and that the slug is a valid segment. Without the extension, the existing prefix rule is unchanged.
- **Archive pagination.** `observeMembership(…, 'wordpress')` may follow `rel=next` to `{archive}/page/N/` of the *same* archive only.
- **SEO head counts.** WordPress publications also record `seoHead` counts (canonical, robots, description, og:url, JSON-LD). These are observations only.

## Supported WordPress configurations

| Setting | Supported | Held (useful message; nothing is changed) |
|---|---|---|
| Permalinks | `/%postname%/`, `/%postname%`, `/prefix/%postname%/`, `/prefix/%postname%` | Plain, date, `%post_id%`, `%category%` or `%author%` structures |
| Site Address | https on a standard port; a subdirectory home is allowed | http, or a non-standard port |
| Posts index | Assigned Posts page or the home page | — |
| Categories | Top-level categories under the category base. Missing categories are created only if the site allows it | Child categories (their URL does not match the reviewed address) |
| SEO owner | Yoast SEO alone; Rank Math alone; no SEO plugin (standalone); explicit Content-only mode | Two or more SEO plugins, or AIOSEO, SEOPress, The SEO Framework, Squirrly or Slim SEO, unless Content-only is chosen |
| Sitemap | Yoast or Rank Math sitemap index, otherwise WordPress core `wp-sitemap.xml` | No sitemap served |
| Versions | Declared WordPress 6.4+, PHP 7.4+ (PHP 7.4 grammar checked). Runtime-tested only on WordPress 7.1.4 / PHP 8.5.12 / SQLite, with Rank Math 1.0.281 and Yoast SEO 28.8 | Below the minimum is reported in the check |

**SEO ownership.** Exactly one component renders each output.

- **Yoast SEO / Rank Math mode.** Relaunch72 writes only to that plugin's own per-post fields: title, description, social title, description and image, and robots *only* when an article asks for noindex or nofollow. That plugin renders canonical, robots, Open Graph, schema and the sitemap. The plugin's own SEO box shows provenance only.
- **Standalone mode (no other SEO plugin).** The plugin is the site's SEO plugin, configured per site like Yoast or Rank Math:
  - *SEO box on every post, page and public post type:* SEO title, meta description, canonical URL, noindex, nofollow, social title/description/image. Explicit per-post values always apply. Relaunch72 writes a managed article's values into these same fields (`_r72_seo_*`), so a person's later change is preserved by the same rule as for Yoast/Rank Math fields.
  - *Site-wide settings* (Relaunch72 → SEO), behind an explicit **site-wide output** switch: separator and title templates (home, posts, pages, archives, search, 404), home/term descriptions, noindex defaults (category, tag, author, date, search, paginated), default social image, Twitter card and handle, Organisation/Person knowledge graph with logo and `sameAs`, Article schema on posts, core sitemap on/off. Until the switch is on, only managed posts and posts with explicit per-post values carry this plugin's tags.
  - *One owner per tag:* core `rel_canonical` is kept for singular pages; a per-post canonical override removes it and emits one tag; archives and the home page get one canonical from this plugin; robots go through `wp_robots`; noindex posts are excluded from the core sitemap (`wp_sitemaps_posts_query_args`).
  - *Preview then apply:* every site-wide change is shown with current value, proposed value, effect and sample output; only ticked rows are applied.
  - *Hooks:* `r72pub_document_title`, `r72pub_meta_description`, `r72pub_canonical`, `r72pub_robots`, `r72pub_opengraph`, `r72pub_schema`, `r72pub_meta_box_post_types`.
- **Content-only mode.** Opt-in: nothing written, nothing rendered.
- **Never.** The plugin never deactivates or reconfigures another plugin. Site title/tagline changes go through the same preview-and-apply step.

## Managed posts and manual WordPress edits

- **One post per article.** Each Relaunch72 article maps to exactly one post (`_r72_article_id`). A durable per-article lock row in the options table makes concurrent deliveries serial on MySQL, MariaDB and SQLite.
- **New posts.** The plugin writes a draft with every value and its marker, then publishes. If WordPress changes the address, for example by adding a unique-slug suffix, the new post is removed and the delivery refused.
- **Version order.** An equal version is `already_present`. A lower number gets `409 superseded`. The same number with a different version ID gets `409`.
- **Manual edits.** A post edited by a person after Relaunch72's last write (title, body, excerpt, slug, status, featured image or categories) is not overwritten. The administrator chooses one of two actions on the Managed posts screen:
  - **Allow next update** applies to one update only.
  - **Detach** stops all future updates.
- **Unpublished posts.** A post a person unpublished, scheduled or trashed is never republished.
- **SEO fields.** A field a person changed in Yoast or Rank Math is preserved and listed as preserved.
- **Unrelated posts.** A post or page Relaunch72 did not create, with the same slug, is never adopted (`409`).
- **Fixed URLs.** Published URLs are fixed: slug and permalink must still equal the reviewed canonical before any update.

## Security

- **Signed requests.** Every request is signed (HMAC-SHA256, ±5 minutes, constant-time compare). A byte-identical repeated POST signature gets a 429, so the sender reconciles; delivery is idempotent anyway.
- **Cross-brand writes.** The plugin binds to one brand and destination. Payload brand, destination, site ID and capability digest must all match.
- **Connection key.** The key is created in WordPress and shown once. It is stored sealed with libsodium using the site's salts. It is never returned, logged or committed. In RL72 it goes only into the existing password-type credential field, sealed by `SeoBlogCredentialVault`.
- **Images.**
  - Fetched only from approved https prefixes. The default is `https://app.relaunch72.com/api/public/seo-blog/media/`.
  - Fetched with `wp_safe_remote_get`, with no redirects, a 10 MB limit, and JPEG, PNG or WebP only.
  - The SHA-256 in a release filename must match the downloaded bytes.
  - One attachment per article and source.
- **Admin screens.** They require `manage_options` and nonces on every action. Input is sanitised and output escaped. Writes run as the configured "Publish as" user and check `publish_posts` and `upload_files`.
- **Site-wide SEO changes.** Proposals are previewed with current versus proposed values and their effect. Only the rows the administrator ticks are applied.

## Installation (per site)

1. **Install.** WordPress → Plugins → Add New → Upload → `relaunch72-publisher-1.1.0.zip` → Activate. Check the ZIP against its `.sha256` file first. Activation changes nothing.
2. **Choose the author.** Settings → Relaunch72 Publisher → choose **Publish as** (a dedicated Author or Editor) → Save.
3. **Create the key.** Click **Create connection key** and copy it. It is shown once.
4. **Connect in RL72.** Brand → Setup → Website publishing connection → **Connect: WordPress**. Enter the site address, leave the endpoint blank unless the plugin shows a different one, paste the key into the key field, then Connect. The check publishes nothing.
5. **Approve the root and categories.** Approve the editorial root shown by the check (for example `/investor-insights`) and the categories.
6. **Publish.** Publishing then follows the existing exact-version approval, schedule and pause controls.

## Rollback

| Goal | How |
|---|---|
| Stop RL72 writes immediately | WordPress: **Pause incoming writes**. RL72: brand Pause all. Reconciliation still works |
| Revoke access | WordPress: **Rotate key** or **Disconnect**. Posts are kept |
| Remove the plugin | Deactivate, then delete. Posts, images, categories and SEO values are kept; only plugin settings, key, pairing and log are removed |
| RL72 code rollback | No migration exists. Before rollback, pause the WordPress brands. A worker without the `wordpress` publisher fails WordPress publications closed ("not supported") and writes nothing |

**Release order.** Deploy the SEO worker and HQ together, or the worker first. An HQ build that offers the WordPress form, paired with an older worker, holds WordPress publications as unsupported. That is safe, but noisy. No live install, live migration or demonstration content belongs to this package.

## Evidence

- **Offline:** `test/seo-blog-wordpress.test.ts` (in `npm test`). It covers the extension, configuration, pagination, the full engine journey with automatic target, approval, schedule, publication and evidence, two-brand pairing, holds and pause, content-API strictness, and the portal form.
- **Disposable WordPress:** `test/manual-wordpress-plugin.e2e.ts`. It runs the real plugin with the real `WordPressPublisher` and evidence code on WordPress Playground, in standalone, Rank Math, Yoast SEO, conflicting-plugin hold and lifecycle scenarios. See `wordpress-plugin/README.md` for the harness commands.
  The standalone scenario also covers the SEO box (title, description, canonical override, noindex/nofollow, social fields, sitemap exclusion), the site-wide switch (off by default), templates, home/archive descriptions, archive canonicals, robots defaults, knowledge-graph schema and the core-sitemap control.
