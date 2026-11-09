=== Relaunch72 Publisher & SEO ===
Contributors: relaunch72
Tags: seo, meta, open graph, schema, sitemap, publishing, rest-api
Requires at least: 6.4
Tested up to: 7.1
Requires PHP: 7.4
Stable tag: 1.1.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Site-configurable SEO for any WordPress site, working alone or alongside Yoast SEO / Rank Math, plus a signed connection that publishes approved Relaunch72 articles as normal posts.

== Description ==

**SEO, configurable per site**

* **SEO box on every post and page** (and public custom post types): SEO title, meta description, canonical URL, index/noindex, follow/nofollow, social title, social description and social image. Values a person saves here always apply.
* **Site-wide settings** (Relaunch72 → SEO), behind an explicit switch: title separator and templates for the home page, posts, pages, archives, search and 404 (`%title%`, `%sitename%`, `%tagline%`, `%sep%`, `%term%`, `%term_description%`, `%excerpt%`, `%page%`, `%search%`); home and term-archive descriptions; noindex defaults for category, tag, author, date, search and paginated archives; default social image, Twitter/X card type and handle; Organisation or Person knowledge-graph schema with logo and profile links; factual Article schema on posts; WordPress core XML sitemap on/off.
* **Preview before apply.** Every change to site-wide output is previewed with current value, proposed value, effect and sample output. Only the rows you tick are applied.
* **One owner for every tag.** Exactly one canonical, one robots policy, one description. noindex posts are excluded from the core sitemap. Canonical overrides replace WordPress core's canonical instead of adding a second one.
* **Plays well with Yoast SEO and Rank Math.** If one of them is active, it owns all SEO output and this plugin only writes Relaunch72 article values into that plugin's own fields. Two SEO plugins at once, or another SEO plugin, is reported as a hold rather than emitting conflicting tags. This plugin never deactivates or reconfigures another plugin.
* **Diagnostics.** Fetches your home page, a post, a category archive and the sitemap as a visitor would and counts the tags actually served, with cache headers.

**Relaunch72 publishing**

* Articles approved in Relaunch72 arrive over a signed server-to-server connection and become ordinary WordPress posts: title, excerpt, body with citations, categories, featured image with alt text, slug, publication date. Only the exact approved version is published; the connection check publishes nothing.
* Retries, duplicate sends and lost responses never create a second post or image. An older version never replaces a newer one. Posts the plugin did not create are never adopted or overwritten.
* A managed post edited by a person is not overwritten until an administrator allows the next update or detaches it. SEO fields a person changed are preserved.
* Local stop switch for incoming writes; status and reconciliation keep working. Key rotation and disconnect keep all content.

= Developer hooks =

Filters: `r72pub_document_title`, `r72pub_meta_description`, `r72pub_canonical`, `r72pub_robots`, `r72pub_opengraph`, `r72pub_schema`, `r72pub_meta_box_post_types`.

= Supported configurations =

* Declared minimum WordPress 6.4 and PHP 7.4 (PHP 7.4 grammar checked). Runtime-tested on WordPress 7.1.4 with PHP 8.5 and SQLite, with Rank Math 1.0.281 and Yoast SEO 28.8.
* Relaunch72 publishing needs an https Site Address and "Post name" permalinks (`/%postname%/` or a fixed prefix such as `/blog/%postname%/`). Other structures are reported as unsupported; the plugin never changes permalinks. The SEO features work with any permalink structure.

== Installation ==

1. Plugins → Add New → Upload Plugin → activate. Activation changes no posts or settings.
2. **SEO only:** Relaunch72 → SEO. Propose your settings, review the preview, tick and apply. Edit per-post values in the SEO box on each post or page.
3. **Relaunch72 publishing:** Relaunch72 → Connection → choose the "Publish as" user → Create connection key → paste it into Relaunch72's secure WordPress connection form → Check connection → review Relaunch72 → Diagnostics.

== Frequently Asked Questions ==

= Does it change anything on activation? =

No. Nothing is output until you set a per-post value or switch site-wide output on, and no Relaunch72 article arrives until a connection is paired and an approved version is sent.

= What happens if I deactivate or delete the plugin? =

Deactivation stops incoming writes and this plugin's tags; every post, image, category and value stays. Deleting the plugin removes only its own settings, key, pairing and activity log. Per-post SEO values and Yoast SEO / Rank Math fields are kept.

= How are Relaunch72 requests protected? =

HMAC-SHA256 over timestamp, method, path, query and body with the site's connection key, within five minutes. The site binds to one Relaunch72 brand and connection on the first verified check. Images are fetched only from approved https prefixes without redirects and must match the digest in their address. The key is stored encrypted with the site's salts and is never returned or logged.

== Changelog ==

= 1.1.0 =
* Per-post SEO box on every post, page and public post type.
* Site-wide SEO settings: templates, descriptions, robots defaults, social defaults, knowledge graph, Article schema, sitemap control, with preview-then-apply.
* Top-level Relaunch72 menu; translation-ready strings; developer filters.
* noindex posts excluded from the core sitemap; canonical override replaces core's canonical.

= 1.0.0 =
* First release: signed connection check, exact-version delivery, reconciliation, manual-edit protection, Yoast SEO / Rank Math / standalone SEO, diagnostics, stop switch, key rotation.
