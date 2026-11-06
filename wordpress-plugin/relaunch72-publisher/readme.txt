=== Relaunch72 Publisher & SEO ===
Contributors: relaunch72
Tags: publishing, seo, rest-api, yoast, rank-math
Requires at least: 6.4
Tested up to: 7.1
Requires PHP: 7.4
Stable tag: 1.0.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Receives owner-approved, exact-version articles from Relaunch72 over a signed connection and publishes them as normal WordPress posts with managed SEO.

== Description ==

Relaunch72 Publisher & SEO connects one WordPress site to one Relaunch72 brand. It is independent of any theme or brand.

* Articles become ordinary WordPress posts (title, excerpt, body, categories, featured image with alt text, slug, publication date). Citations and source links in the article body are preserved.
* Only the exact article version approved in Relaunch72 is published. Checking the connection publishes nothing.
* Retries, duplicate sends and lost responses never create a second post or image. An older version never replaces a newer one. Posts the plugin did not create are never adopted or overwritten.
* A managed post edited by a person in WordPress is not overwritten until an administrator explicitly allows the next update (Settings → Relaunch72 Publisher → Managed posts), or detaches it.
* SEO: with Yoast SEO or Rank Math active (alone), per-article values are written to that plugin's own fields and it renders the output. With no SEO plugin active, this plugin renders meta description, robots, Open Graph/Twitter previews and factual Article structured data; WordPress core renders the canonical and sitemap. Any other or conflicting SEO setup is held with an explanation; nothing is half-applied. The plugin never deactivates or reconfigures another plugin.
* Local stop switch: pause all incoming writes; status/reconciliation keeps working.

= Supported configurations =

* Declared minimum: WordPress 6.4 and PHP 7.4 (from the WordPress APIs used; PHP 7.4 grammar checked). Runtime-tested on WordPress 7.1.4 with PHP 8.5.12 and SQLite (WordPress Playground), with Rank Math 1.0.281 and Yoast SEO 28.8. The minimums have not yet been runtime-tested.
* Site Address must be https:// on a standard port.
* Permalinks: "Post name" (/%postname%/) or a fixed prefix plus post name (for example /blog/%postname%/ or /insights/%postname%), with or without the trailing slash. Date, ID, category or author based structures, and Plain permalinks, are reported as unsupported; the plugin never changes permalinks.
* Posts index: the assigned "Posts page" or the home page. Categories: top-level categories under the site's category base.
* Sitemap: Yoast SEO's or Rank Math's sitemap when that plugin owns SEO, otherwise WordPress core sitemaps. A site serving no sitemap is held.

== Installation ==

1. Upload the ZIP in Plugins → Add New → Upload Plugin, then activate. Activation changes no posts or settings.
2. Settings → Relaunch72 Publisher → choose the "Publish as" user (needs publish_posts and upload_files) and save.
3. Create a connection key and copy it. It is shown once.
4. In Relaunch72, open the brand's Website publishing connection, choose WordPress, enter the site address and paste the key into the secure key field. Check connection.
5. Review Capabilities & diagnostics and resolve any hold shown.

== Frequently Asked Questions ==

= What happens if I deactivate or delete the plugin? =

Deactivation stops incoming writes; every post, image, category and SEO value stays. Deleting the plugin removes only its own settings, key, pairing and activity log. Posts, attachments, categories, Yoast SEO / Rank Math values and provenance metadata are kept. The site identity is kept so a reinstall keeps existing Relaunch72 targets valid.

= How are requests protected? =

Every request carries an HMAC-SHA256 signature over the timestamp, method, path, query and body with the site's connection key, and must be within five minutes. The site binds to one Relaunch72 brand and connection on the first verified check and refuses others. Images are fetched only from approved https prefixes, without redirects, and Relaunch72 release images must match the SHA-256 in their address. The key is stored encrypted with the site's salts and is never returned or logged.

== Changelog ==

= 1.0.0 =
* First release: signed connection check, exact-version delivery, reconciliation, manual-edit protection, Yoast SEO / Rank Math / standalone SEO, site SEO preview-and-apply controls, diagnostics, stop switch, key rotation.
