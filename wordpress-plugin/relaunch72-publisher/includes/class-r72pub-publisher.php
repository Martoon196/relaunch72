<?php
/**
 * Exact-version delivery into ordinary WordPress posts.
 *
 * Guarantees:
 * - One managed post per Relaunch72 article (durable per-article lock + article-ID meta).
 * - Retries, duplicate deliveries and lost responses never create a second post or attachment.
 * - A lower version number never replaces a higher one; the same number with a different
 *   version is refused.
 * - Never adopts or overwrites a post Relaunch72 did not create (slug collisions are refused).
 * - A managed post edited by a person in WordPress after Relaunch72's last write is not
 *   overwritten until an administrator explicitly releases it ("Allow next update").
 * - The published URL (slug + permalink) is fixed once published.
 * - New posts are written as drafts with all metadata, then published in one step.
 *
 * @package Relaunch72Publisher
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class R72Pub_Publisher {
	const META_ARTICLE   = '_r72_article_id';
	const META_VERSION   = '_r72_version_id';
	const META_NUMBER    = '_r72_version_number';
	const META_CONTENT   = '_r72_content_sha';
	const META_MARKER    = '_r72_marker';
	const META_CANONICAL = '_r72_canonical';
	const META_TARGET    = '_r72_target';
	const META_PAYLOAD   = '_r72_payload_sha';
	const META_OPERATION = '_r72_operation_id';
	const META_HASH      = '_r72_written_hash';
	const META_STATE     = '_r72_state';
	const META_ALLOW     = '_r72_allow_overwrite';
	const META_DETACHED  = '_r72_detached';
	const META_BRAND     = '_r72_brand_id';
	const META_WRITTEN_AT = '_r72_written_at';

	const UUID = '/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i';
	const SLUG = '/^[a-z0-9]+(?:-[a-z0-9]+)*$/';

	public static function find_managed( $article_id ) {
		$ids = get_posts(
			array(
				'post_type'        => 'post',
				'post_status'      => array( 'publish', 'draft', 'pending', 'private', 'future', 'trash' ),
				'posts_per_page'   => 2,
				'fields'           => 'ids',
				'orderby'          => 'ID',
				'order'            => 'ASC',
				'suppress_filters' => true,
				'meta_query'       => array( array( 'key' => self::META_ARTICLE, 'value' => $article_id ) ),
			)
		);
		return $ids ? (int) $ids[0] : 0;
	}

	/** Hash of the human-editable surface of a managed post, read fresh from the database. */
	public static function surface_hash( $post_id ) {
		clean_post_cache( $post_id );
		$post = get_post( $post_id, OBJECT, 'raw' );
		if ( ! $post ) {
			return '';
		}
		$cats = wp_get_post_categories( $post_id );
		sort( $cats );
		return hash( 'sha256', wp_json_encode( array( $post->post_title, $post->post_content, $post->post_excerpt, $post->post_name, $post->post_status, (int) get_post_thumbnail_id( $post_id ), $cats ) ) );
	}

	public static function manually_edited( $post_id ) {
		$stored = (string) get_post_meta( $post_id, self::META_HASH, true );
		return '' !== $stored && ! hash_equals( $stored, self::surface_hash( $post_id ) );
	}

	/** @return array|WP_Error validated payload */
	public static function validate( $raw ) {
		if ( strlen( $raw ) > 1600000 ) {
			return self::refuse( 'r72_too_large', 'The article is too large. Nothing was changed.', 413 );
		}
		$p = json_decode( $raw, true );
		if ( ! is_array( $p ) ) {
			return self::refuse( 'r72_bad_json', 'The request body is not valid JSON. Nothing was changed.', 400 );
		}
		foreach ( array( 'operationId', 'articleId', 'versionId' ) as $k ) {
			if ( ! isset( $p[ $k ] ) || ! is_string( $p[ $k ] ) || ! preg_match( self::UUID, $p[ $k ] ) ) {
				return self::refuse( 'r72_bad_payload', 'Missing or invalid ' . $k . '. Nothing was changed.', 400 );
			}
		}
		if ( ! isset( $p['versionNumber'] ) || ! is_int( $p['versionNumber'] ) || $p['versionNumber'] < 1 ) {
			return self::refuse( 'r72_bad_payload', 'Missing or invalid versionNumber. Nothing was changed.', 400 );
		}
		if ( ! isset( $p['contentSha'] ) || ! is_string( $p['contentSha'] ) || ! preg_match( '/^[a-f0-9]{64}$/', $p['contentSha'] ) ) {
			return self::refuse( 'r72_bad_payload', 'Missing or invalid contentSha. Nothing was changed.', 400 );
		}
		$expected_marker = 'r72-blog:' . $p['articleId'] . ':' . $p['versionId'] . ':' . substr( $p['contentSha'], 0, 16 );
		if ( ! isset( $p['marker'] ) || $expected_marker !== $p['marker'] ) {
			return self::refuse( 'r72_bad_payload', 'The version marker does not match this article version. Nothing was changed.', 400 );
		}
		if ( ! isset( $p['slug'] ) || ! is_string( $p['slug'] ) || ! preg_match( self::SLUG, $p['slug'] ) || strlen( $p['slug'] ) > 190 ) {
			return self::refuse( 'r72_bad_payload', 'Missing or invalid slug. Nothing was changed.', 400 );
		}
		foreach ( array( 'title', 'articleHtml', 'publishedAt' ) as $k ) {
			if ( ! isset( $p[ $k ] ) || ! is_string( $p[ $k ] ) || '' === trim( $p[ $k ] ) ) {
				return self::refuse( 'r72_bad_payload', 'Missing ' . $k . '. Nothing was changed.', 400 );
			}
		}
		if ( false === strtotime( $p['publishedAt'] ) ) {
			return self::refuse( 'r72_bad_payload', 'Invalid publishedAt. Nothing was changed.', 400 );
		}
		if ( ! isset( $p['contractVersion'] ) || 2 !== $p['contractVersion'] || ! isset( $p['target'] ) || ! is_array( $p['target'] ) ) {
			return self::refuse( 'r72_target_required', 'WordPress publishing requires a reviewed v2 website target. Nothing was changed.', 409 );
		}
		if ( ! isset( $p['wordpress'] ) || ! is_array( $p['wordpress'] ) || ( $p['wordpress']['protocol'] ?? '' ) !== R72PUB_PROTOCOL ) {
			return self::refuse( 'r72_protocol', 'Unsupported Relaunch72 WordPress protocol. Update the plugin or the Relaunch72 service. Nothing was changed.', 409 );
		}
		return $p;
	}

	/** @return true|WP_Error */
	public static function check_target( array $p ) {
		$caps = R72Pub_Capabilities::capabilities();
		if ( ! $caps ) {
			return self::refuse( 'r72_unsupported_site', 'This site\'s configuration is not currently supported (see Settings → Relaunch72 Publisher → Capabilities). Nothing was changed.', 409 );
		}
		$t    = $p['target'];
		$root = $caps['roots'][0];
		if ( ( $t['siteId'] ?? '' ) !== $caps['siteId'] ) {
			return self::refuse( 'r72_other_site', 'This article was reviewed for a different website. Nothing was changed.', 403 );
		}
		if ( ( $t['capabilitiesSha'] ?? '' ) !== $caps['capabilitiesSha'] || ( $t['rootId'] ?? '' ) !== $root['id'] || ( $t['indexUrl'] ?? '' ) !== $root['indexUrl'] ) {
			return self::refuse( 'r72_capabilities_changed', 'This site\'s permalinks, posts page, categories setting or sitemap changed since the article target was reviewed. Re-check the connection in Relaunch72 and review the target. Nothing was changed.', 409 );
		}
		$canonical = str_replace( '{slug}', $p['slug'], $root['articleUrlPattern'] );
		if ( ( $t['canonicalUrl'] ?? '' ) !== $canonical || ( $p['canonicalUrl'] ?? '' ) !== $canonical ) {
			return self::refuse( 'r72_canonical', 'The reviewed canonical URL does not match this site\'s permalink for the slug. Nothing was changed.', 409 );
		}
		$ids = isset( $t['categoryIds'] ) && is_array( $t['categoryIds'] ) ? $t['categoryIds'] : array();
		if ( count( $ids ) > $caps['taxonomy']['maxCategoriesPerArticle'] ) {
			return self::refuse( 'r72_categories', 'Too many categories for this site\'s limit. Nothing was changed.', 409 );
		}
		return true;
	}

	/** Resolve (and if allowed, create) top-level categories for the target's selected IDs. @return int[]|WP_Error */
	public static function resolve_categories( array $target, $dry_run ) {
		$selected = array();
		$catalog  = isset( $target['categories'] ) && is_array( $target['categories'] ) ? $target['categories'] : array();
		foreach ( (array) ( $target['categoryIds'] ?? array() ) as $id ) {
			foreach ( $catalog as $c ) {
				if ( is_array( $c ) && ( $c['id'] ?? null ) === $id ) {
					$selected[] = $c;
				}
			}
		}
		$out      = array();
		$settings = R72Pub_Settings::get();
		foreach ( $selected as $c ) {
			$slug = (string) ( $c['slug'] ?? '' );
			if ( ! preg_match( self::SLUG, $slug ) ) {
				return self::refuse( 'r72_categories', 'Invalid category slug. Nothing was changed.', 409 );
			}
			$term = get_term_by( 'slug', $slug, 'category' );
			if ( $term ) {
				if ( 0 !== (int) $term->parent ) {
					return self::refuse( 'r72_categories', 'Category "' . $slug . '" is a child category; its archive URL does not match the reviewed address. Use a top-level category. Nothing was changed.', 409 );
				}
				$out[] = (int) $term->term_id;
				continue;
			}
			if ( ! $settings['create_categories'] ) {
				return self::refuse( 'r72_categories', 'Category "' . $slug . '" does not exist and this site does not allow Relaunch72 to create categories. Create it in WordPress or allow creation. Nothing was changed.', 409 );
			}
			if ( $dry_run ) {
				continue;
			}
			$created = wp_insert_term( sanitize_text_field( (string) ( $c['label'] ?? $slug ) ), 'category', array( 'slug' => $slug ) );
			if ( is_wp_error( $created ) ) {
				return self::refuse( 'r72_categories', 'Category "' . $slug . '" could not be created. Nothing was published.', 409 );
			}
			update_term_meta( (int) $created['term_id'], '_r72_created', 1 );
			$out[] = (int) $created['term_id'];
		}
		return $out;
	}

	/**
	 * @return array{code:int,body:array}|WP_Error
	 */
	public static function publish( $raw ) {
		$p = self::validate( $raw );
		if ( is_wp_error( $p ) ) {
			return $p;
		}
		if ( R72Pub_Settings::paused() ) {
			return self::refuse( 'r72_paused', 'Incoming writes are paused on this WordPress site. Nothing was changed; status checks remain available.', 409, array( 'status' => 'paused' ) );
		}
		$paired = R72Pub_Settings::assert_paired( $p['wordpress']['brandId'] ?? '', $p['wordpress']['destinationId'] ?? '' );
		if ( is_wp_error( $paired ) ) {
			return $paired;
		}
		$seo = R72Pub_Seo::status();
		if ( 'hold' === $seo['mode'] ) {
			return self::refuse( 'r72_seo_hold', $seo['message'] . ' Nothing was changed.', 409 );
		}
		$ok = self::check_target( $p );
		if ( is_wp_error( $ok ) ) {
			return $ok;
		}
		$lock = R72Pub_Lock::acquire( 'article:' . strtolower( $p['articleId'] ) );
		if ( ! $lock ) {
			return self::refuse( 'r72_busy', 'Another delivery of this article is in progress. Reconcile with a status check before retrying.', 503 );
		}
		try {
			return self::publish_locked( $p, $raw, $seo );
		} finally {
			R72Pub_Lock::release( $lock );
		}
	}

	private static function publish_locked( array $p, $raw, array $seo ) {
		$settings  = R72Pub_Settings::get();
		$author    = $settings['author_id'];
		$canonical = $p['target']['canonicalUrl'];
		wp_set_current_user( $author );
		if ( ! current_user_can( 'publish_posts' ) || ! current_user_can( 'upload_files' ) ) {
			return self::refuse( 'r72_author', 'The configured publishing user cannot publish posts and upload files. Nothing was changed.', 409 );
		}
		$article_id = strtolower( $p['articleId'] );
		$post_id    = self::find_managed( $article_id );
		$resume     = false;
		if ( $post_id ) {
			$existing_version = (string) get_post_meta( $post_id, self::META_VERSION, true );
			$existing_number  = (int) get_post_meta( $post_id, self::META_NUMBER, true );
			$state            = (string) get_post_meta( $post_id, self::META_STATE, true );
			$status           = get_post_status( $post_id );
			if ( get_post_meta( $post_id, self::META_DETACHED, true ) ) {
				return self::refuse( 'r72_detached', 'An administrator detached this post from Relaunch72. Nothing was changed.', 409 );
			}
			if ( $existing_number > $p['versionNumber'] ) {
				return self::refuse( 'r72_superseded', 'WordPress already has a newer version of this article. Nothing was overwritten.', 409, array( 'status' => 'superseded' ) );
			}
			if ( $existing_number === $p['versionNumber'] && strtolower( $existing_version ) !== strtolower( $p['versionId'] ) ) {
				return self::refuse( 'r72_version_conflict', 'A different version with the same number is already stored. Nothing was changed.', 409 );
			}
			if ( strtolower( $existing_version ) === strtolower( $p['versionId'] ) && 'published' === $state ) {
				if ( 'publish' !== $status ) {
					return self::refuse( 'r72_manual_status', 'This version was delivered, but the post is no longer published in WordPress (a person changed its status). Nothing was changed.', 409 );
				}
				return array( 'code' => 200, 'body' => array( 'status' => 'already_present', 'ref' => self::ref( $post_id, $p['versionId'] ), 'postId' => $post_id ) );
			}
			$resume = 'writing' === $state && 'publish' !== $status;
			if ( ! $resume ) {
				if ( 'publish' !== $status ) {
					return self::refuse( 'r72_manual_status', 'A person unpublished, scheduled or trashed this post in WordPress. Relaunch72 will not republish it. Nothing was changed.', 409 );
				}
				if ( self::manually_edited( $post_id ) && ! get_post_meta( $post_id, self::META_ALLOW, true ) ) {
					return self::refuse( 'r72_manual_edit', 'This post was edited in WordPress after Relaunch72 last wrote it. Nothing was overwritten. In WordPress, either keep the edit (and stop updates for this post) or choose "Allow next Relaunch72 update" on the managed posts screen.', 409 );
				}
				if ( get_post_field( 'post_name', $post_id ) !== $p['slug'] || get_permalink( $post_id ) !== $canonical || (string) get_post_meta( $post_id, self::META_CANONICAL, true ) !== $canonical ) {
					return self::refuse( 'r72_canonical_changed', 'The published URL of this post changed in WordPress. Relaunch72 keeps published URLs fixed. Nothing was changed.', 409 );
				}
			}
		} else {
			$collision = get_page_by_path( $p['slug'], OBJECT, array( 'post', 'page' ) );
			if ( $collision || self::slug_used( $p['slug'] ) ) {
				return self::refuse( 'r72_slug_taken', 'WordPress already has a post or page that Relaunch72 did not create using the slug "' . $p['slug'] . '". It was not changed or adopted.', 409 );
			}
		}

		// Dry-run category resolution so a missing/forbidden category refuses before any write.
		$cats = self::resolve_categories( $p['target'], true );
		if ( is_wp_error( $cats ) ) {
			return $cats;
		}

		$image_id  = 0;
		$image_url = '';
		if ( isset( $p['image'] ) && is_array( $p['image'] ) && ! empty( $p['image']['url'] ) ) {
			$alt = isset( $p['image']['alt'] ) && is_string( $p['image']['alt'] ) ? $p['image']['alt'] : '';
			if ( '' === trim( $alt ) ) {
				return self::refuse( 'r72_media_alt', 'The featured image needs alt text. Nothing was changed.', 409 );
			}
			$image_id = R72Pub_Media::import( $p['image']['url'], $alt, $article_id, $post_id );
			if ( is_wp_error( $image_id ) ) {
				return $image_id;
			}
			$image_url = (string) wp_get_attachment_url( $image_id );
		}

		$cats = self::resolve_categories( $p['target'], false );
		if ( is_wp_error( $cats ) ) {
			return $cats;
		}

		$content = wp_kses_post( $p['articleHtml'] );
		$fields  = array(
			'post_type'      => 'post',
			'post_title'     => sanitize_text_field( $p['title'] ),
			'post_content'   => $content,
			'post_excerpt'   => sanitize_textarea_field( (string) ( $p['excerpt'] ?? '' ) ),
			'post_name'      => $p['slug'],
			'post_author'    => $author,
			'post_category'  => $cats,
			'comment_status' => get_default_comment_status( 'post' ),
		);
		$created = false;
		if ( ! $post_id ) {
			$gmt                       = gmdate( 'Y-m-d H:i:s', min( time(), strtotime( $p['publishedAt'] ) ) );
			$fields['post_status']     = 'draft';
			$fields['post_date_gmt']   = $gmt;
			$fields['post_date']       = get_date_from_gmt( $gmt );
			$fields['edit_date']       = true;
			$post_id                   = wp_insert_post( wp_slash( $fields ), true );
			if ( is_wp_error( $post_id ) ) {
				return self::refuse( 'r72_insert', 'WordPress refused to create the post. Nothing was published.', 409 );
			}
			$created = true;
			add_post_meta( $post_id, self::META_ARTICLE, $article_id, true );
			add_post_meta( $post_id, self::META_BRAND, strtolower( (string) $p['wordpress']['brandId'] ), true );
		} else {
			$fields['ID'] = $post_id;
			if ( $resume ) {
				$fields['post_status'] = 'draft';
			}
			$updated = wp_update_post( wp_slash( $fields ), true );
			if ( is_wp_error( $updated ) ) {
				return self::refuse( 'r72_update', 'WordPress refused to update the post. Nothing was overwritten.', 409 );
			}
		}
		update_post_meta( $post_id, self::META_STATE, 'writing' );
		update_post_meta( $post_id, self::META_VERSION, strtolower( $p['versionId'] ) );
		update_post_meta( $post_id, self::META_NUMBER, $p['versionNumber'] );
		update_post_meta( $post_id, self::META_CONTENT, $p['contentSha'] );
		update_post_meta( $post_id, self::META_MARKER, $p['marker'] );
		update_post_meta( $post_id, self::META_CANONICAL, esc_url_raw( $canonical ) );
		update_post_meta( $post_id, self::META_TARGET, wp_slash( wp_json_encode( $p['target'] ) ) );
		update_post_meta( $post_id, self::META_PAYLOAD, hash( 'sha256', $raw ) );
		update_post_meta( $post_id, self::META_OPERATION, strtolower( $p['operationId'] ) );
		if ( $image_id ) {
			set_post_thumbnail( $post_id, $image_id );
			wp_update_post( array( 'ID' => $image_id, 'post_parent' => $post_id ) );
		} else {
			delete_post_thumbnail( $post_id );
		}
		$seo_result = array( 'mode' => $seo['mode'], 'written' => array(), 'preserved' => array() );
		if ( 'content_only' !== $seo['mode'] ) {
			$seo_result = R72Pub_Seo::apply( $post_id, R72Pub_Seo::intent_from_payload( $p, $canonical ), $image_id, $image_url );
		}

		if ( 'publish' !== get_post_status( $post_id ) ) {
			wp_update_post( array( 'ID' => $post_id, 'post_status' => 'publish' ) );
		}
		clean_post_cache( $post_id );
		if ( get_post_field( 'post_name', $post_id ) !== $p['slug'] || get_permalink( $post_id ) !== $canonical ) {
			// WordPress changed the address (for example a unique-slug suffix). Never leave a wrong URL public.
			if ( $created ) {
				wp_delete_post( $post_id, true );
			} else {
				wp_update_post( array( 'ID' => $post_id, 'post_status' => 'draft' ) );
			}
			return self::refuse( 'r72_permalink_mismatch', 'WordPress did not serve this post at the reviewed URL, so it was not left published.', 409 );
		}
		update_post_meta( $post_id, self::META_STATE, 'published' );
		update_post_meta( $post_id, self::META_HASH, self::surface_hash( $post_id ) );
		update_post_meta( $post_id, self::META_WRITTEN_AT, gmdate( 'c' ) );
		delete_post_meta( $post_id, self::META_ALLOW );
		R72Pub_Settings::audit( 'article.delivered', 'Delivered article ' . $article_id . ' version ' . $p['versionNumber'] . ' to post ' . $post_id . '.' );
		return array(
			'code' => $created || $resume ? 201 : 200,
			'body' => array(
				'status' => 'published',
				'ref'    => self::ref( $post_id, $p['versionId'] ),
				'postId' => $post_id,
				'seo'    => $seo_result,
			),
		);
	}

	private static function slug_used( $slug ) {
		global $wpdb;
		$found = $wpdb->get_var( $wpdb->prepare( "SELECT ID FROM {$wpdb->posts} WHERE post_name = %s AND post_type IN ('post','page') LIMIT 1", $slug ) );
		return null !== $found;
	}

	public static function ref( $post_id, $version_id ) {
		return 'wp-post:' . (int) $post_id . ':' . strtolower( $version_id );
	}

	/** Read-only reconciliation. Available while writes are paused. */
	public static function status( $article_id, $version_id ) {
		if ( ! preg_match( self::UUID, (string) $article_id ) || ! preg_match( self::UUID, (string) $version_id ) ) {
			return self::refuse( 'r72_bad_query', 'article and version must be UUIDs.', 400 );
		}
		$article_id = strtolower( $article_id );
		if ( R72Pub_Lock::is_held( 'article:' . $article_id ) ) {
			return self::refuse( 'r72_busy', 'A delivery of this article is in progress; its outcome is not known yet.', 503 );
		}
		$post_id = self::find_managed( $article_id );
		if ( ! $post_id ) {
			return array( 'code' => 200, 'body' => array( 'state' => 'absent' ) );
		}
		$stored  = strtolower( (string) get_post_meta( $post_id, self::META_VERSION, true ) );
		$state   = (string) get_post_meta( $post_id, self::META_STATE, true );
		$status  = get_post_status( $post_id );
		$target  = json_decode( (string) get_post_meta( $post_id, self::META_TARGET, true ), true );
		$common  = array(
			'ref'             => self::ref( $post_id, $stored ),
			'canonicalUrl'    => (string) get_post_meta( $post_id, self::META_CANONICAL, true ),
			'contractVersion' => 2,
			'target'          => is_array( $target ) ? $target : null,
			'payloadSha'      => (string) get_post_meta( $post_id, self::META_PAYLOAD, true ),
			'versionNumber'   => (int) get_post_meta( $post_id, self::META_NUMBER, true ),
			'wordpress'       => array(
				'postId'       => $post_id,
				'postStatus'   => $status,
				'manualEdit'   => 'published' === $state && self::manually_edited( $post_id ),
				'detached'     => (bool) get_post_meta( $post_id, self::META_DETACHED, true ),
			),
		);
		if ( 'published' !== $state ) {
			// An interrupted first write left an unpublished draft: not delivered; a resend resumes it.
			return array( 'code' => 200, 'body' => array( 'state' => 'absent' ) + $common );
		}
		$present = $stored === strtolower( $version_id ) && 'publish' === $status && ! $common['wordpress']['detached'];
		return array( 'code' => 200, 'body' => array( 'state' => $present ? 'present' : 'other_version' ) + $common );
	}

	private static function refuse( $code, $message, $status, array $extra = array() ) {
		return new WP_Error( $code, $message, array( 'status' => $status ) + $extra );
	}
}
